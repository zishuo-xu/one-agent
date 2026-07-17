import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../src/model/MockProvider.js';

describe('MockProvider', () => {
  it('replays responses in order and normalizes content/tool calls/usage', async () => {
    const provider = new MockProvider([
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"message":"hi"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      { choices: [{ message: { content: 'done', reasoning_content: 'thinking' } }] },
    ]);

    const first = await provider.complete({ messages: [] });
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls![0]).toEqual({ id: 'call_1', name: 'echo', arguments: '{"message":"hi"}' });
    expect(first.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    const second = await provider.complete({ messages: [] });
    expect(second.content).toBe('done');
    expect(second.reasoning).toBe('thinking');
    expect(second.toolCalls).toBeUndefined();
  });

  it('streams content, tool-call deltas, and usage as chunks', async () => {
    const provider = new MockProvider([
      {
        choices: [
          {
            message: {
              content: 'Hello',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]);

    const chunks = [];
    for await (const chunk of provider.stream({ messages: [] })) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.content === 'Hello')).toBe(true);
    const toolChunk = chunks.find((c) => c.toolCallDeltas);
    expect(toolChunk?.toolCallDeltas).toEqual([
      { index: 0, id: 'call_1', name: 'echo', argumentsDelta: '{}' },
    ]);
    expect(chunks.some((c) => c.usage?.totalTokens === 2)).toBe(true);
  });

  it('throws a clear error when responses are exhausted', async () => {
    const provider = new MockProvider([{ choices: [{ message: { content: 'only one' } }] }]);
    await provider.complete({ messages: [] });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(
      'Mock model exhausted at response index 1'
    );
  });
});
