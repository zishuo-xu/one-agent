import fs from 'node:fs';
import path from 'node:path';
import { AgentLoop } from '../agents/AgentLoop.js';
import { AgentLoopEvent } from '../agents/AgentLoop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Sandbox } from '../tools/sandbox.js';
import { createBuiltInTools } from '../tools/built-in/index.js';
import { ToolCall } from '../tools/types.js';
import {
  EvalRunSummary,
  EvalResult,
  EvalTask,
  EvalRunnerOptions,
} from './types.js';
import {
  assertFinalAnswer,
  assertNoToolCalled,
  assertToolEventuallyCalled,
  assertPlanEventContains,
  extractToolCalls,
} from './assertions.js';
import { Plan } from '../planning/types.js';
import { config } from '../config.js';
import type { MockChatCompletionResponse } from './types.js';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

export class EvalRunner {
  async run(options: EvalRunnerOptions): Promise<EvalRunSummary> {
    const results: EvalResult[] = [];

    for (const task of options.tasks) {
      const start = Date.now();
      const errors: string[] = [];
      const events: AgentLoopEvent[] = [];
      let reply = '';

      const sandbox = new Sandbox(options.workspaceRoot);

      // Seed initial workspace files if provided.
      if (task.initialWorkspace) {
        for (const [relativePath, content] of Object.entries(task.initialWorkspace)) {
          const fullPath = sandbox.resolve(relativePath);
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(fullPath, content, 'utf-8');
        }
      }

      const tools = new ToolRegistry();
      tools.registerMany(createBuiltInTools(sandbox));

      let originalCreate: typeof config.openai.chat.completions.create | undefined;
      if (options.mode === 'mock') {
        if (!task.mockResponses || task.mockResponses.length === 0) {
          throw new Error(
            `Task ${task.id} is missing mockResponses required for mock evaluation mode.`
          );
        }
        originalCreate = config.openai.chat.completions.create;
        config.openai.chat.completions.create = buildMockCreate(
          task.mockResponses
        ) as unknown as typeof config.openai.chat.completions.create;
      }

      const agent = new AgentLoop({
        tools,
        enablePlanning: task.enablePlanning ?? options.enablePlanning ?? false,
      });

      agent.on('event', (event: AgentLoopEvent) => {
        events.push(event);
      });

      try {
        const timeoutMs = task.timeoutMs ?? options.defaultTimeoutMs ?? 60000;
        const run = await withTimeout(
          agent.chat(task.prompt),
          timeoutMs,
          `Task ${task.id}`
        );
        reply = run.reply;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        // Always restore the real model client so subsequent tasks or tests are not affected.
        if (originalCreate) {
          config.openai.chat.completions.create = originalCreate;
          originalCreate = undefined;
        }
      }

      const toolCalls = extractToolCalls(events);
      const planEvents = events.filter(
        (e): e is { type: 'plan'; plan: Plan } => e.type === 'plan'
      );

      // Exact-order tool calls (for deterministic regression)
      if (task.expectedTools) {
        for (let i = 0; i < task.expectedTools.length; i++) {
          const expected = task.expectedTools[i];
          const actual = toolCalls[i];
          if (!actual) {
            errors.push(`Missing expected tool call #${i + 1}: ${expected.name}`);
            continue;
          }
          if (actual.name !== expected.name) {
            errors.push(`Expected tool #${i + 1} to be ${expected.name}, got ${actual.name}`);
          }
          if (expected.arguments && JSON.stringify(actual.arguments) !== JSON.stringify(expected.arguments)) {
            errors.push(`Tool ${expected.name} (#${i + 1}) arguments mismatch`);
          }
        }
      }

      // Required tools (may appear in any order; more forgiving for real models)
      if (task.requiredTools) {
        for (const expected of task.requiredTools) {
          const callError = assertToolEventuallyCalled(toolCalls, expected.name, expected.arguments);
          if (callError) {
            errors.push(callError);
          }
        }
      }

      // Forbidden tools
      if (task.forbiddenTools) {
        for (const name of task.forbiddenTools) {
          const forbiddenError = assertNoToolCalled(toolCalls, name);
          if (forbiddenError) {
            errors.push(forbiddenError);
          }
        }
      }

      // Final answer checks
      if (task.finalAnswerContains) {
        const answerError = assertFinalAnswer(reply, task.finalAnswerContains);
        if (answerError) {
          errors.push(answerError);
        }
      }

      // Post-run file checks
      if (task.expectedFiles) {
        for (const expected of task.expectedFiles) {
          const fullPath = sandbox.resolve(expected.path);
          if (!fs.existsSync(fullPath)) {
            errors.push(`Expected file ${expected.path} to exist, but it does not`);
            continue;
          }
          if (expected.contains) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (!content.toLowerCase().includes(expected.contains.toLowerCase())) {
              errors.push(`File ${expected.path} missing content: ${expected.contains}`);
            }
          }
        }
      }

      results.push({
        taskId: task.id,
        passed: errors.length === 0,
        reply,
        events,
        toolCalls,
        errors,
        durationMs: Date.now() - start,
        planningMetrics: {
          planCount: planEvents.length,
          replanCount: Math.max(0, planEvents.length - 1),
          retryCount: 0,
          planStepCount: planEvents.reduce((sum, event) => sum + countPlanSteps(event.plan), 0),
        },
        reflectionCount: events.filter((e) => e.type === 'reflection').length,
      });
    }

    return {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
    };
  }
}

function buildMockCreate(responses: MockChatCompletionResponse[]) {
  let index = 0;
  return async function mockCreate(_params: unknown, _options?: unknown) {
    if (index >= responses.length) {
      throw new Error(
        `Mock model exhausted at response index ${index}; add more mockResponses to the eval task.`
      );
    }
    return responses[index++] as unknown;
  };
}

function countPlanSteps(plan: Plan): number {
  let count = 0;
  const visit = (step: Plan['steps'][number]) => {
    count++;
    if (step.children) {
      for (const child of step.children) {
        visit(child);
      }
    }
  };
  for (const step of plan.steps) {
    visit(step);
  }
  return count;
}
