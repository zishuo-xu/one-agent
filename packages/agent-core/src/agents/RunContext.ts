import type { ReasoningChain } from '../planning/ReasoningChain.js';
import type { RunCheckpoint } from './checkpoint.js';
import type { AgentEvent } from './events.js';
import type { UserInputRequest } from './requestUserInputTool.js';

export interface AgentRunResult {
  status: 'completed' | 'waiting_for_input';
  reply: string;
  inputRequest?: UserInputRequest;
  events: AgentEvent[];
  runId?: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type LoopResult =
  | { status: 'completed'; reply: string }
  | {
      status: 'waiting_for_input';
      reply: string;
      inputRequest: UserInputRequest;
      checkpoint: RunCheckpoint;
    };

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
