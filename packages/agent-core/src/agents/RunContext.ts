import type { ReasoningChain } from '../planning/ReasoningChain.js';
import type { RunCheckpoint } from './checkpoint.js';
import type { AgentEvent } from './events.js';

export interface AgentRunResult {
  reply: string;
  events: AgentEvent[];
  runId?: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Mutable data that belongs to exactly one user request.
 *
 * Long-lived collaborators (model, tools, stores) stay on AgentLoop; request
 * correlation and execution progress travel together through the selected
 * loop so they cannot be mistaken for session-wide state.
 */
export interface RunContext {
  message: string;
  runId?: string;
  taskId?: string;
  threadId?: string;
  signal?: AbortSignal;
  memoryText?: string;
  reasoning: ReasoningChain;
  recovery?: {
    checkpoint: RunCheckpoint;
    resumedFromRunId: string;
  };
}
