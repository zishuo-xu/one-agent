import { ToolCall, ToolResult } from '../tools/types.js';
import type { ModelProvider } from '../model/types.js';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

export type PlanExecutor = 'main' | 'subagent';

export interface PlanChecklistItem {
  id: string;
  description: string;
}

export interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  expectedOutcome?: string;
  /** Concrete evidence the executor should return where possible. */
  expectedEvidence?: string[];
  /** Hard requirements the executor must preserve. */
  constraints?: string[];
  /** Bounded areas included in this work package. */
  scope?: string[];
  /** Areas intentionally excluded to avoid sibling overlap. */
  nonGoals?: string[];
  /** Why isolated execution is useful for this work package. */
  delegationReason?: string;
  status: StepStatus;
  /**
   * Execution owner for version-2 plans. A sub-agent step is one semantic
   * work package; its checklist is not scheduled as separate agents.
   */
  executor?: PlanExecutor;
  /** Internal checklist owned by this work package's executor. */
  checklist?: PlanChecklistItem[];
  /** Steps that must finish before this step can run. */
  dependsOn?: string[];
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
  /**
   * Delegate this step to an isolated sub-agent with its own tool loop.
   * Suited for self-contained subtasks that benefit from a focused agent.
   * @deprecated Version-2 plans use executor: 'subagent'. Retained for
   * persisted version-1 plans and external integrations.
   */
  delegate?: boolean;
  /**
   * May run in parallel with other parallel steps in the same wave.
   * Parallel steps must be read-only (no file writes) and must not depend
   * on each other's output. Implies delegate.
   */
  parallel?: boolean;
}

export interface Plan {
  /** Missing means the legacy leaf-delegation semantics. */
  version?: 2;
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
}
