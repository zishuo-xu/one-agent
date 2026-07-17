import type { Message } from '../agents/types.js';

/** Normalized token accounting, independent of provider wire format. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelCallTraceEvent {
  type: 'model_call';
  phase: 'started' | 'completed' | 'failed';
  modelCallId: string;
  purpose: 'main' | 'classifier' | 'planner' | 'judge' | 'summary' | 'memory' | 'sub_agent';
  provider: string;
  model: string;
  attempt: number;
  streaming: boolean;
  startedAt: string;
  durationMs?: number;
  messageCount?: number;
  toolCount?: number;
  usage?: TokenUsage;
  error?: string;
}

/** A single fragmented tool-call piece from a streaming chunk. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

/** A complete tool call requested by the model. */
export interface ModelToolCall {
  id: string;
  name: string;
  /** Raw JSON string of the arguments, exactly as produced by the model. */
  arguments: string;
}

/** One normalized piece of a streaming completion. */
export interface ModelChunk {
  content?: string;
  reasoning?: string;
  toolCallDeltas?: ToolCallDelta[];
  usage?: TokenUsage;
}

/** Normalized non-streaming completion result. */
export interface ModelResponse {
  content: string;
  reasoning?: string;
  toolCalls?: ModelToolCall[];
  usage?: TokenUsage;
}

export interface ModelRequest {
  messages: Message[];
  /** Provider-specific tool schemas (OpenAI chat format), passed through verbatim. */
  tools?: unknown[];
  /** Ask for JSON-only output; providers fall back to plain text if unsupported. */
  jsonMode?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A chat-model provider. Implementations normalize provider-specific wire
 * formats into the types above so agent code never touches raw SDK shapes.
 */
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}
