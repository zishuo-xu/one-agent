import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueWorker } from '../../src/tasks/QueueWorker.js';
import { TaskQueue } from '../../src/tasks/TaskQueue.js';
import { AgentLoop } from '../../src/agents/AgentLoop.js';
import { AgentLoopEvent } from '../../src/agents/AgentLoop.js';

describe('QueueWorker', () => {
  let queue: TaskQueue;
  let worker: QueueWorker;
  let createAgent: (options: { threadId?: string; signal?: AbortSignal }) => AgentLoop;

  beforeEach(() => {
    queue = new TaskQueue({ maxConcurrency: 1 });
    createAgent = vi.fn(({ signal }) => {
      const agent = new AgentLoop({ enablePlanning: false, systemPrompt: 'test', signal });
      // Replace chat to make it deterministic and fast.
      vi.spyOn(agent, 'chat').mockResolvedValue({ reply: 'Done', events: [] });
      return agent;
    }) as typeof createAgent;
    worker = new QueueWorker({ queue, createAgent });
  });

  afterEach(() => {
    worker.stop();
  });

  it('processes a task and marks it completed', async () => {
    const task = queue.enqueue({ message: 'Hello' });
    worker.start();

    await new Promise<void>((resolve) => {
      queue.once('completed', (completedTask) => {
        if (completedTask.id === task.id) resolve();
      });
    });

    expect(queue.get(task.id)?.reply).toBe('Done');
  });

  it('forwards agent events to queue', async () => {
    createAgent = vi.fn(({ signal }) => {
      const agent = new AgentLoop({ enablePlanning: false, systemPrompt: 'test', signal });
      vi.spyOn(agent, 'chat').mockImplementation(async function (this: AgentLoop) {
        this.emit('event', { type: 'tool_call', toolCall: { id: 'c1', name: 'echo', arguments: {} } });
        this.emit('event', { type: 'tool_result', toolResult: { success: true } });
        this.emit('event', { type: 'message', content: 'Done' });
        return { reply: 'Done', events: [] };
      });
      return agent;
    }) as typeof createAgent;

    worker = new QueueWorker({ queue, createAgent });
    const task = queue.enqueue({ message: 'Hello' });
    worker.start();

    await vi.waitFor(() => queue.get(task.id)?.status === 'completed', { timeout: 1000 });
    expect(queue.get(task.id)?.events.some((e) => e.type === 'tool_call')).toBe(true);
  });

  it('marks task dead_letter on chat error when maxRetries is 0', async () => {
    createAgent = vi.fn(({ signal }) => {
      const agent = new AgentLoop({ enablePlanning: false, systemPrompt: 'test', signal });
      vi.spyOn(agent, 'chat').mockRejectedValue(new Error('Agent failed'));
      return agent;
    }) as typeof createAgent;

    queue = new TaskQueue({ maxConcurrency: 1, maxRetries: 0 });
    worker = new QueueWorker({ queue, createAgent });
    const task = queue.enqueue({ message: 'Hello' });
    worker.start();

    await new Promise<void>((resolve) => {
      queue.once('dead_letter', (failedTask) => {
        if (failedTask.id === task.id) resolve();
      });
    });

    expect(queue.get(task.id)?.status).toBe('dead_letter');
    expect(queue.get(task.id)?.error).toBe('Agent failed');
  });

  it('cancels a running task', async () => {
    createAgent = vi.fn(({ signal }) => {
      const agent = new AgentLoop({ enablePlanning: false, systemPrompt: 'test', signal });
      vi.spyOn(agent, 'chat').mockImplementation(async function (this: AgentLoop) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        this.emit('event', { type: 'message', content: 'Done' } as AgentLoopEvent);
        return { reply: 'Done', events: [] };
      });
      return agent;
    }) as typeof createAgent;

    worker = new QueueWorker({ queue, createAgent });
    const task = queue.enqueue({ message: 'Hello' });
    worker.start();

    await vi.waitFor(() => queue.get(task.id)?.status === 'running', { timeout: 1000 });
    queue.cancel(task.id);
    await vi.waitFor(() => queue.get(task.id)?.status === 'cancelled', { timeout: 1000 });
  });

  it('retries a failed task and marks it completed on success', async () => {
    let attempts = 0;
    createAgent = vi.fn(({ signal }) => {
      const agent = new AgentLoop({ enablePlanning: false, systemPrompt: 'test', signal });
      vi.spyOn(agent, 'chat').mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('First attempt failed');
        }
        return { reply: 'Done', events: [] };
      });
      return agent;
    }) as typeof createAgent;

    queue = new TaskQueue({ maxConcurrency: 1, maxRetries: 3, retryDelayMs: 50 });
    worker = new QueueWorker({ queue, createAgent });
    const task = queue.enqueue({ message: 'Hello' });
    worker.start();

    await new Promise<void>((resolve) => {
      queue.once('completed', (completedTask) => {
        if (completedTask.id === task.id) resolve();
      });
    });

    expect(attempts).toBe(2);
    expect(queue.get(task.id)?.status).toBe('completed');
    expect(queue.get(task.id)?.reply).toBe('Done');
    expect(queue.get(task.id)?.retryCount).toBe(1);
  });
});
