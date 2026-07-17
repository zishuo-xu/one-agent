import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { SqliteTaskStore } from '../../src/db/taskStore.js';
import { TaskQueue } from '../../src/tasks/TaskQueue.js';
import { QueueWorker } from '../../src/tasks/QueueWorker.js';
import { AgentLoop } from '../../src/agents/AgentLoop.js';
import type { AgentLoopEvent } from '../../src/agents/AgentLoop.js';

describe('TaskQueue with SqliteTaskStore', () => {
  let db: Database.Database;
  let store: SqliteTaskStore;
  let queue: TaskQueue;
  let worker: QueueWorker;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    store = new SqliteTaskStore(db);
    queue = new TaskQueue({ store, maxConcurrency: 1 });

    const createAgent = vi.fn(({ signal }: { threadId?: string; signal?: AbortSignal }) => {
      const agent = new AgentLoop({ enablePlanning: false, systemPrompt: 'test', signal });
      vi.spyOn(agent, 'chat').mockImplementation(async function (this: AgentLoop) {
        this.emit('event', { type: 'tool_call', toolCall: { id: 'c1', name: 'echo', arguments: {} } });
        this.emit('event', { type: 'tool_result', toolResult: { success: true } });
        this.emit('event', { type: 'message', content: 'Done' } as AgentLoopEvent);
        return { reply: 'Done', events: [] };
      });
      return agent;
    });

    worker = new QueueWorker({ queue, createAgent: createAgent as never });
  });

  afterEach(() => {
    worker.stop();
  });

  it('persists task through queue lifecycle', async () => {
    const task = queue.enqueue({ message: 'Hi' });
    worker.start();

    await new Promise<void>((resolve) => {
      queue.once('completed', (completedTask) => {
        if (completedTask.id === task.id) resolve();
      });
    });

    const persisted = store.get(task.id)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.reply).toBe('Done');
  });

  it('restores pending tasks and dispatches them', async () => {
    // Create a task directly in the store, simulating a pre-existing pending task.
    const task = store.create({ message: 'Restored task' });

    // Create a new queue that restores the persisted task.
    const restoredQueue = new TaskQueue({ store, maxConcurrency: 1 });
    restoredQueue.restore(task);

    const createAgent = vi.fn(({ signal }: { threadId?: string; signal?: AbortSignal }) => {
      const agent = new AgentLoop({ enablePlanning: false, systemPrompt: 'test', signal });
      vi.spyOn(agent, 'chat').mockResolvedValue({ reply: 'Done', events: [] });
      return agent;
    });

    const restoredWorker = new QueueWorker({ queue: restoredQueue, createAgent: createAgent as never });
    restoredWorker.start();

    await new Promise<void>((resolve) => {
      restoredQueue.once('completed', (completedTask) => {
        if (completedTask.id === task.id) resolve();
      });
    });

    const persisted = store.get(task.id)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.reply).toBe('Done');

    restoredWorker.stop();
  });

  it('requeues tasks that were running when the process died (no slot leak)', async () => {
    // Simulate a crash: a task persisted mid-execution with status 'running'.
    const crashed = store.create({ message: 'Crashed task' });
    store.setStatus(crashed.id, 'running');

    const restoredQueue = new TaskQueue({ store, maxConcurrency: 1 });
    restoredQueue.restore(store.get(crashed.id)!);

    // The crashed task is requeued as pending, not parked in a running slot.
    expect(restoredQueue.getRunningCount()).toBe(0);
    expect(restoredQueue.getPendingCount()).toBe(1);
    expect(store.get(crashed.id)!.status).toBe('pending');

    // ...and it actually dispatches to completion.
    const createAgent = vi.fn(({ signal }: { threadId?: string; signal?: AbortSignal }) => {
      const agent = new AgentLoop({ enablePlanning: false, systemPrompt: 'test', signal });
      vi.spyOn(agent, 'chat').mockResolvedValue({ reply: 'Recovered', events: [] });
      return agent;
    });
    const restoredWorker = new QueueWorker({ queue: restoredQueue, createAgent: createAgent as never });
    restoredWorker.start();

    await new Promise<void>((resolve) => {
      restoredQueue.once('completed', (completedTask) => {
        if (completedTask.id === crashed.id) resolve();
      });
    });

    expect(store.get(crashed.id)!.status).toBe('completed');
    expect(store.get(crashed.id)!.reply).toBe('Recovered');

    restoredWorker.stop();
  });

  it('appends events to the persisted task', async () => {
    const task = queue.enqueue({ message: 'What time is it?' });
    worker.start();

    await new Promise<void>((resolve) => {
      queue.once('completed', (completedTask) => {
        if (completedTask.id === task.id) resolve();
      });
    });

    const persisted = store.get(task.id)!;
    expect(persisted.events.some((e: AgentLoopEvent) => e.type === 'tool_call')).toBe(true);
  });
});
