import { z } from 'zod';
import { config } from '../config.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelProvider, TokenUsage } from '../model/types.js';
import { JudgeOptions, JudgeResult, Plan, ReasoningStep } from './types.js';
import { extractJsonObject } from './extractJson.js';

/** Cap for any single field serialized into the judge prompt. */
const MAX_JUDGE_FIELD_CHARS = 800;

function truncateForJudge(text: string): string {
  return text.length > MAX_JUDGE_FIELD_CHARS
    ? `${text.slice(0, MAX_JUDGE_FIELD_CHARS)}…[truncated]`
    : text;
}

const failureAnalysisSchema = z.object({
  category: z.enum(['tool_failure', 'plan_mismatch', 'missing_info', 'wrong_args', 'other']),
  affectedStepIds: z.array(z.string()).optional(),
  rootCause: z.string().optional(),
  recommendation: z.string().optional(),
});

const judgeSchema = z.object({
  complete: z.boolean(),
  reasoning: z.string(),
  nextAction: z.enum(['continue', 'replan', 'retry', 'finalize']),
  failureAnalysis: failureAnalysisSchema.optional(),
});

export class TaskJudge {
  private readonly systemPrompt: string;
  private readonly modelProvider: ModelProvider;
  private readonly timeoutMs: number;
  /** Same usage-sink contract as Planner.onUsage (wired by AgentLoop). */
  onUsage?: (usage: TokenUsage) => void;

  constructor(options: JudgeOptions = {}) {
    this.systemPrompt =
      options.systemPrompt ??
      'You are a task judge. Given a plan and the execution history, decide whether the task is complete, ' +
      'and what the next action should be. Respond ONLY with a JSON object.';
    this.modelProvider =
      options.modelProvider ??
      (options.model
        ? new OpenAICompatibleProvider(config.openai, options.model)
        : config.planningModelProvider ??
          config.modelProvider ??
          new OpenAICompatibleProvider(config.openai, config.model));
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async judge(plan: Plan, steps: ReasoningStep[]): Promise<JudgeResult> {
    const prompt = this.buildPrompt(plan, steps);

    try {
      const response = await this.modelProvider.complete({
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        timeoutMs: this.timeoutMs,
      });
      if (response.usage) {
        this.onUsage?.(response.usage);
      }

      const raw = response.content || '{}';
      return this.parseResult(raw);
    } catch (error) {
      return {
        complete: false,
        reasoning: `Judge failed: ${error instanceof Error ? error.message : String(error)}`,
        nextAction: 'continue',
      };
    }
  }

  private buildPrompt(plan: Plan, steps: ReasoningStep[]): string {
    const planText = plan.steps
      .map((step) => `${step.id}. ${step.description} (${step.status})`)
      .join('\n');

    // Judge calls resend the history every time; cap each field so large
    // tool outputs (e.g. whole file contents) don't make the cost quadratic.
    const historyText = steps
      .map((step, index) => {
        const parts: string[] = [];
        if (step.thought) parts.push(`Thought: ${truncateForJudge(step.thought)}`);
        if (step.action) parts.push(`Action: ${step.action.name}(${truncateForJudge(JSON.stringify(step.action.arguments))})`);
        if (step.observation) parts.push(`Observation: ${truncateForJudge(JSON.stringify(step.observation))}`);
        if (step.reflection) parts.push(`Reflection: ${truncateForJudge(step.reflection)}`);
        return `Step ${index + 1}:\n${parts.join('\n')}`;
      })
      .join('\n\n');

    return [
      'Evaluate the current task progress.',
      '',
      'Plan:',
      planText,
      '',
      'Execution history:',
      historyText || 'No steps executed yet.',
      '',
      'Respond with a JSON object in this exact format:\n' +
        '{\n' +
        '  "complete": true or false,\n' +
        '  "reasoning": "explanation",\n' +
        '  "nextAction": "continue" | "replan" | "retry" | "finalize",\n' +
        '  "failureAnalysis": {\n' +
        '    "category": "tool_failure" | "plan_mismatch" | "missing_info" | "wrong_args" | "other",\n' +
        '    "affectedStepIds": ["step-id"],\n' +
        '    "rootCause": "what went wrong",\n' +
        '    "recommendation": "how to fix it"\n' +
        '  }\n' +
        '}\n\n' +
        'Guidelines:\n' +
        '- complete=true when all plan steps are successfully done and the user request is satisfied.\n' +
        '- The user request is NOT satisfied if its explicitly named final deliverable (e.g. a file it asked to create) was not produced exactly as named; choose replan in that case. Intermediate step results live in the execution history, not in files.\n' +
        '- Do NOT choose replan just to ask the user for input or wait for clarification; when progress is impossible without it, choose finalize and state what is missing.\n' +
        '- nextAction=continue when more steps are needed.\n' +
        '- nextAction=replan when the current plan is not working.\n' +
        '- nextAction=retry when the last action failed but should be retried.\n' +
        '- nextAction=finalize when the task is complete or cannot proceed further; provide a final answer.\n' +
        '- Include failureAnalysis whenever nextAction is replan, retry, or finalize due to a failure.',
    ].join('\n');
  }

  private parseResult(raw: string): JudgeResult {
    const extracted = extractJsonObject(raw);
    if (!extracted) {
      return {
        complete: false,
        reasoning: 'Judge response did not contain a JSON object; continuing execution.',
        nextAction: 'continue',
      };
    }

    try {
      const parsed = JSON.parse(extracted);
      const validated = judgeSchema.parse(parsed);
      return validated;
    } catch {
      return {
        complete: false,
        reasoning: 'Judge response parsing failed; continuing execution.',
        nextAction: 'continue',
      };
    }
  }
}
