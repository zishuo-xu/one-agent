import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { RunStore } from '../../src/db/runStore.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { ReasoningStep } from '../../src/planning/types.js';

describe('RunStore', () => {
  let db: Database.Database;
  let threadStore: ThreadStore;
  let store: RunStore;
  let threadId: string;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    threadStore = new ThreadStore(db);
    store = new RunStore(db);
    threadId = threadStore.create({ id: 'thread-1' }).id;
  });

  it('creates a running run', () => {
    const run = store.create({ threadId, model: 'gpt-test' });
    expect(run.threadId).toBe(threadId);
    expect(run.model).toBe('gpt-test');
    expect(run.status).toBe('running');
    expect(run.endTime).toBeNull();
  });

  it('creates a running run with taskId', () => {
    const run = store.create({ threadId, model: 'gpt-test', taskId: 'task-1' });
    expect(run.threadId).toBe(threadId);
    expect(run.taskId).toBe('task-1');
    expect(run.model).toBe('gpt-test');
    expect(run.status).toBe('running');
    expect(run.endTime).toBeNull();
  });

  it('updates run status and reasoning chain', () => {
    const run = store.create({ threadId, model: 'gpt-test' });
    const steps: ReasoningStep[] = [
      { thought: 'think', action: { id: 'a', name: 'tool', arguments: {} }, observation: { success: true } },
    ];

    store.update(run.id, { status: 'completed', reasoningChain: steps });

    const found = store.getById(run.id);
    expect(found?.status).toBe('completed');
    expect(found?.reasoningChain).toEqual(steps);
  });

  it('completes a run', () => {
    const run = store.create({ threadId, model: 'gpt-test' });
    store.complete(run.id);
    const found = store.getById(run.id);
    expect(found?.status).toBe('completed');
    expect(found?.endTime).not.toBeNull();
  });

  it('fails a run', () => {
    const run = store.create({ threadId, model: 'gpt-test' });
    store.fail(run.id, 'Something went wrong');
    const found = store.getById(run.id);
    expect(found?.status).toBe('failed');
    expect(found?.error).toBe('Something went wrong');
  });

  it('lists runs by thread ordered by start_time desc', async () => {
    const first = store.create({ threadId, model: 'gpt-test' });
    store.complete(first.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = store.create({ threadId, model: 'gpt-test' });

    const runs = store.getByThread(threadId);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(second.id);
  });

  it('deletes runs by thread', () => {
    const run = store.create({ threadId, model: 'gpt-test' });
    store.deleteByThread(threadId);
    expect(store.getById(run.id)).toBeUndefined();
  });
});
