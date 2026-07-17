import type {
  ModelChunk,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  TokenUsage,
} from './types.js';

interface MockMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
}

/**
 * Deterministic replay provider for evaluation and tests: serves
 * OpenAI-shaped responses in order and normalizes them exactly like the
 * real provider would. Injected via AgentLoopOptions.modelProvider, so mock
 * runs never touch the global client (no monkey-patching, parallel-safe).
 */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly model = 'mock-model';
  private index = 0;

  constructor(private readonly responses: unknown[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    return this.toResponse(this.next());
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
    const response = this.toResponse(this.next());
    if (response.reasoning) {
      yield { reasoning: response.reasoning };
    }
    if (response.content) {
      yield { content: response.content };
    }
    if (response.toolCalls) {
      yield {
        toolCallDeltas: response.toolCalls.map((tc, index) => ({
          index,
          id: tc.id,
          name: tc.name,
          argumentsDelta: tc.arguments,
        })),
      };
    }
    if (response.usage) {
      yield { usage: response.usage };
    }
  }

  private next(): unknown {
    if (this.index >= this.responses.length) {
      throw new Error(
        `Mock model exhausted at response index ${this.index}; add more mockResponses to the eval task.`
      );
    }
    return this.responses[this.index++];
  }

  private toResponse(raw: unknown): ModelResponse {
    const message = (raw as { choices?: Array<{ message?: MockMessage }> }).choices?.[0]?.message ?? {};
    const toolCalls: ModelToolCall[] | undefined = message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    const rawUsage = (raw as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
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
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }
}
