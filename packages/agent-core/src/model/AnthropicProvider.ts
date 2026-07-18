import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageParam,
  RawMessageStreamEvent,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { Message as AgentMessage } from '../agents/types.js';
import type {
  ModelCapabilities,
  ModelChunk,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  TokenUsage,
} from './types.js';

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: 'native',
  toolCalling: 'native',
  structuredOutput: 'best_effort',
  reasoning: 'best_effort',
};

export interface AnthropicProviderOptions {
  maxTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
}

/**
 * Native adapter for Anthropic's Messages API.
 *
 * All Anthropic wire concepts (top-level system prompt, content blocks,
 * tool_use/tool_result and stream event types) terminate here. AgentLoop sees
 * only the normalized ModelProvider contract.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly capabilities: Readonly<ModelCapabilities>;
  private readonly maxTokens: number;

  constructor(
    private readonly client: Anthropic,
    readonly model: string,
    options: AnthropicProviderOptions = {},
  ) {
    this.maxTokens = options.maxTokens ?? 4096;
    if (!Number.isInteger(this.maxTokens) || this.maxTokens <= 0) {
      throw new Error(`Anthropic maxTokens must be a positive integer; received ${this.maxTokens}`);
    }
    this.capabilities = Object.freeze({
      ...DEFAULT_CAPABILITIES,
      ...options.capabilities,
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.messages.create(
      {
        ...this.buildRequest(request),
        stream: false,
      },
      { timeout: request.timeoutMs, signal: request.signal },
    ) as Message;

    return this.normalizeResponse(response);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const events = await this.client.messages.create(
      {
        ...this.buildRequest(request),
        stream: true,
      },
      { timeout: request.timeoutMs, signal: request.signal },
    ) as AsyncIterable<RawMessageStreamEvent>;

    let inputTokens = 0;
    for await (const event of events) {
      if (event.type === 'message_start') {
        inputTokens = this.inputTokens(event.message.usage);
        continue;
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          const initialInput = this.nonEmptyInput(block.input);
          yield {
            toolCallDeltas: [{
              index: event.index,
              id: block.id,
              name: block.name,
              ...(initialInput === undefined
                ? {}
                : { argumentsDelta: JSON.stringify(initialInput) }),
            }],
          };
        } else if (block.type === 'text' && block.text) {
          yield { content: block.text };
        } else if (block.type === 'thinking' && block.thinking) {
          yield { reasoning: block.thinking };
        }
        continue;
      }
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { content: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { reasoning: event.delta.thinking };
        } else if (event.delta.type === 'input_json_delta') {
          yield {
            toolCallDeltas: [{
              index: event.index,
              argumentsDelta: event.delta.partial_json,
            }],
          };
        }
        continue;
      }
      if (event.type === 'message_delta') {
        const promptTokens = event.usage.input_tokens ?? inputTokens;
        const completionTokens = event.usage.output_tokens;
        yield {
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
        };
      }
    }
  }

  private buildRequest(request: ModelRequest) {
    const { system, messages } = this.convertMessages(request.messages);
    const tools = this.convertTools(request.tools);
    const jsonInstruction = request.jsonMode
      ? 'Return only one valid JSON value without Markdown fences or commentary.'
      : undefined;
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      ...(tools ? { tools } : {}),
      ...(system || jsonInstruction
        ? { system: [system, jsonInstruction].filter(Boolean).join('\n\n') }
        : {}),
    };
  }

  private convertMessages(messages: AgentMessage[]): {
    system: string;
    messages: MessageParam[];
  } {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .filter(Boolean)
      .join('\n\n');
    const converted: MessageParam[] = [];

    for (const message of messages) {
      if (message.role === 'system') continue;

      if (message.role === 'tool') {
        const block: ContentBlockParam = {
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: message.content,
          ...(this.isErrorToolResult(message.content) ? { is_error: true } : {}),
        };
        const previous = converted.at(-1);
        if (previous?.role === 'user' && Array.isArray(previous.content) &&
            previous.content.every((item) => item.type === 'tool_result')) {
          previous.content.push(block);
        } else {
          converted.push({ role: 'user', content: [block] });
        }
        continue;
      }

      if (message.role === 'assistant' && message.tool_calls?.length) {
        const blocks: ContentBlockParam[] = [];
        if (message.content) blocks.push({ type: 'text', text: message.content });
        for (const toolCall of message.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: this.parseToolArguments(toolCall.function.arguments),
          });
        }
        converted.push({ role: 'assistant', content: blocks });
        continue;
      }

      converted.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      });
    }

    return { system, messages: converted };
  }

  private convertTools(tools: ModelRequest['tools']): Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => {
      if (!tool.name || !tool.inputSchema) {
        throw new Error('AnthropicProvider received an invalid normalized tool schema');
      }
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: tool.inputSchema as Tool.InputSchema,
      };
    });
  }

  private normalizeResponse(response: Message): ModelResponse {
    const content = response.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const reasoning = response.content
      .filter((block): block is Extract<ContentBlock, { type: 'thinking' }> => block.type === 'thinking')
      .map((block) => block.thinking)
      .join('');
    const toolCalls = response.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map<ModelToolCall>((block) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      }));

    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage: this.normalizeUsage(response.usage),
    };
  }

  private normalizeUsage(usage: Message['usage']): TokenUsage {
    const promptTokens = this.inputTokens(usage);
    const completionTokens = usage.output_tokens;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private inputTokens(usage: Message['usage']): number {
    return usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
  }

  private parseToolArguments(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }

  private nonEmptyInput(input: unknown): unknown | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    return Object.keys(input as Record<string, unknown>).length > 0 ? input : undefined;
  }

  private isErrorToolResult(content: string): boolean {
    try {
      const parsed = JSON.parse(content) as { success?: unknown };
      return parsed.success === false;
    } catch {
      return false;
    }
  }
}
