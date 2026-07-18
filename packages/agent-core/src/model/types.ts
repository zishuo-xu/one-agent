import type { Message } from '../agents/types.js';

export type ModelCapabilitySupport =
  | 'native'
  | 'emulated'
  | 'best_effort'
  | 'unsupported';

/** Capabilities guaranteed by a Provider at its normalized boundary. */
export interface ModelCapabilities {
  streaming: ModelCapabilitySupport;
  toolCalling: ModelCapabilitySupport;
  structuredOutput: ModelCapabilitySupport;
  reasoning: ModelCapabilitySupport;
  /** Declared context window. Undefined means the Provider cannot guarantee it. */
  contextWindow?: number;
}

export type RequiredModelCapability = 'streaming' | 'toolCalling' | 'structuredOutput';

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

/** Provider-neutral function tool exposed to a model. */
export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
  /** Provider-neutral tools; each Provider owns wire-format conversion. */
  tools?: ModelToolDefinition[];
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
  readonly capabilities: Readonly<ModelCapabilities>;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}
