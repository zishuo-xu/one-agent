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
  EvalCheckpointResult,
  EvalFileExpectation,
  EvalToolExpectation,
} from './types.js';
import {
  assertFinalAnswer,
  assertFinalAnswerContainsAll,
  assertFinalAnswerNotContains,
  assertNoToolCalled,
  assertToolEventuallyCalled,
  assertPlanEventContains,
  extractToolCalls,
} from './assertions.js';
import { Plan } from '../planning/types.js';
import { config } from '../config.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import { MockProvider } from '../model/MockProvider.js';
import { createConnection } from '../db/connection.js';
import { ThreadStore } from '../db/threadStore.js';
import type Database from 'better-sqlite3';
import type { MockChatCompletionResponse } from './types.js';
import { EvidenceCompletionVerifier } from '../verification/EvidenceCompletionVerifier.js';
import type { CompletionRequirement } from '../verification/types.js';

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Map with a fixed worker pool while preserving the input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Eval concurrency must be a positive integer, got ${concurrency}`);
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export class EvalRunner {
  async run(options: EvalRunnerOptions): Promise<EvalRunSummary> {
    // Optional trace persistence: each task runs in its own thread so failed
    // evals can be inspected in trace-web afterwards.
    const traceDb = options.traceDbPath
      ? createConnection({ path: options.traceDbPath })
      : undefined;
    try {
      return await this.runTasks(options, traceDb);
    } finally {
      traceDb?.close();
    }
  }

  private async runTasks(
    options: EvalRunnerOptions,
    traceDb?: Database.Database,
  ): Promise<EvalRunSummary> {
    const threadStore = traceDb ? new ThreadStore(traceDb) : undefined;
    const concurrency = options.concurrency ?? 1;

    const results = await mapWithConcurrency(options.tasks, concurrency, async (task) => {
      const start = Date.now();
      const errors: string[] = [];
      const events: AgentLoopEvent[] = [];
      let reply = '';
      let completionOutcome: EvalResult['completionOutcome'];

      // Each task runs in its own workspace directory so files left behind by
      // one task (deleted logs, moved files, generated reports) never leak
      // into the next task's view.
      const taskWorkspace = path.join(options.workspaceRoot, sanitizePathSegment(task.id));
      fs.rmSync(taskWorkspace, { recursive: true, force: true });
      const sandbox = new Sandbox(taskWorkspace);

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

      if (options.mode === 'mock' && (!task.mockResponses || task.mockResponses.length === 0)) {
        throw new Error(
          `Task ${task.id} is missing mockResponses required for mock evaluation mode.`
        );
      }

      // Persist this task's run in its own thread when tracing.
      const threadId = threadStore?.create({ title: `eval: ${task.name}` }).id;

      const agent = new AgentLoop({
        tools,
        enablePlanning: task.enablePlanning ?? options.enablePlanning ?? false,
        // Mock mode replays deterministic responses through an injected
        // provider — no global monkey-patching, so eval tasks are isolated
        // and parallel-safe. Real mode pins the primary provider so a
        // configured fallback chain never re-routes traffic ("Mock model
        // exhausted" must surface as an error, not a silent switch).
        modelProvider:
          options.mode === 'mock'
            ? new MockProvider(task.mockResponses!)
            : new OpenAICompatibleProvider(config.openai, config.model),
        ...(threadId && traceDb ? { threadId, db: traceDb } : {}),
      });
      const completionVerifier = new EvidenceCompletionVerifier({
        sandbox,
        requirements: buildCompletionRequirements(task),
      });

      agent.on('event', (event: AgentLoopEvent) => {
        events.push(event);
      });

      let tokenUsage: EvalResult['tokenUsage'] | undefined;
      let runId: string | undefined;
      try {
        const timeoutMs = task.timeoutMs ?? options.defaultTimeoutMs ?? 60000;
        const run = await withTimeout(
          agent.chat(task.prompt),
          timeoutMs,
          `Task ${task.id}`
        );
        reply = run.reply;
        completionOutcome = await completionVerifier.verify({
          request: task.prompt,
          reply: run.reply,
          events: run.events,
        });
        tokenUsage = run.tokenUsage;
        runId = run.runId;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      // Inverted-outcome tasks: the run is SUPPOSED to fail. Whether it did
      // or not, no further assertions apply.
      let skipAssertions = false;
      if (task.expectedOutcome === 'failure') {
        if (errors.length > 0) {
          errors.length = 0;
        } else {
          errors.push('Expected the run to fail, but it completed without errors');
        }
        skipAssertions = true;
      }

      const toolCalls = extractToolCalls(events);
      const planEvents = events.filter(
        (e): e is { type: 'plan'; plan: Plan } => e.type === 'plan'
      );

      // Exact-order tool calls (for deterministic regression)
      if (!skipAssertions) {
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

        // Required/forbidden tools (any order; more forgiving for real models)
        errors.push(...checkToolExpectations(toolCalls, task.requiredTools, task.forbiddenTools));

        // Final answer checks
        errors.push(...checkAnswerExpectations(reply, task));

        // Post-run file checks
        errors.push(...checkFileExpectations(sandbox, task.expectedFiles, task.forbiddenFiles));
      }

      // Weighted checkpoints: each earns its points only when every one of its
      // assertions passes, so long-horizon tasks get partial credit instead of
      // an all-or-nothing verdict.
      let score: number | undefined;
      let maxScore: number | undefined;
      let checkpointResults: EvalCheckpointResult[] | undefined;
      if (!skipAssertions) {
        if (task.checkpoints) {
          score = 0;
          maxScore = 0;
          checkpointResults = [];
          for (const checkpoint of task.checkpoints) {
            const checkpointErrors = [
              ...checkToolExpectations(toolCalls, checkpoint.requiredTools, checkpoint.forbiddenTools),
              ...checkAnswerExpectations(reply, checkpoint),
              ...checkFileExpectations(sandbox, checkpoint.expectedFiles, checkpoint.forbiddenFiles),
            ];
            const earned = checkpointErrors.length === 0 ? checkpoint.points : 0;
            score += earned;
            maxScore += checkpoint.points;
            checkpointResults.push({
              id: checkpoint.id,
              description: checkpoint.description,
              earned,
              points: checkpoint.points,
              errors: checkpointErrors,
            });
          }
        }

      }

      const passed = errors.length === 0 && (maxScore === undefined || score === maxScore);

      // Label the eval-owned thread for navigation, but never rewrite the
      // runtime run status: execution facts and offline evaluation results
      // are separate dimensions.
      if (threadStore && threadId) {
        threadStore.updateTitle(threadId, `${passed ? '[PASS]' : '[FAIL]'} eval: ${task.name}`);
      }

      return {
        taskId: task.id,
        passed,
        reply,
        events,
        toolCalls,
        errors,
        durationMs: Date.now() - start,
        tokenUsage,
        planningMetrics: {
          planCount: planEvents.length,
          replanCount: Math.max(0, planEvents.length - 1),
          retryCount: agent.getReasoningChain().getSteps().filter((step) => step.failureAnalysis).length,
          planStepCount: planEvents.reduce((sum, event) => sum + countPlanSteps(event.plan), 0),
        },
        reflectionCount: events.filter((e) => e.type === 'reflection').length,
        completionOutcome,
        score,
        maxScore,
        checkpointResults,
        runId,
        threadId,
      } satisfies EvalResult;
    });

    const scored = results.filter((r) => r.maxScore !== undefined);
    return {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
      ...(scored.length > 0
        ? {
            totalScore: scored.reduce((sum, r) => sum + (r.score ?? 0), 0),
            totalMaxScore: scored.reduce((sum, r) => sum + (r.maxScore ?? 0), 0),
          }
        : {}),
    };
  }
}

function sanitizePathSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function checkAnswerExpectations(
  reply: string,
  expectations: {
    finalAnswerContains?: string[];
    finalAnswerContainsAll?: string[];
    finalAnswerNotContains?: string[];
  },
): string[] {
  const errors: string[] = [];
  if (expectations.finalAnswerContains) {
    const error = assertFinalAnswer(reply, expectations.finalAnswerContains);
    if (error) {
      errors.push(error);
    }
  }
  if (expectations.finalAnswerContainsAll) {
    const error = assertFinalAnswerContainsAll(reply, expectations.finalAnswerContainsAll);
    if (error) {
      errors.push(error);
    }
  }
  if (expectations.finalAnswerNotContains) {
    const error = assertFinalAnswerNotContains(reply, expectations.finalAnswerNotContains);
    if (error) {
      errors.push(error);
    }
  }
  return errors;
}

function checkToolExpectations(
  toolCalls: ToolCall[],
  requiredTools?: EvalToolExpectation[],
  forbiddenTools?: string[],
): string[] {
  const errors: string[] = [];
  for (const expected of requiredTools ?? []) {
    const error = assertToolEventuallyCalled(toolCalls, expected.name, expected.arguments);
    if (error) {
      errors.push(error);
    }
  }
  for (const name of forbiddenTools ?? []) {
    const error = assertNoToolCalled(toolCalls, name);
    if (error) {
      errors.push(error);
    }
  }
  return errors;
}

function checkFileExpectations(
  sandbox: Sandbox,
  expectedFiles?: EvalFileExpectation[],
  forbiddenFiles?: string[],
): string[] {
  const errors: string[] = [];
  for (const expected of expectedFiles ?? []) {
    const fullPath = sandbox.resolve(expected.path);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Expected file ${expected.path} to exist, but it does not`);
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf-8').toLowerCase();
    const required = [
      ...(expected.contains ? [expected.contains] : []),
      ...(expected.containsAll ?? []),
    ];
    for (const phrase of required) {
      if (!content.includes(phrase.toLowerCase())) {
        errors.push(`File ${expected.path} missing content: ${phrase}`);
      }
    }
    for (const phrase of expected.notContains ?? []) {
      if (content.includes(phrase.toLowerCase())) {
        errors.push(`File ${expected.path} should not contain: ${phrase}`);
      }
    }
  }
  for (const relativePath of forbiddenFiles ?? []) {
    if (fs.existsSync(sandbox.resolve(relativePath))) {
      errors.push(`File ${relativePath} should not exist, but it does`);
    }
  }
  return errors;
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

