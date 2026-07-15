import type OpenAI from 'openai';
import type {
  ModelChunk,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  TokenUsage,
  ToolCallDelta,
} from './types.js';

/**
 * Provider for OpenAI-compatible chat-completions endpoints (OpenAI,
 * DeepSeek, Qwen, Kimi, GLM, Ollama, ...). Owns all wire-format knowledge:
 * reasoning_content probing across nesting levels, fragmented tool_call
 * deltas, usage extraction, and endpoints that silently ignore `stream: true`.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { messages, tools, jsonMode, timeoutMs, signal } = request;
    const options = { timeout: timeoutMs, signal };
    const base = { model: this.model, messages: messages as never, tools: tools as never };

    let response: unknown;
    if (jsonMode) {
      try {
        response = await this.client.chat.completions.create(
          { ...base, response_format: { type: 'json_object' } },
          options,
        );
      } catch {
        // Some endpoints do not support response_format; retry without it.
        response = await this.client.chat.completions.create(base, options);
      }
    } else {
      response = await this.client.chat.completions.create(base, options);
    }

    return this.normalizeResponse(response);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const { messages, tools, timeoutMs, signal } = request;
    const response = (await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messages as never,
        stream: true,
        stream_options: { include_usage: true },
        tools: tools as never,
      },
      { timeout: timeoutMs, signal },
    )) as unknown;

    if (response && typeof response === 'object' && Symbol.asyncIterator in response) {
      for await (const chunk of response as AsyncIterable<unknown>) {
        yield this.normalizeChunk(chunk);
      }
      return;
    }

    // Some compatible endpoints ignore `stream: true` and return a plain
    // completion object. Synthesize chunks so callers keep their contract.
    const normalized = this.normalizeResponse(response);
    if (normalized.reasoning) {
      yield { reasoning: normalized.reasoning };
    }
    if (normalized.content) {
      yield { content: normalized.content };
    }
    if (normalized.toolCalls && normalized.toolCalls.length > 0) {
      yield {
        toolCallDeltas: normalized.toolCalls.map((tc, index) => ({
          index,
          id: tc.id,
          name: tc.name,
          argumentsDelta: tc.arguments,
        })),
      };
    }
    if (normalized.usage) {
      yield { usage: normalized.usage };
    }
  }

  private normalizeResponse(response: unknown): ModelResponse {
    const message = (response as { choices?: Array<{ message?: unknown }> })?.choices?.[0]?.message;
    const record = (message ?? {}) as Record<string, unknown>;
    const content = this.extractText(record.content);
    // Volcengine GLM-5.2 sometimes returns generated text in reasoning_content
    // even for non-streaming completions; surface it separately and let the
    // caller decide whether to use it as a fallback answer.
    const reasoning = this.extractText(record.reasoning_content ?? record.reasoningContent);
    const toolCalls = this.normalizeToolCalls(record.tool_calls);
    const usage = this.normalizeUsage((response as Record<string, unknown>)?.usage);
    return { content, reasoning: reasoning || undefined, toolCalls, usage };
  }

  /**
   * Extract content and reasoning_content separately from a streaming chunk,
   * covering all nesting levels used by OpenAI and compatible endpoints
   * (delta.content, delta.message.content, choices[0].message.content, etc.).
   */
  private normalizeChunk(chunk: unknown): ModelChunk {
    const first = (chunk as { choices?: Array<Record<string, unknown>> })?.choices?.[0];
    const delta = first?.delta as Record<string, unknown> | undefined;
    const nestedMessage = delta?.message as Record<string, unknown> | undefined;
    const msg = first?.message as Record<string, unknown> | undefined;

    const content =
      this.extractText(delta?.content) ||
      this.extractText(nestedMessage?.content) ||
      this.extractText(msg?.content);
    const reasoning =
      this.extractText(delta?.reasoning_content ?? delta?.reasoningContent) ||
      this.extractText(nestedMessage?.reasoning_content ?? nestedMessage?.reasoningContent) ||
      this.extractText(msg?.reasoning_content ?? msg?.reasoningContent);
    const toolCallDeltas = this.normalizeToolCallDeltas(delta?.tool_calls);
    const usage = this.normalizeUsage((chunk as Record<string, unknown>)?.usage);

    const result: ModelChunk = {};
    if (content) result.content = content;
    if (reasoning) result.reasoning = reasoning;
    if (toolCallDeltas) result.toolCallDeltas = toolCallDeltas;
    if (usage) result.usage = usage;
    return result;
  }

  private normalizeToolCalls(value: unknown): ModelToolCall[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    return value.map((tc) => {
      const record = tc as Record<string, unknown>;
      const fn = record.function as Record<string, unknown> | undefined;
      return {
        id: typeof record.id === 'string' ? record.id : '',
        name: typeof fn?.name === 'string' ? fn.name : '',
        arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
      };
    });
  }

  private normalizeToolCallDeltas(value: unknown): ToolCallDelta[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    return value.map((tc) => {
      const record = tc as Record<string, unknown>;
      const fn = record.function as Record<string, unknown> | undefined;
      const delta: ToolCallDelta = {
        index: typeof record.index === 'number' ? record.index : 0,
      };
      if (typeof record.id === 'string') delta.id = record.id;
      if (typeof fn?.name === 'string') delta.name = fn.name;
      if (typeof fn?.arguments === 'string') delta.argumentsDelta = fn.arguments;
      return delta;
    });
  }

  private normalizeUsage(value: unknown): TokenUsage | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const u = value as Record<string, unknown>;
    const promptTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
    const completionTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
    const totalTokens =
      typeof u.total_tokens === 'number' ? u.total_tokens : promptTokens + completionTokens;
    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
    return { promptTokens, completionTokens, totalTokens };
  }

  private extractText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (!Array.isArray(value)) {
      return '';
    }
    return value
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (!part || typeof part !== 'object') {
          return '';
        }
        const item = part as Record<string, unknown>;
        return this.extractText(item.text ?? item.content);
      })
      .join('');
  }
}
