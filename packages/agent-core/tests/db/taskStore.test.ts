import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { SqliteTaskStore } from '../../src/db/taskStore.js';
import type { AgentLoopEvent } from '../../src/agents/AgentLoop.js';

describe('SqliteTaskStore', () => {
  let db: Database.Database;
  let store: SqliteTaskStore;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    store = new SqliteTaskStore(db);
  });

  it('creates and retrieves a task', () => {
    const task = store.create({ message: 'Hello' });
    expect(task.id).toBeDefined();
    expect(task.status).toBe('pending');
    expect(task.events).toEqual([]);

    const found = store.get(task.id);
    expect(found).toEqual(task);
  });

  it('creates a task with threadId', () => {
    const task = store.create({ message: 'Hello', threadId: 'thread-1' });
    expect(task.threadId).toBe('thread-1');
    expect(store.get(task.id)!.threadId).toBe('thread-1');
  });

  it('updates status and reply', () => {
    const task = store.create({ message: 'Hello' });
    store.update(task.id, { status: 'completed', reply: 'Done' });

    const found = store.get(task.id)!;
    expect(found.status).toBe('completed');
    expect(found.reply).toBe('Done');
  });

  it('appends events', () => {
    const task = store.create({ message: 'Hello' });
    const event: AgentLoopEvent = { type: 'thought', content: 'think' };
    store.appendEvent(task.id, event);

    const found = store.get(task.id)!;
    expect(found.events).toHaveLength(1);
    expect(found.events[0]).toEqual(event);
  });

  it('lists tasks by status', () => {
    const a = store.create({ message: 'a' });
    const b = store.create({ message: 'b' });
    store.setStatus(a.id, 'running');

    const pending = store.listByStatus(['pending']);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(b.id);

    const running = store.listByStatus(['running']);
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe(a.id);
  });

  it('returns the same task when idempotencyKey is reused', () => {
    const task = store.create({ message: 'Hello', idempotencyKey: 'key-1' });
    const duplicate = store.create({ message: 'Different message', idempotencyKey: 'key-1' });

    expect(duplicate.id).toBe(task.id);
    expect(duplicate.message).toBe('Hello');
  });

  it('creates different tasks for different idempotency keys', () => {
    const a = store.create({ message: 'Hello', idempotencyKey: 'key-a' });
    const b = store.create({ message: 'Hello', idempotencyKey: 'key-b' });

    expect(a.id).not.toBe(b.id);
  });

  it('falls back to random UUID when idempotencyKey is not provided', () => {
    const a = store.create({ message: 'Hello' });
    const b = store.create({ message: 'Hello' });

    expect(a.id).not.toBe(b.id);
  });
});
