import type { ContextManager } from '../context/ContextManager.js';
import type { ModelProvider, ModelResponse, TokenUsage } from '../model/types.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface ModelCallerOptions {
  modelProvider: ModelProvider;
  contextManager: ContextManager;
  toolRegistry?: ToolRegistry;
  timeoutMs: number;
  maxRetries: number;
  /** Getter so the per-chat abort signal is read at call time, not construction. */
  signal?: () => AbortSignal | undefined;
  /** Usage sink for every model call made here (fed back into run accounting). */
  onUsage?: (usage: TokenUsage) => void;
  /** Live deltas for the client (message_delta / reasoning_delta events). */
  onDelta?: (type: 'message_delta' | 'reasoning_delta', content: string) => void;
}

export interface StreamedCompletion {
  content: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * The single home of "how we talk to the model": non-streaming and streaming
 * completions, retry policy, tool-call delta assembly, the
 * reasoning-as-fallback rule, and the no-retry-after-emitted-delta guard.
 * Wire-format quirks (reasoning_content probing, non-streaming fallback for
 * endpoints that ignore `stream: true`) live in the provider; this class only
 * carries agent-level policy.
 */
export class ModelCaller {
  private readonly modelProvider: ModelProvider;
  private readonly contextManager: ContextManager;
  private readonly toolRegistry?: ToolRegistry;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly signal?: () => AbortSignal | undefined;
  private readonly onUsage?: (usage: TokenUsage) => void;
  private readonly onDelta?: (type: 'message_delta' | 'reasoning_delta', content: string) => void;

  constructor(options: ModelCallerOptions) {
    this.modelProvider = options.modelProvider;
    this.contextManager = options.contextManager;
    this.toolRegistry = options.toolRegistry;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.signal = options.signal;
    this.onUsage = options.onUsage;
    this.onDelta = options.onDelta;
  }

  /** Non-streaming completion with retries (used for tool-loop turns). */
  async complete(options: { includeTools?: boolean; allowedTools?: string[] } = {}): Promise<ModelResponse> {
    const { includeTools = true, allowedTools } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkSignal();
      try {
        const messages = await this.contextManager.buildContext();
        const tools = includeTools
          ? this.toolRegistry?.getSchemas(allowedTools)
          : undefined;
        const response = await this.modelProvider.complete({
          messages,
          tools,
          timeoutMs: this.timeoutMs,
          signal: this.signal?.(),
        });
        this.reportUsage(response.usage);
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `Model call failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  /**
   * A single streaming completion that simultaneously streams the answer text
   * to the user (via onDelta) and accumulates tool-call deltas by their
   * `index`. There is exactly one request per turn, and for tool-less answers
   * the text already reached the client token-by-token by the time the stream
   * ends. Callers that don't need tool calls (e.g. final answers) simply
   * ignore the returned toolCalls.
   */
  async completeStreaming(options: { allowedTools?: string[]; includeTools?: boolean } = {}): Promise<StreamedCompletion> {
    const { allowedTools, includeTools = true } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkSignal();
      // Track whether we have already streamed partial content to the client
      // during this attempt. Once any message_delta has been emitted we cannot
      // safely retry: a retry would replay the same tokens and the user would
      // see duplicated/garbled output. Only retry while no delta has shipped.
      let emittedDelta = false;
      try {
        const messages = await this.contextManager.buildContext();
        const tools = includeTools
          ? this.toolRegistry?.getSchemas(allowedTools)
          : undefined;

        let content = '';
        // Reasoning-as-fallback policy: stream content live; buffer reasoning
        // and use it as the answer only if the stream ends with no real content.
        let reasoningBuffer = '';
        let hasRealContent = false;
        // Tool-call deltas arrive fragmented across chunks, indexed by position.
        const toolCallMap = new Map<
          number,
          { id?: string; name?: string; arguments: string }
        >();

        for await (const chunk of this.modelProvider.stream({
          messages,
          tools,
          timeoutMs: this.timeoutMs,
          signal: this.signal?.(),
        })) {
          this.checkSignal();
          this.reportUsage(chunk.usage);

          if (chunk.content) {
            content += chunk.content;
            if (chunk.content.trim()) hasRealContent = true;
            emittedDelta = true;
            this.onDelta?.('message_delta', chunk.content);
          }
          if (chunk.reasoning && !hasRealContent) {
            reasoningBuffer += chunk.reasoning;
            // Emit reasoning live so the user sees activity instead of
            // staring at a blank spinner for seconds on end.
            this.onDelta?.('reasoning_delta', chunk.reasoning);
          }
          if (chunk.toolCallDeltas) {
            for (const tc of chunk.toolCallDeltas) {
              const existing = toolCallMap.get(tc.index) ?? {
                id: undefined,
                name: undefined,
                arguments: '',
              };
              if (tc.id) existing.id = tc.id;
              if (tc.name) existing.name = tc.name;
              if (tc.argumentsDelta) existing.arguments += tc.argumentsDelta;
              toolCallMap.set(tc.index, existing);
            }
          }
        }

        // If the model only produced reasoning_content (no real content),
        // use it as the answer so the user is not left with an empty reply.
        // Do NOT re-emit it as a message_delta: the reasoning was already
        // streamed live via reasoning_delta, and replaying the whole buffer
        // would print the entire text a second time.
        if (!hasRealContent && reasoningBuffer) {
          content = reasoningBuffer;
          emittedDelta = true;
        }

        const toolCalls =
          toolCallMap.size > 0
            ? [...toolCallMap.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, tc]) => ({
                  id: tc.id ?? '',
                  type: 'function' as const,
                  function: { name: tc.name ?? '', arguments: tc.arguments },
                }))
            : undefined;

        return { content, toolCalls };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (emittedDelta) {
          // Partial content already reached the client; retrying would
          // duplicate it. Surface the error to the caller instead.
          throw lastError;
        }
      }
    }

    throw new Error(
      `Model call failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  private reportUsage(usage?: TokenUsage): void {
    if (usage) {
      this.onUsage?.(usage);
    }
  }

  private checkSignal(): void {
    if (this.signal?.()?.aborted) {
      throw new Error('AgentLoop was cancelled');
    }
  }
}
