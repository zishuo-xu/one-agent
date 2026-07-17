import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { ThreadStore } from '../../src/db/threadStore.js';

describe('ThreadStore', () => {
  let db: Database.Database;
  let store: ThreadStore;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    store = new ThreadStore(db);
  });

  it('creates a thread with generated UUID', () => {
    const thread = store.create();
    expect(thread.id).toBeDefined();
    expect(thread.title).toBeNull();
    expect(thread.createdAt).toBeDefined();
    expect(thread.updatedAt).toBeDefined();
  });

  it('creates a thread with provided id and title', () => {
    const thread = store.create({ id: 'thread-1', title: 'Test thread' });
    expect(thread.id).toBe('thread-1');
    expect(thread.title).toBe('Test thread');
  });

  it('gets a thread by id', () => {
    const created = store.create({ id: 'thread-1', title: 'Test' });
    const found = store.getById('thread-1');
    expect(found).toEqual(created);
  });

  it('returns undefined for unknown thread', () => {
    const found = store.getById('unknown');
    expect(found).toBeUndefined();
  });

  it('lists threads ordered by updated_at desc', () => {
    const first = store.create({ id: 'a', title: 'First' });
    const second = store.create({ id: 'b', title: 'Second' });
    store.updateTimestamp(first.id);

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(first.id);
  });

  it('updates title', () => {
    const thread = store.create({ id: 'thread-1' });
    store.updateTitle(thread.id, 'Updated title');
    const found = store.getById(thread.id);
    expect(found?.title).toBe('Updated title');
  });

  it('deletes a thread', () => {
    const thread = store.create({ id: 'thread-1' });
    store.delete(thread.id);
    expect(store.getById(thread.id)).toBeUndefined();
  });

  it('normalizes SQLite UTC wall-clock timestamps to explicit UTC ISO', () => {
    // datetime('now') stores 'YYYY-MM-DD HH:MM:SS' (UTC, no zone marker);
    // the mapper must expose an unambiguous ISO string so Date parsing
    // is correct in any host timezone.
    const before = Date.now();
    const thread = store.create({ id: 'thread-utc' });
    const after = Date.now();

    expect(thread.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const parsed = new Date(thread.createdAt).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });
});
