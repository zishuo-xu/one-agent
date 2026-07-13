import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { MemoryStore } from '../../src/db/memoryStore.js';

describe('MemoryStore', () => {
  let db: Database.Database;
  let store: MemoryStore;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    store = new MemoryStore(db);
  });

  it('creates and retrieves a memory', () => {
    const memory = store.create({ key: 'language', value: 'Chinese', source: 'test' });
    expect(memory.key).toBe('language');
    expect(memory.value).toBe('Chinese');
    expect(memory.source).toBe('test');

    const found = store.getById(memory.id);
    expect(found).toEqual(memory);
  });

  it('lists all memories ordered by updated_at desc', () => {
    const first = store.create({ key: 'a', value: '1' });
    const second = store.create({ key: 'b', value: '2' });

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(second.id);
    expect(list[1].id).toBe(first.id);
  });

  it('retrieves relevant memories by keyword', () => {
    const m1 = store.create({ key: 'preferred language', value: 'Chinese' });
    store.create({ key: 'project stack', value: 'TypeScript' });
    const m3 = store.create({ key: 'timezone', value: 'Beijing' });

    const relevant = store.getRelevantMemories('What language do I prefer?');
    const ids = relevant.map((m) => m.id);
    expect(ids).toContain(m1.id);
    expect(ids).not.toContain(m3.id);
  });

  it('returns empty array for irrelevant or short queries', () => {
    store.create({ key: 'language', value: 'Chinese' });
    expect(store.getRelevantMemories('is it')).toEqual([]);
    expect(store.getRelevantMemories('a', 0)).toEqual([]);
  });

  it('updates a memory', () => {
    const memory = store.create({ key: 'language', value: 'Chinese' });
    store.update(memory.id, { value: 'Mandarin' });

    const found = store.getById(memory.id)!;
    expect(found.value).toBe('Mandarin');
    expect(found.key).toBe('language');
  });

  it('deletes a memory by id', () => {
    const memory = store.create({ key: 'language', value: 'Chinese' });
    store.deleteById(memory.id);
    expect(store.getById(memory.id)).toBeUndefined();
  });

  it('optionally links a memory to a thread', () => {
    const memory = store.create({ key: 'language', value: 'Chinese', threadId: 'thread-1' });
    expect(memory.threadId).toBe('thread-1');
  });
});
