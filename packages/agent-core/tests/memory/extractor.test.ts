import { describe, expect, it, vi } from 'vitest';
import { MemoryExtractor } from '../../src/memory/MemoryExtractor.js';
import type { ModelProvider, ModelRequest } from '../../src/model/types.js';

const current = {
  global: '# Global Memory\n',
  workspace: '# Workspace Memory\n',
};

const messages = [
  { id: 'a1', role: 'assistant' as const, content: 'Should this project use pnpm?', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'u1', role: 'user' as const, content: '可以，我认同。', createdAt: '2026-01-01T00:00:01Z' },
];

function provider(content: string) {
  const complete = vi.fn(async (_request: ModelRequest) => ({ content }));
  return {
    complete,
    provider: {
      name: 'memory-test', model: 'memory-test',
      capabilities: { streaming: 'native', toolCalling: 'native', structuredOutput: 'native', reasoning: 'none' },
      complete,
      async *stream() { yield { content: '' }; },
    } as ModelProvider,
  };
}

describe('MemoryExtractor', () => {
  it('updates complete documents and includes assistant context', async () => {
    const mock = provider(JSON.stringify({
      globalMemory: '# Global Memory\n\n- Prefer Chinese.',
      workspaceMemory: '# Workspace Memory\n\n- Use pnpm.',
    }));
    const result = await new MemoryExtractor({ modelProvider: mock.provider }).extract(messages, current);
    expect(result.workspace).toContain('Use pnpm');
    const request = mock.complete.mock.calls[0][0] as ModelRequest;
    expect(request.jsonMode).toBe(true);
    expect(request.messages[1].content).toContain('Should this project use pnpm?');
    expect(request.messages[1].content).toContain('可以，我认同。');
  });

  it('returns current documents without a user-authored message', async () => {
    const mock = provider('not used');
    const result = await new MemoryExtractor({ modelProvider: mock.provider }).extract([
      { ...messages[0] },
    ], current);
    expect(result).toEqual(current);
    expect(mock.complete).not.toHaveBeenCalled();
  });

  it('rejects malformed envelopes and credentials', async () => {
    const malformed = provider('{"memories":[]}');
    await expect(new MemoryExtractor({ modelProvider: malformed.provider }).extract(messages, current))
      .rejects.toThrow();
    const secret = provider(JSON.stringify({
      globalMemory: '# Global Memory\n\n- token sk-abcdefghijklmnop',
      workspaceMemory: '# Workspace Memory',
    }));
    await expect(new MemoryExtractor({ modelProvider: secret.provider }).extract(messages, current))
      .rejects.toThrow('Credentials and secrets');
  });
});
