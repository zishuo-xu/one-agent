import type { ReasoningChain } from '../planning/ReasoningChain.js';
import type { RunCheckpoint } from './checkpoint.js';
import type { AgentEvent } from './events.js';
import type { UserInputRequest } from './requestUserInputTool.js';
import type { ToolResult } from '../tools/types.js';
import type { StrategyController, StrategySignal } from './StrategyController.js';

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

export interface StrategySwitchResult {
  status: 'switch_strategy';
  from: 'simple';
  to: 'planning';
  reason: string;
  trigger: StrategySignal;
}

export type TerminalLoopResult =
  | { status: 'completed'; reply: string }
  | {
      status: 'waiting_for_input';
      reply: string;
      inputRequest: UserInputRequest;
      checkpoint: RunCheckpoint;
    };

export type LoopResult = TerminalLoopResult | StrategySwitchResult;

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
  strategy?: {
    controller: StrategyController;
    switchCount: number;
  };
  recovery?: {
    checkpoint: RunCheckpoint;
    resumedFromRunId: string;
    approvedToolResult?: {
      stepId?: string;
      result: ToolResult;
    };
    pendingInput?: UserInputRequest;
    inputAnswer?: string;
  };
}