function buildCompletionRequirements(task: EvalTask): CompletionRequirement[] {
  const requirements: CompletionRequirement[] = [];
  const addExpectations = (expectations: {
    expectedFiles?: EvalFileExpectation[];
    forbiddenFiles?: string[];
    finalAnswerContains?: string[];
    finalAnswerContainsAll?: string[];
    finalAnswerNotContains?: string[];
  }) => {
    for (const file of expectations.expectedFiles ?? []) {
      requirements.push({
        kind: 'artifact',
        path: file.path,
        containsAll: [
          ...(file.contains ? [file.contains] : []),
          ...(file.containsAll ?? []),
        ],
        notContains: file.notContains,
      });
    }
    for (const path of expectations.forbiddenFiles ?? []) {
      requirements.push({ kind: 'artifact', path, shouldExist: false });
    }
    if (
      expectations.finalAnswerContains?.length ||
      expectations.finalAnswerContainsAll?.length ||
      expectations.finalAnswerNotContains?.length
    ) {
      requirements.push({
        kind: 'response',
        containsAny: expectations.finalAnswerContains,
        containsAll: expectations.finalAnswerContainsAll,
        notContains: expectations.finalAnswerNotContains,
      });
    }
  };

  addExpectations(task);
  for (const checkpoint of task.checkpoints ?? []) addExpectations(checkpoint);
  return requirements;
}
