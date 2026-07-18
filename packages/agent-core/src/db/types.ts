import { AgentLoopEvent } from '../agents/AgentLoop.js';
import { Message } from '../agents/types.js';
import { ReasoningStep } from '../planning/types.js';
import { TaskStatus } from '../tasks/types.js';
import { ToolCall, ToolResult } from '../tools/types.js';
import type { RunCheckpoint } from '../agents/checkpoint.js';

export interface Thread {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateThreadInput {
  id?: string;
  title?: string;
}

export interface PersistedMessage {
  id: string;
  threadId: string;
  role: string;
  content: string;
  toolCalls?: string;
  toolCallId?: string;
  internal: boolean;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  threadId: string;
  taskId: string | null;
  model: string;
  startTime: string;
  endTime: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'recovery_required';
  error: string | null;
  reasoningChain?: ReasoningStep[];
  traceStatus?: 'recording' | 'complete' | 'partial' | 'failed';
  droppedTraceEvents: number;
  traceError?: string;
  checkpoint?: RunCheckpoint;
}

export interface CreateRunInput {
  id?: string;
  threadId: string;
  taskId?: string;
  model: string;
  status?: AgentRun['status'];
  error?: string;
  reasoningChain?: ReasoningStep[];
  traceStatus?: 'recording' | 'complete' | 'partial' | 'failed';
  droppedTraceEvents?: number;
  traceError?: string;
  checkpoint?: RunCheckpoint;
}

export interface TraceEvent {
  id: string;
  runId: string | null;
  taskId: string | null;
  threadId: string | null;
  eventType: string;
  eventData: AgentLoopEvent;
  model: string | null;
  sequence: number;
  createdAt: string;
}

export interface CreateTraceEventInput {
  id?: string;
  runId?: string;
  taskId?: string;
  threadId?: string;
  eventType: string;
  eventData: AgentLoopEvent;
  model?: string;
  sequence?: number;
  createdAt?: string;
}

export interface PersistedToolCall {
  id: string;
  runId: string;
  name: string;
  arguments?: string;
  result?: string;
  success: boolean;
  createdAt: string;
}

export interface CreateToolCallInput {
  id?: string;
  runId: string;
  toolCall: ToolCall;
  result: ToolResult;
}

export interface PersistedTask {
  id: string;
  threadId: string | null;
  message: string;
  status: TaskStatus;
  reply: string | null;
  error: string | null;
  retryCount: number;
  failedReason: string | null;
  events: AgentLoopEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskPersistedInput {
  id?: string;
  threadId?: string;
  message: string;
  status?: TaskStatus;
  reply?: string;
  error?: string;
  retryCount?: number;
  failedReason?: string;
  events?: AgentLoopEvent[];
}

export interface Memory {
  id: string;
  key: string;
  value: string;
  source: string | null;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  id?: string;
  key: string;
  value: string;
  source?: string;
  threadId?: string;
}

export function messageToPersisted(message: Message): Pick<
  PersistedMessage,
  'role' | 'content' | 'toolCalls' | 'toolCallId' | 'internal'
> {
  return {
    role: message.role,
    content: message.content,
    toolCalls: message.tool_calls ? JSON.stringify(message.tool_calls) : undefined,
    toolCallId: message.tool_call_id,
    internal: message.internal ?? false,
  };
}

export function persistedToMessage(row: PersistedMessage): Message {
  return {
    role: row.role as Message['role'],
    content: row.content ?? '',
    tool_calls: row.toolCalls ? JSON.parse(row.toolCalls) : undefined,
    tool_call_id: row.toolCallId,
    internal: row.internal || undefined,
  };
}
