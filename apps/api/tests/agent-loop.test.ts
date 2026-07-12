import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    port: 3000,
    host: '127.0.0.1',
    model: 'gpt-test',
    systemPrompt: 'You are a test assistant.',
    openai: {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    },
  },
}));

import { config } from '../src/config.js';
import { AgentLoop } from '../src/agents/AgentLoop.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

describe('AgentLoop', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns assistant reply and keeps history', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello from assistant' } }],
    } as never);

    const agent = new AgentLoop();
    const reply = await agent.chat('Hi');

    expect(reply).toBe('Hello from assistant');
    expect(agent.getHistory()).toHaveLength(3); // system + user + assistant
    expect(agent.getHistory()[1]).toEqual({ role: 'user', content: 'Hi' });
    expect(agent.getHistory()[2]).toEqual({
      role: 'assistant',
      content: 'Hello from assistant',
    });
  });

  it('uses custom system prompt', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'OK' } }],
    } as never);

    const agent = new AgentLoop({ systemPrompt: 'You are a coder.' });
    await agent.chat('test');

    const history = agent.getHistory();
    expect(history[0]).toEqual({ role: 'system', content: 'You are a coder.' });
  });

  it('retries on failure and eventually throws', async () => {
    mockCreate.mockRejectedValue(new Error('Network error') as never);

    const agent = new AgentLoop({ maxRetries: 1, timeoutMs: 100 });
    await expect(agent.chat('test')).rejects.toThrow(
      'AgentLoop failed after 2 attempt(s): Network error'
    );
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('returns empty string when model returns no content', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: {} }],
    } as never);

    const agent = new AgentLoop();
    const reply = await agent.chat('test');

    expect(reply).toBe('');
  });
});
