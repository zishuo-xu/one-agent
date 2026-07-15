import { ToolCall, ToolResult } from '../tools/types.js';
import type { ModelProvider } from '../model/types.js';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  expectedOutcome?: string;
  status: StepStatus;
  /** If provided, only these tools may be used for this step. */
  allowedTools?: string[];
  /** If provided, the model must use this exact tool for the step. */
  requiredTool?: string;
  /** When true, any tool deviation marks the step as failed. */
  strict?: boolean;
  /** Optional parent step id for hierarchical plans. */
  parentId?: string;
  /** Optional nested substeps. */
  children?: PlanStep[];
}

export interface Plan {
  steps: PlanStep[];
  reasoning: string;
}

export interface FailureAnalysis {
  category: 'tool_failure' | 'plan_mismatch' | 'missing_info' | 'wrong_args' | 'other';
  affectedStepIds?: string[];
  rootCause?: string;
  recommendation?: string;
}

export interface ReasoningStep {
  thought?: string;
  action?: ToolCall;
  observation?: ToolResult;
  reflection?: string;
  /** Links this reasoning step to a plan step. */
  planStepId?: string;
  /** Structured failure analysis when a step fails. */
  failureAnalysis?: FailureAnalysis;
}

export type NextAction = 'continue' | 'replan' | 'retry' | 'finalize';

export interface JudgeResult {
  complete: boolean;
  reasoning: string;
  nextAction: NextAction;
  failureAnalysis?: FailureAnalysis;
}

export interface PlannerOptions {
  systemPrompt?: string;
  model?: string;
  modelProvider?: ModelProvider;
  timeoutMs?: number;
}

export interface JudgeOptions {
  systemPrompt?: string;
  model?: string;
  modelProvider?: ModelProvider;
  timeoutMs?: number;
  maxReplanAttempts?: number;
  maxRetryAttempts?: number;
}
