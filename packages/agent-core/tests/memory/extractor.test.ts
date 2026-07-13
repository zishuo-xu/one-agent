import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryExtractor } from '../../src/memory/MemoryExtractor.js';

vi.mock('../../src/config.js', () => ({
  config: {
    model: 'glm-5.2',
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

describe('MemoryExtractor', () => {
  beforeEach(() => {
    vi.mocked(config.openai.chat.completions.create).mockReset();
  });

  it('extracts facts from a JSON array response', async () => {
    vi.mocked(config.openai.chat.completions.create).mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { key: 'preferred language', value: 'Chinese' },
              { key: 'name', value: 'Alice' },
            ]),
          },
        },
      ],
    } as never);

    const extractor = new MemoryExtractor();
    const facts = await extractor.extract('I prefer Chinese.', 'Got it.');

    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({ key: 'preferred language', value: 'Chinese' });
    expect(facts[1]).toEqual({ key: 'name', value: 'Alice' });
  });

  it('strips markdown code fences before parsing', async () => {
    vi.mocked(config.openai.chat.completions.create).mockResolvedValue({
      choices: [
        {
          message: {
            content: '```json\n' + JSON.stringify([{ key: 'language', value: 'Chinese' }]) + '\n```',
          },
        },
      ],
    } as never);

    const extractor = new MemoryExtractor();
    const facts = await extractor.extract('I prefer Chinese.', 'OK.');
    expect(facts).toEqual([{ key: 'language', value: 'Chinese' }]);
  });

  it('returns empty array when the model returns invalid JSON', async () => {
    vi.mocked(config.openai.chat.completions.create).mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    } as never);

    const extractor = new MemoryExtractor();
    const facts = await extractor.extract('Hello.', 'Hi.');
    expect(facts).toEqual([]);
  });

  it('returns empty array when the model call fails', async () => {
    vi.mocked(config.openai.chat.completions.create).mockRejectedValue(new Error('timeout') as never);

    const extractor = new MemoryExtractor();
    const facts = await extractor.extract('Hello.', 'Hi.');
    expect(facts).toEqual([]);
  });

  it('filters out items with empty key or value', async () => {
    vi.mocked(config.openai.chat.completions.create).mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { key: '', value: 'Chinese' },
              { key: 'valid', value: 'kept' },
              { key: 'name', value: '' },
            ]),
          },
        },
      ],
    } as never);

    const extractor = new MemoryExtractor();
    const facts = await extractor.extract('Hello.', 'Hi.');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({ key: 'valid', value: 'kept' });
  });
});
