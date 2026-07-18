import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/model/AnthropicProvider.js';
import type { ModelChunk } from '../../src/model/types.js';

function makeClient(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

function makeStream(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function usage(input = 10, output = 5) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
  };
}

describe('AnthropicProvider', () => {
  it('declares conservative capabilities and validates maxTokens', () => {
    const provider = new AnthropicProvider(makeClient(vi.fn()), 'claude-test');

    expect(provider.capabilities).toMatchObject({
      streaming: 'native',
      toolCalling: 'native',
      structuredOutput: 'best_effort',
      reasoning: 'best_effort',
    });
    expect(() => new AnthropicProvider(makeClient(vi.fn()), 'claude-test', { maxTokens: 0 }))
      .toThrow(/positive integer/);
  });

  it('converts system, tool schemas and complete responses at the Provider boundary', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'check the file' },
        { type: 'text', text: 'I will inspect it.' },
        { type: 'tool_use', id: 'call-2', name: 'read_file', input: { path: 'a.txt' } },
      ],
      usage: usage(),
    });
    const provider = new AnthropicProvider(makeClient(create), 'claude-test', { maxTokens: 2048 });
    const signal = new AbortController().signal;

    const response = await provider.complete({
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Inspect a.txt' },
        {
          role: 'assistant',
          content: 'Calling tools',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"old.txt"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"success":true,"data":"ok"}' },
      ],
      tools: [{
        name: 'read_file',
        description: 'Read one file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      jsonMode: true,
      timeoutMs: 1234,
      signal,
    });

    expect(response).toEqual({
      content: 'I will inspect it.',
      reasoning: 'check the file',
      toolCalls: [{ id: 'call-2', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
    });
    const [params, requestOptions] = create.mock.calls[0];
    expect(params).toMatchObject({
      model: 'claude-test',
      max_tokens: 2048,
      stream: false,
      system: 'Be precise.\n\nReturn only one valid JSON value without Markdown fences or commentary.',
      tools: [{
        name: 'read_file',
        description: 'Read one file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    });
    expect(params.messages).toEqual([
      { role: 'user', content: 'Inspect a.txt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling tools' },
          { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'old.txt' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: '{"success":true,"data":"ok"}',
        }],
      },
    ]);
    expect(requestOptions).toEqual({ timeout: 1234, signal });
  });

  it('groups consecutive tool results and marks explicit failures', async () => {
    const create = vi.fn().mockResolvedValue({ content: [], usage: usage(1, 1) });
    const provider = new AnthropicProvider(makeClient(create), 'claude-test');

    await provider.complete({
      messages: [
        { role: 'user', content: 'Run both' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } },
            { id: 'b', type: 'function', function: { name: 'two', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: '{"success":true}' },
        { role: 'tool', tool_call_id: 'b', content: '{"success":false,"error":"no"}' },
      ],
    });

    expect(create.mock.calls[0][0].messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '{"success":true}' },
        {
          type: 'tool_result',
          tool_use_id: 'b',
          content: '{"success":false,"error":"no"}',
          is_error: true,
        },
      ],
    });
  });

  it('normalizes native stream events without leaking Anthropic event shapes', async () => {
    const events = makeStream([
      { type: 'message_start', message: { usage: usage(7, 0) } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'Think', signature: '' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' more' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '', citations: [] },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'get_time', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"timezone":"UTC"}' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: null, output_tokens: 4 },
      },
      { type: 'message_stop' },
    ]);
    const create = vi.fn().mockResolvedValue(events);
    const provider = new AnthropicProvider(makeClient(create), 'claude-test');

    const chunks = await collect(provider.stream({
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 2000,
    }));

    expect(chunks).toEqual([
      { reasoning: 'Think' },
      { reasoning: ' more' },
      { content: 'Hello' },
      { toolCallDeltas: [{ index: 2, id: 'tool-1', name: 'get_time' }] },
      { toolCallDeltas: [{ index: 2, argumentsDelta: '{"timezone":"UTC"}' }] },
      { usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } },
    ]);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-test', stream: true });
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 2000 });
  });

  it('rejects malformed normalized tool schemas with a boundary error', async () => {
    const provider = new AnthropicProvider(makeClient(vi.fn()), 'claude-test');

    await expect(provider.complete({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'not-normalized' } as never],
    })).rejects.toThrow(/invalid normalized tool schema/);
  });
});
