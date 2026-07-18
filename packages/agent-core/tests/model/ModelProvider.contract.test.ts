import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/model/AnthropicProvider.js';
import { MockProvider } from '../../src/model/MockProvider.js';
import { OpenAICompatibleProvider } from '../../src/model/OpenAICompatibleProvider.js';
import type { ModelChunk, ModelProvider } from '../../src/model/types.js';

interface ProviderFixture {
  create(): ModelProvider;
}

function stream(items: unknown[]): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { for (const item of items) yield item; } };
}

function openAIFixture(): ProviderFixture {
  return {
    create() {
      const create = vi.fn().mockImplementation((params: { stream?: boolean }) => {
        if (params.stream) {
          return stream([
            { choices: [{ delta: { content: 'contract' } }] },
            { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
          ]);
        }
        return { choices: [{ message: { content: 'contract' } }], usage: {
          prompt_tokens: 2, completion_tokens: 1, total_tokens: 3,
        } };
      });
      const client = { chat: { completions: { create } } } as unknown as OpenAI;
      return new OpenAICompatibleProvider(client, 'contract-model');
    },
  };
}

function anthropicFixture(): ProviderFixture {
  return {
    create() {
      const create = vi.fn().mockImplementation((params: { stream?: boolean }) => {
        if (params.stream) {
          return stream([
            { type: 'message_start', message: { usage: {
              input_tokens: 2, output_tokens: 0,
              cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            } } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'contract' } },
            { type: 'message_delta', delta: {}, usage: { input_tokens: null, output_tokens: 1 } },
          ]);
        }
        return { content: [{ type: 'text', text: 'contract' }], usage: {
          input_tokens: 2, output_tokens: 1,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        } };
      });
      const client = { messages: { create } } as unknown as Anthropic;
      return new AnthropicProvider(client, 'contract-model');
    },
  };
}

function mockFixture(): ProviderFixture {
  return {
    create() {
      return new MockProvider([{
        choices: [{ message: { content: 'contract' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }]);
    },
  };
}

async function collect(provider: ModelProvider): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'test' }] })) {
    chunks.push(chunk);
  }
  return chunks;
}

function providerContract(label: string, fixture: ProviderFixture): void {
  describe(`${label} ModelProvider contract`, () => {
    it('returns the normalized non-streaming response shape', async () => {
      const response = await fixture.create().complete({
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(response).toMatchObject({
        content: 'contract',
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      });
    });

    it('returns normalized stream chunks and complete capability declarations', async () => {
      const provider = fixture.create();
      const chunks = await collect(provider);

      expect(chunks).toContainEqual({ content: 'contract' });
      expect(chunks).toContainEqual({
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      });
      expect(Object.keys(provider.capabilities).sort()).toEqual([
        'reasoning', 'streaming', 'structuredOutput', 'toolCalling',
      ]);
    });
  });
}

providerContract('OpenAI-compatible', openAIFixture());
providerContract('Anthropic', anthropicFixture());
providerContract('Mock', mockFixture());
