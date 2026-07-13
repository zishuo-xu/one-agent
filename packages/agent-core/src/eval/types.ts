import { AgentLoopEvent } from '../agents/AgentLoop.js';
import { ToolCall } from '../tools/types.js';

export interface EvalToolExpectation {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface EvalFileExpectation {
  path: string;
  contains?: string;
}

export interface EvalTask {
  id: string;
  name: string;
  description: string;
  prompt: string;
  initialWorkspace?: Record<string, string>;
  /** Tools that must be called in the exact order. Use for deterministic regression. */
  expectedTools?: EvalToolExpectation[];
  /** Tools that must be called at least once, regardless of order. */
  requiredTools?: EvalToolExpectation[];
  forbiddenTools?: string[];
  expectedOutcome?: 'success' | 'failure';
  finalAnswerContains?: string[];
  /** Files that must exist after the task runs, optionally checked for content substring. */
  expectedFiles?: EvalFileExpectation[];
  enablePlanning?: boolean;
  timeoutMs?: number;
}

export interface EvalResult {
  taskId: string;
  passed: boolean;
  reply: string;
  events: AgentLoopEvent[];
  toolCalls: ToolCall[];
  errors: string[];
  durationMs: number;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  planningMetrics?: {
    planCount: number;
    replanCount: number;
    retryCount: number;
    planStepCount: number;
  };
  reflectionCount?: number;
}

export interface EvalRunnerOptions {
  tasks: EvalTask[];
  workspaceRoot: string;
  enablePlanning?: boolean;
  defaultTimeoutMs?: number;
  /** When 'real', the runner does not mock the OpenAI client and lets AgentLoop call the real model. */
  mode?: 'mock' | 'real';
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  failed: number;
  results: EvalResult[];
}
