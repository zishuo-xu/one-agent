import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens, estimateMessagesTokens } from '../../src/context/tokenEstimate.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates ASCII text at ~4 chars per token', () => {
    const text = 'Hello World'; // 11 chars
    const tokens = estimateTokens(text);
    expect(tokens).toBe(Math.ceil(11 / 4)); // 3
  });

  it('estimates CJK text at ~1 token per character', () => {
    const text = '你好世界'; // 4 CJK chars
    expect(estimateTokens(text)).toBe(4);
  });

  it('estimates mixed CJK + ASCII', () => {
    const text = '你好 Hello'; // 2 CJK + 1 space + 5 ASCII = 2 + 6/4
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(3);
    expect(tokens).toBeLessThan(6);
  });

  it('handles emoji and other Unicode', () => {
    const text = 'Hello 😀 world';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('estimateMessageTokens', () => {
  it('includes overhead for role', () => {
    const tokens = estimateMessageTokens({ role: 'user', content: '' });
    expect(tokens).toBeGreaterThanOrEqual(4);
  });

  it('accounts for content', () => {
    const tokens = estimateMessageTokens({ role: 'user', content: '你好世界' });
    expect(tokens).toBeGreaterThanOrEqual(8); // 4 overhead + 4 CJK
  });

  it('accounts for tool_calls', () => {
    const tokens = estimateMessageTokens({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
        },
      ],
    });
    expect(tokens).toBeGreaterThan(10);
  });
});

describe('estimateMessagesTokens', () => {
  it('sums across multiple messages', () => {
    const messages = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你的吗？' },
    ];
    const total = estimateMessagesTokens(messages);
    const sum = messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    expect(total).toBe(sum);
    expect(total).toBeGreaterThan(10);
  });
});
