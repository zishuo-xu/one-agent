import type { AgentEvent } from '../agents/events.js';
import { ToolCall } from '../tools/types.js';
import type { CompletionOutcome } from '../verification/types.js';

export interface MockChatCompletionResponse {
  choices: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface EvalToolExpectation {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface EvalFileExpectation {
  path: string;
  contains?: string;
  /** All substrings must appear in the file (AND semantics, case-insensitive). */
  containsAll?: string[];
  /** No substring may appear in the file (case-insensitive). */
  notContains?: string[];
}

/**
 * A weighted checkpoint for partial credit on long-horizon tasks (L6-style).
 * Each checkpoint is evaluated independently and earns its points only when
 * every one of its assertions passes (binary per checkpoint).
 */
export interface EvalCheckpoint {
  id: string;
  description: string;
  points: number;
  finalAnswerContains?: string[];
  finalAnswerContainsAll?: string[];
  finalAnswerNotContains?: string[];
  expectedFiles?: EvalFileExpectation[];
  forbiddenFiles?: string[];
  requiredTools?: EvalToolExpectation[];
  forbiddenTools?: string[];
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
  /** Any phrase suffices (OR semantics, case-insensitive). */
  finalAnswerContains?: string[];
  /** Every phrase must appear (AND semantics, case-insensitive). */
  finalAnswerContainsAll?: string[];
  /** No phrase may appear (case-insensitive). */
  finalAnswerNotContains?: string[];
  /** Files that must exist after the task runs, optionally checked for content. */
  expectedFiles?: EvalFileExpectation[];
  /** Files that must NOT exist after the run (deleted files, forbidden writes). */
  forbiddenFiles?: string[];
  /** Capability tags for per-dimension score aggregation (e.g. "tool-chain"). */
  capabilities?: string[];
  difficulty?: 'easy' | 'medium' | 'hard';
  /**
   * Weighted checkpoints for partial credit. When present, the task passes
   * only if every checkpoint earns full points (and task-level assertions pass).
   */
  checkpoints?: EvalCheckpoint[];
  /** Pre-defined model responses for mock evaluation mode. Required when mode is 'mock'. */
  mockResponses?: MockChatCompletionResponse[];
  enablePlanning?: boolean;
  timeoutMs?: number;
}

export interface EvalCheckpointResult {
  id: string;
  description: string;
  earned: number;
  points: number;
  errors: string[];
}

export interface EvalResult {
  taskId: string;
  passed: boolean;
  reply: string;
  events: AgentEvent[];
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
  /** Runtime's evidence-based completion verdict, independent of eval assertions. */
  completionOutcome?: CompletionOutcome;
  /** Checkpoint scoring, present when the task defines checkpoints. */
  score?: number;
  maxScore?: number;
  checkpointResults?: EvalCheckpointResult[];
  /** Persisted run/thread ids when the runner was given a traceDbPath. */
  runId?: string;
  threadId?: string;
}

export interface EvalRunnerOptions {
  tasks: EvalTask[];
  workspaceRoot: string;
  /** Maximum number of tasks evaluated concurrently. Defaults to 1. */
  concurrency?: number;
  enablePlanning?: boolean;
  defaultTimeoutMs?: number;
  /** When 'real', the runner does not mock the OpenAI client and lets AgentLoop call the real model. */
  mode?: 'mock' | 'real';
  /**
   * When set, each task runs in its own persisted thread in this SQLite file
   * so failures can be inspected afterwards in trace-web
   * (`one-agent trace --workspace <path>`). Failed tasks mark their run
   * as failed with the assertion errors and prefix the thread title [FAIL].
   */
  traceDbPath?: string;
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  failed: number;
  results: EvalResult[];
  /** Score sums across tasks that define checkpoints. */
  totalScore?: number;
  totalMaxScore?: number;
}
