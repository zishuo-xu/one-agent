import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAICompatibleProvider } from '../../src/model/OpenAICompatibleProvider.js';
import type { ModelChunk } from '../../src/model/types.js';

function makeClient(create: ReturnType<typeof vi.fn>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function makeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('OpenAICompatibleProvider', () => {
  it('declares normalized Provider guarantees and accepts adapter overrides', () => {
    const create = vi.fn();
    const defaults = new OpenAICompatibleProvider(makeClient(create), 'default-model');
    const limited = new OpenAICompatibleProvider(makeClient(create), 'limited-model', {
      toolCalling: 'unsupported',
      structuredOutput: 'native',
      contextWindow: 16_000,
    });

    expect(defaults.capabilities).toMatchObject({
      streaming: 'emulated',
      toolCalling: 'native',
      structuredOutput: 'best_effort',
    });
    expect(limited.capabilities).toMatchObject({
      toolCalling: 'unsupported',
      structuredOutput: 'native',
      contextWindow: 16_000,
    });
  });

  describe('complete', () => {
    it('normalizes content, reasoning, toolCalls and usage', async () => {
      const create = vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: 'Hello',
            reasoning_content: 'thinking...',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      const provider = new OpenAICompatibleProvider(makeClient(create), 'test-model');

      const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      expect(response.content).toBe('Hello');
      expect(response.reasoning).toBe('thinking...');
      expect(response.toolCalls).toEqual([{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }]);
      expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it('passes model, tools and jsonMode through to the client', async () => {
      const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: '{}' } }] });
      const provider = new OpenAICompatibleProvider(makeClient(create), 'test-model');
      const tools = [{
        name: 't',
        description: 'test tool',
        inputSchema: { type: 'object', properties: {} },
      }];

      await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tools, jsonMode: true });

      const [params] = create.mock.calls[0];
      expect(params.model).toBe('test-model');
      expect(params.tools).toEqual([{
        type: 'function',
        function: {
          name: 't',
          description: 'test tool',
          parameters: { type: 'object', properties: {} },
        },
      }]);
      expect(params.response_format).toEqual({ type: 'json_object' });
    });

    it('falls back to a plain call when jsonMode is rejected', async () => {
      const create = vi.fn()
        .mockRejectedValueOnce(new Error('response_format is not supported'))
        .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] });
      const provider = new OpenAICompatibleProvider(makeClient(create), 'test-model');

      const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], jsonMode: true });

      expect(response.content).toBe('{"ok":true}');
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
      expect(create.mock.calls[1][0].response_format).toBeUndefined();
    });

    it('returns empty content when the message has no content', async () => {
      const create = vi.fn().mockResolvedValue({ choices: [{ message: {} }] });
      const provider = new OpenAICompatibleProvider(makeClient(create), 'test-model');

      const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      expect(response.content).toBe('');
      expect(response.reasoning).toBeUndefined();
      expect(response.toolCalls).toBeUndefined();
      expect(response.usage).toBeUndefined();
    });
  });

  describe('stream', () => {
    it('normalizes content, reasoning, tool-call deltas and usage', async () => {
      const create = vi.fn().mockResolvedValue(makeStream([
        { choices: [{ delta: { reasoning_content: 'Let me think' } }] },
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_time' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      ]));
      const provider = new OpenAICompatibleProvider(makeClient(create), 'test-model');

      const chunks = await collect(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(chunks[0]).toEqual({ reasoning: 'Let me think' });
      expect(chunks[1]).toEqual({ content: 'Hel' });
      expect(chunks[2]).toEqual({ content: 'lo' });
      expect(chunks[3].toolCallDeltas).toEqual([{ index: 0, id: 'c1', name: 'get_time' }]);
      expect(chunks[4].toolCallDeltas).toEqual([{ index: 0, argumentsDelta: '{}' }]);
      expect(chunks[5]).toEqual({ usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });

      const [params] = create.mock.calls[0];
      expect(params.stream).toBe(true);
      expect(params.stream_options).toEqual({ include_usage: true });
    });

    it('reads content from nested message fields on non-standard chunks', async () => {
      const create = vi.fn().mockResolvedValue(makeStream([
        { choices: [{ delta: { message: { content: 'nested' } } }] },
        { choices: [{ message: { reasoning_content: 'deep' } }] },
      ]));
      const provider = new OpenAICompatibleProvider(makeClient(create), 'test-model');

      const chunks = await collect(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(chunks).toEqual([{ content: 'nested' }, { reasoning: 'deep' }]);
    });

    it('synthesizes chunks when the endpoint ignores stream:true', async () => {
      const create = vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: 'Full answer',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.txt"}' } }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
      const provider = new OpenAICompatibleProvider(makeClient(create), 'test-model');

      const chunks = await collect(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(chunks).toEqual([
        { content: 'Full answer' },
        { toolCallDeltas: [{ index: 0, id: 'c1', name: 'write_file', argumentsDelta: '{"path":"b.txt"}' }] },
        { usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
      ]);
    });
  });
});
