import { ToolCall, ToolResult } from '../tools/types.js';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  expectedOutcome?: string;
  status: StepStatus;
}

export interface Plan {
  steps: PlanStep[];
  reasoning: string;
}

export interface ReasoningStep {
  thought?: string;
  action?: ToolCall;
  observation?: ToolResult;
  reflection?: string;
}

export type NextAction = 'continue' | 'replan' | 'retry' | 'finalize';

export interface JudgeResult {
  complete: boolean;
  reasoning: string;
  nextAction: NextAction;
}

export interface PlannerOptions {
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
}

export interface JudgeOptions {
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  maxReplanAttempts?: number;
  maxRetryAttempts?: number;
}
