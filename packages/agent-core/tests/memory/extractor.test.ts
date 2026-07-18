import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryExtractor } from '../../src/memory/MemoryExtractor.js';

vi.mock('../../src/config.js', () => ({
  config: {
    model: 'glm-5.2',
    openai: { chat: { completions: { create: vi.fn() } } },
  },
}));

import { config } from '../../src/config.js';

const source = [{ id: 'message-1', content: '以后请用中文回答我。', createdAt: '2026-07-18T10:00:00.000Z' }];
const candidate = {
  key: '回答语言偏好',
  value: '用户希望使用中文回答',
  kind: 'user_preference',
  scope: 'global',
  confidence: 0.95,
  explicit: true,
  sourceMessageId: 'message-1',
};

describe('MemoryExtractor', () => {
  beforeEach(() => vi.mocked(config.openai.chat.completions.create).mockReset());

  it('extracts evidence-linked candidates from all supplied user messages', async () => {
    vi.mocked(config.openai.chat.completions.create).mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([candidate]) } }],
    } as never);

    const facts = await new MemoryExtractor().extract(source);
    expect(facts).toEqual([candidate]);
    const request = vi.mocked(config.openai.chat.completions.create).mock.calls[0][0] as {
      messages: Array<{ content: string }>;
    };
    expect(request.messages[1].content).toContain('message-1');
    expect(request.messages[1].content).toContain('以后请用中文回答我');
  });

  it('accepts an empty array as a successful no-memory result', async () => {
    vi.mocked(config.openai.chat.completions.create).mockResolvedValue({
      choices: [{ message: { content: '```json\n[]\n```' } }],
    } as never);
    await expect(new MemoryExtractor().extract(source)).resolves.toEqual([]);
  });

  it('rejects invalid JSON so the thread remains unextracted', async () => {
    vi.mocked(config.openai.chat.completions.create).mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    } as never);
    await expect(new MemoryExtractor().extract(source)).rejects.toThrow();
  });

  it('propagates model failures so startup recovery can retry', async () => {
    const extractor = new MemoryExtractor({
      modelProvider: {
        name: 'failing',
        model: 'failing-model',
        complete: async () => { throw new Error('timeout'); },
        stream: async function* () { yield {}; },
      },
    });
    await expect(extractor.extract(source)).rejects.toThrow('timeout');
  });

  it('rejects candidates whose evidence is not one of the supplied messages', async () => {
    vi.mocked(config.openai.chat.completions.create).mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ ...candidate, sourceMessageId: 'invented' }]) } }],
    } as never);
    await expect(new MemoryExtractor().extract(source)).rejects.toThrow('Invalid memory candidate');
  });
});
