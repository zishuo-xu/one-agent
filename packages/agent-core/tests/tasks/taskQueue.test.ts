import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskQueue } from '../../src/tasks/TaskQueue.js';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue({ maxConcurrency: 1 });
  });

  it('creates a pending task', () => {
    const task = queue.enqueue({ message: 'Hello' });
    expect(task.status).toBe('pending');
    expect(task.message).toBe('Hello');
    expect(queue.getPendingCount()).toBe(1);
  });

  it('acquires next task and marks running', () => {
    queue.enqueue({ message: 'Hello' });
    const task = queue.acquireNext();
    expect(task?.status).toBe('running');
    expect(queue.getRunningCount()).toBe(1);
    expect(queue.getPendingCount()).toBe(0);
  });

  it('respects max concurrency', () => {
    queue = new TaskQueue({ maxConcurrency: 2 });
    queue.enqueue({ message: 'First' });
    queue.enqueue({ message: 'Second' });
    queue.enqueue({ message: 'Third' });

    const first = queue.acquireNext();
    const second = queue.acquireNext();
    const third = queue.acquireNext();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeUndefined();
  });

  it('appends events to task', () => {
    const task = queue.enqueue({ message: 'Hello' });
    queue.appendEvent(task.id, { type: 'thought', content: 'Thinking' });
    expect(queue.get(task.id)?.events).toHaveLength(1);
  });

  it('completes a task', () => {
    const task = queue.enqueue({ message: 'Hello' });
    queue.acquireNext();
    queue.complete(task.id, 'Done');
    expect(queue.get(task.id)?.status).toBe('completed');
    expect(queue.get(task.id)?.reply).toBe('Done');
  });

  it('fails a task', () => {
    const task = queue.enqueue({ message: 'Hello' });
    queue.acquireNext();
    queue.fail(task.id, 'Boom');
    expect(queue.get(task.id)?.status).toBe('failed');
    expect(queue.get(task.id)?.error).toBe('Boom');
  });

  it('cancels a pending task', () => {
    const task = queue.enqueue({ message: 'Hello' });
    const cancelled = queue.cancel(task.id);
    expect(cancelled).toBe(true);
    expect(queue.get(task.id)?.status).toBe('cancelled');
  });

  it('returns the same task id for the same idempotencyKey', () => {
    const a = queue.enqueue({ message: 'Hello', idempotencyKey: 'key-1' });
    const b = queue.enqueue({ message: 'Different', idempotencyKey: 'key-1' });
    expect(a.id).toBe(b.id);
    expect(b.message).toBe('Hello');
  });

  it('does not re-queue or clobber the abort controller on duplicate idempotencyKey', () => {
    const enqueued = vi.fn();
    queue.on('enqueued', enqueued);

    const a = queue.enqueue({ message: 'Hello', idempotencyKey: 'key-dup' });
    const controllerBefore = queue.getAbortController(a.id);

    const b = queue.enqueue({ message: 'Duplicate', idempotencyKey: 'key-dup' });

    expect(b.id).toBe(a.id);
    // Still exactly one queued dispatch and one enqueued event.
    expect(queue.getPendingCount()).toBe(1);
    expect(enqueued).toHaveBeenCalledTimes(1);
    // The live AbortController is untouched, so cancel() keeps working.
    expect(queue.getAbortController(a.id)).toBe(controllerBefore);
  });

  it('does not re-execute a completed task when its idempotencyKey is re-submitted', () => {
    const task = queue.enqueue({ message: 'Hello', idempotencyKey: 'key-done' });
    queue.acquireNext();
    queue.complete(task.id, 'Done');
    queue.release(task.id);

    const again = queue.enqueue({ message: 'Hello', idempotencyKey: 'key-done' });

    expect(again.id).toBe(task.id);
    expect(again.status).toBe('completed');
    expect(queue.getPendingCount()).toBe(0);
    expect(queue.get(task.id)?.status).toBe('completed');
  });

  it('creates different tasks for different idempotency keys', () => {
    const a = queue.enqueue({ message: 'Hello', idempotencyKey: 'key-a' });
    const b = queue.enqueue({ message: 'Hello', idempotencyKey: 'key-b' });
    expect(a.id).not.toBe(b.id);
  });

  it('emits enqueued and started events', () => {
    const enqueued = vi.fn();
    const started = vi.fn();
    queue.on('enqueued', enqueued);
    queue.on('started', started);

    const task = queue.enqueue({ message: 'Hello' });
    expect(enqueued).toHaveBeenCalledWith(task);

    queue.acquireNext();
    expect(started).toHaveBeenCalled();
  });
});
