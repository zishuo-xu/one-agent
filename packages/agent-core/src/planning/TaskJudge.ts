import { z } from 'zod';
import { config } from '../config.js';
import { JudgeOptions, JudgeResult, Plan, ReasoningStep } from './types.js';
import { extractJsonObject } from './extractJson.js';

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
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxReplanAttempts: number;
  private readonly maxRetryAttempts: number;
  private replanAttempts = 0;
  private retryAttempts = 0;

  constructor(options: JudgeOptions = {}) {
    this.systemPrompt =
      options.systemPrompt ??
      'You are a task judge. Given a plan and the execution history, decide whether the task is complete, ' +
      'and what the next action should be. Respond ONLY with a JSON object.';
    this.model = options.model ?? config.model;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxReplanAttempts = options.maxReplanAttempts ?? 3;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 2;
  }

  async judge(plan: Plan, steps: ReasoningStep[]): Promise<JudgeResult> {
    const prompt = this.buildPrompt(plan, steps);

    try {
      const response = await config.openai.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
        },
        { timeout: this.timeoutMs }
      );

      const raw = response.choices[0]?.message?.content ?? '{}';
      return this.parseResult(raw);
    } catch (error) {
      return {
        complete: false,
        reasoning: `Judge failed: ${error instanceof Error ? error.message : String(error)}`,
        nextAction: 'continue',
      };
    }
  }

  reset(): void {
    this.replanAttempts = 0;
    this.retryAttempts = 0;
  }

  canReplan(): boolean {
    return this.replanAttempts < this.maxReplanAttempts;
  }

  canRetry(): boolean {
    return this.retryAttempts < this.maxRetryAttempts;
  }

  recordReplan(): void {
    this.replanAttempts++;
  }

  recordRetry(): void {
    this.retryAttempts++;
  }

  private buildPrompt(plan: Plan, steps: ReasoningStep[]): string {
    const planText = plan.steps
      .map((step) => `${step.id}. ${step.description} (${step.status})`)
      .join('\n');

    const historyText = steps
      .map((step, index) => {
        const parts: string[] = [];
        if (step.thought) parts.push(`Thought: ${step.thought}`);
        if (step.action) parts.push(`Action: ${step.action.name}(${JSON.stringify(step.action.arguments)})`);
        if (step.observation) parts.push(`Observation: ${JSON.stringify(step.observation)}`);
        if (step.reflection) parts.push(`Reflection: ${step.reflection}`);
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
