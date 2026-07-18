import type { MemoryRecallCandidate } from '../db/memoryStore.js';
import type { ModelCallTraceEvent, TokenUsage } from '../model/types.js';
import type { FailureAnalysis, Plan } from '../planning/types.js';
import type { ToolCall, ToolResult } from '../tools/types.js';
import type { UserInputRequest } from './requestUserInputTool.js';

/**
 * Public facts emitted while an agent runs.
 *
 * This protocol is intentionally independent from AgentLoop: recorders,
 * queues, memory consolidation, eval and UIs can consume events without
 * depending on the runtime facade that produced them.
 */
export type AgentEvent =
  | {
      type: 'run';
      phase: 'started' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';
      loopMode?: 'simple' | 'planning' | 'auto';
      model?: string;
      provider?: string;
      enabledTools?: string[];
      resumedFromRunId?: string;
      durationMs?: number;
      error?: string;
    }
  | ModelCallTraceEvent
  | { type: 'plan'; plan: Plan }
  | {
      type: 'plan_step';
      stepId: string;
      parentStepId?: string;
      status: 'pending' | 'running' | 'completed' | 'failed' | 'retrying';
      attempt?: number;
      failureAnalysis?: FailureAnalysis;
    }
  | { type: 'thought'; content: string }
  | { type: 'reflection'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall; stepId?: string; attempt?: number }
  | {
      type: 'tool_result';
      toolResult: ToolResult;
      toolCallId?: string;
      stepId?: string;
      attempt?: number;
      status?: 'succeeded' | 'failed' | 'rejected' | 'skipped';
      durationMs?: number;
    }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'message_delta'; content: string }
  | {
      type: 'sub_agent';
      task: string;
      status: 'started' | 'completed' | 'failed';
      stepId?: string;
      reply?: string;
      error?: string;
      toolCallCount?: number;
      durationMs?: number;
      tokenUsage?: TokenUsage;
      /** Condensed internal event stream of the sub-agent (terminal events only). */
      events?: AgentEvent[];
    }
  | {
      type: 'memory_consolidation';
      phase: 'started' | 'completed' | 'failed';
      messageCount?: number;
      candidateCount?: number;
      writtenCount?: number;
      rejectedCount?: number;
      markedExtracted?: boolean;
      durationMs?: number;
      error?: string;
    }
  | {
      type: 'memory_recall';
      keywords: string[];
      skipReason?: 'no_keywords' | 'limit_zero';
      candidateCount: number;
      selectedCount: number;
      candidates: MemoryRecallCandidate[];
      injectedMemoryIds: string[];
      injectedCharacters: number;
      estimatedTokens: number;
      error?: string;
    }
  | { type: 'message'; content: string }
  | { type: 'input_required'; request: UserInputRequest }
  | { type: 'input_received'; requestId: string };

/** Backward-compatible public name retained for existing integrations. */
export type AgentLoopEvent = AgentEvent;
