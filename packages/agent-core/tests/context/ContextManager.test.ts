import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    port: 3000,
    host: '127.0.0.1',
    model: 'gpt-test',
    systemPrompt: 'You are a test assistant.',
    timeoutMs: 30000,
    maxContextTokens: undefined,
    recentTokenBudget: undefined,
    openai: {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    },
  },
}));

import { config } from '../../src/config.js';
import { ContextManager } from '../../src/context/ContextManager.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

describe('ContextManager', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns full history for short conversations', async () => {
    const manager = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxRecentMessages: 4,
      summaryTrigger: 10,
    });

    manager.addMessage({ role: 'user', content: 'Hi' });
    manager.addMessage({ role: 'assistant', content: 'Hello' });

    const context = await manager.buildContext();

    expect(context).toHaveLength(3); // system + user + assistant
    expect(context[0]).toEqual({ role: 'system', content: 'You are a test assistant.' });
    expect(context[1]).toEqual({ role: 'user', content: 'Hi' });
    expect(context[2]).toEqual({ role: 'assistant', content: 'Hello' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('summarizes old messages when threshold is exceeded', async () => {
    const manager = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxRecentMessages: 4,
      summaryTrigger: 6,
    });

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Summary of earlier conversation.' } }],
    } as never);

    // Add messages: 1 system + 10 user/assistant = 11 total, > 6 threshold
    manager.addMessage({ role: 'user', content: 'Message 1' });
    for (let i = 2; i <= 10; i++) {
      manager.addMessage({
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `Message ${i}`,
      });
    }

    const context = await manager.buildContext();

    // system + summary + 4 recent messages
    expect(context).toHaveLength(6);
    expect(context[0].role).toBe('system');
    expect(context[1].role).toBe('system');
    expect(context[1].content).toContain('Summary of earlier conversation.');
    expect(context[context.length - 1].content).toBe('Message 10');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArgs.messages[0].role).toBe('system');
    expect(callArgs.messages[1].role).toBe('user');
  });

  it('preserves system prompt at the beginning', async () => {
    const manager = new ContextManager({
      systemPrompt: 'You are a coder.',
      maxRecentMessages: 2,
      summaryTrigger: 4,
    });

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Summary' } }],
    } as never);

    for (let i = 1; i <= 5; i++) {
      manager.addMessage({ role: 'user', content: `msg ${i}` });
    }

    const context = await manager.buildContext();

    expect(context[0]).toEqual({ role: 'system', content: 'You are a coder.' });
  });

  it('caches summary and reuses it', async () => {
    const manager = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxRecentMessages: 4,
      summaryTrigger: 6,
    });

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Summary' } }],
    } as never);

    for (let i = 1; i <= 10; i++) {
      manager.addMessage({ role: 'user', content: `msg ${i}` });
    }

    await manager.buildContext();
    await manager.buildContext();

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('handles summary failure gracefully', async () => {
    const manager = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxRecentMessages: 4,
      summaryTrigger: 6,
    });

    mockCreate.mockRejectedValue(new Error('Network error') as never);

    for (let i = 1; i <= 10; i++) {
      manager.addMessage({ role: 'user', content: `msg ${i}` });
    }

    const context = await manager.buildContext();

    expect(context).toHaveLength(6);
    expect(context[1].content).toContain('Summary unavailable');
  });

  it('keeps tool messages paired with their tool calls in summary', async () => {
    const manager = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxRecentMessages: 2,
      summaryTrigger: 4,
    });

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Summary' } }],
    } as never);

    manager.addMessage({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        },
      ],
    });
    manager.addMessage({ role: 'tool', content: '{"content":"hello"}', tool_call_id: 'call_1' });
    manager.addMessage({ role: 'user', content: 'msg' });
    manager.addMessage({ role: 'assistant', content: 'reply' });
    manager.addMessage({ role: 'user', content: 'another' });

    await manager.buildContext();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPrompt = callArgs.messages[1].content;
    expect(userPrompt).toContain('read_file');
    expect(userPrompt).toContain('tool (call_1)');
  });

  it('triggers summarization by token budget, not message count', async () => {
    // Small token budget so a few long messages trigger compression.
    const manager = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxContextTokens: 100,
      recentTokenBudget: 30,
    });

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Summary of old messages.' } }],
    } as never);

    // Add messages with enough text to exceed 100 tokens.
    const longText = 'x'.repeat(200); // ~50 tokens each
    for (let i = 1; i <= 5; i++) {
      manager.addMessage({ role: 'user', content: `Msg ${i}: ${longText}` });
      manager.addMessage({ role: 'assistant', content: `Reply ${i}: ${longText}` });
    }

    const context = await manager.buildContext();

    // Should have called the model for summarization.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Output should be smaller than full history: system + summary + recent window.
    expect(context.length).toBeLessThan(12);
    // System prompt preserved.
    expect(context[0].role).toBe('system');
    // Summary present.
    expect(context.some((m) => m.role === 'system' && m.content.includes('Earlier conversation summary'))).toBe(true);
  });

  it('does not trigger summarization when within token budget', async () => {
    const manager = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxContextTokens: 10000,
      recentTokenBudget: 5000,
    });

    manager.addMessage({ role: 'user', content: 'Hi' });
    manager.addMessage({ role: 'assistant', content: 'Hello' });

    const context = await manager.buildContext();

    expect(context).toHaveLength(3);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('getContextInfo reports token estimate and budget', () => {
    const manager = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxContextTokens: 4096,
      recentTokenBudget: 2048,
    });

    manager.addMessage({ role: 'user', content: '你好世界' });

    const info = manager.getContextInfo();
    expect(info.messageCount).toBe(1);
    expect(info.estimatedTokens).toBeGreaterThan(0);
    expect(info.maxContextTokens).toBe(4096);
    expect(info.recentTokenBudget).toBe(2048);
    expect(info.hasSummary).toBe(false);
  });
});
