import type {
  ModelCapabilities,
  ModelChunk,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  TokenUsage,
} from '@one-agent/agent-core';

interface ReplayMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
}

/** Deterministic model response replay owned by the offline eval package. */
export class ReplayModelProvider implements ModelProvider {
  readonly name = 'eval-replay';
  readonly model = 'eval-replay-model';
  readonly capabilities: Readonly<ModelCapabilities> = Object.freeze({
    streaming: 'emulated',
    toolCalling: 'native',
    structuredOutput: 'emulated',
    reasoning: 'native',
  });
  private index = 0;

  constructor(private readonly responses: unknown[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    return this.toResponse(this.next());
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
    const response = this.toResponse(this.next());
    if (response.reasoning) yield { reasoning: response.reasoning };
    if (response.content) yield { content: response.content };
    if (response.toolCalls) {
      yield {
        toolCallDeltas: response.toolCalls.map((call, index) => ({
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: call.arguments,
        })),
      };
    }
    if (response.usage) yield { usage: response.usage };
  }

  private next(): unknown {
    if (this.index >= this.responses.length) {
      throw new Error(
        `Mock model exhausted at response index ${this.index}; add more mockResponses to the eval task.`,
      );
    }
    return this.responses[this.index++];
  }

  private toResponse(raw: unknown): ModelResponse {
    const message = (raw as { choices?: Array<{ message?: ReplayMessage }> }).choices?.[0]?.message ?? {};
    const toolCalls: ModelToolCall[] | undefined = message.tool_calls?.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }));
    const rawUsage = (raw as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }).usage;
    const usage: TokenUsage | undefined = rawUsage
      ? {
          promptTokens: rawUsage.prompt_tokens ?? 0,
          completionTokens: rawUsage.completion_tokens ?? 0,
          totalTokens: rawUsage.total_tokens ?? 0,
        }
      : undefined;
    return {
      content: message.content ?? '',
      reasoning: message.reasoning_content ?? undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage,
    };
  }
}
