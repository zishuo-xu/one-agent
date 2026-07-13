import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { MessageStore } from '../../src/db/messageStore.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { Message } from '../../src/agents/types.js';

describe('MessageStore', () => {
  let db: Database.Database;
  let threadStore: ThreadStore;
  let store: MessageStore;
  let threadId: string;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    threadStore = new ThreadStore(db);
    store = new MessageStore(db);
    threadId = threadStore.create({ id: 'thread-1' }).id;
  });

  it('saves and retrieves a message', () => {
    const message: Message = { role: 'user', content: 'Hello' };
    const saved = store.save(threadId, message);
    expect(saved.role).toBe('user');
    expect(saved.content).toBe('Hello');

    const found = store.getById(saved.id);
    expect(found).toEqual(saved);
  });

  it('saves a message with tool calls', () => {
    const message: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
        },
      ],
    };
    const saved = store.save(threadId, message);
    expect(saved.toolCalls).toContain('read_file');
  });

  it('lists messages by thread in ascending order', () => {
    store.save(threadId, { role: 'user', content: 'First' });
    store.save(threadId, { role: 'assistant', content: 'Second' });

    const messages = store.getByThread(threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('deletes messages by thread', () => {
    const saved = store.save(threadId, { role: 'user', content: 'Hello' });
    store.deleteByThread(threadId);
    expect(store.getById(saved.id)).toBeUndefined();
    expect(store.getByThread(threadId)).toHaveLength(0);
  });
});
