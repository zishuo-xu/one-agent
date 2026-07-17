import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { MemoryStore } from '../../src/db/memoryStore.js';
import { MemoryExtractor } from '../../src/memory/MemoryExtractor.js';
import { AgentLoop } from '../../src/agents/AgentLoop.js';

vi.mock('../../src/config.js', () => ({
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

import { config } from '../../src/config.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

describe('AgentLoop memory integration', () => {
  let db: Database.Database;
  let threadStore: ThreadStore;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    threadStore = new ThreadStore(db);
    memoryStore = new MemoryStore(db);
    mockCreate.mockReset();
  });

  it('extracts and recalls memories across different threads', async () => {
    const memoryExtractor = new MemoryExtractor();
    vi.spyOn(memoryExtractor, 'extract').mockResolvedValue([
      { key: 'preferred language', value: 'Chinese' },
    ]);

    const firstThread = threadStore.create({ id: 'thread-1' }).id;
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Got it.' } }],
    } as never);

    const firstAgent = new AgentLoop({
      enablePlanning: false,
      threadId: firstThread,
      db,
      memoryStore,
      memoryExtractor,
      awaitMemoryExtraction: true,
    });

    const { reply: firstReply } = await firstAgent.chat('I prefer Chinese.');
    expect(firstReply).toBe('Got it.');
    expect(memoryExtractor.extract).toHaveBeenCalledWith('I prefer Chinese.', 'Got it.');

    const memories = memoryStore.list();
    expect(memories).toHaveLength(1);
    expect(memories[0].key).toBe('preferred language');
    expect(memories[0].value).toBe('Chinese');

    // New thread should still recall the globally stored memory.
    const secondThread = threadStore.create({ id: 'thread-2' }).id;
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'You prefer Chinese.' } }],
    } as never);

    const secondAgent = new AgentLoop({
      enablePlanning: false,
      threadId: secondThread,
      db,
      memoryStore,
    });

    const { reply: secondReply } = await secondAgent.chat('What language do I prefer?');
    expect(secondReply).toBe('You prefer Chinese.');
  });

  it('recalls Chinese memories across threads (unsegmented query hits via bigrams)', async () => {
    memoryStore.create({ key: '最喜欢的编程语言', value: 'Rust', source: 'extracted' });

    const secondThread = threadStore.create({ id: 'thread-cjk' }).id;
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '你最喜欢的编程语言是 Rust。' } }],
    } as never);

    const agent = new AgentLoop({
      enablePlanning: false,
      threadId: secondThread,
      db,
      memoryStore,
    });

    await agent.chat('我最喜欢的编程语言是什么？');

    // The stored Chinese fact must be injected into the model call context.
    const params = mockCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const contextText = params.messages.map((m) => m.content).join('\n');
    expect(contextText).toContain('最喜欢的编程语言');
    expect(contextText).toContain('Rust');
  });
});
