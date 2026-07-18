import { AgentLoop } from '../agents/AgentLoop.js';
import type { AgentEvent } from '../agents/events.js';
import { TaskQueue } from './TaskQueue.js';
import { Task } from './types.js';

export type AgentLoopFactory = (options: { threadId?: string; taskId?: string; signal?: AbortSignal }) => AgentLoop;

export interface QueueWorkerOptions {
  queue: TaskQueue;
  createAgent: AgentLoopFactory;
}

export class QueueWorker {
  private readonly queue: TaskQueue;
  private readonly createAgent: AgentLoopFactory;
  private started = false;

  constructor(options: QueueWorkerOptions) {
    this.queue = options.queue;
    this.createAgent = options.createAgent;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.queue.on('ready', () => this.processNext());
    // Kick off any already-enqueued tasks.
    this.processNext();
  }

  stop(): void {
    this.started = false;
    for (const id of this.queue.list()) {
      const controller = this.queue.getAbortController(id.id);
      if (controller) {
        controller.abort();
      }
    }
  }

  private handleRetryableFailure(task: Task, error: string): void {
    const fresh = this.queue.get(task.id);
    if (!fresh) {
      this.queue.fail(task.id, error);
      return;
    }

    if (fresh.retryCount < this.queue.getMaxRetries()) {
      const delay = this.queue.getRetryDelayMs() * Math.pow(2, fresh.retryCount);
      setTimeout(() => {
        this.queue.retry(task.id);
      }, delay);
    } else {
      this.queue.deadLetter(task.id, error);
    }
  }

  private processNext(): void {
    if (!this.started) return;

    const task = this.queue.acquireNext();
    if (!task) return;

    // Run in background without awaiting; errors are handled inside runTask.
    this.runTask(task).catch(() => {
      // Suppress unhandled rejection; runTask emits failures.
    });

    // Try to acquire more if concurrency allows.
    if (this.queue.getRunningCount() < this.queue.getMaxConcurrency()) {
      this.processNext();
    }
  }

  private async runTask(task: Task): Promise<void> {
    const controller = this.queue.getAbortController(task.id);
    if (!controller) {
      this.queue.fail(task.id, 'Missing abort controller');
      this.queue.release(task.id);
      this.processNext();
      return;
    }

    const agent = this.createAgent({
      threadId: task.threadId,
      taskId: task.id,
      signal: controller.signal,
    });

    const onAgentEvent = (event: AgentEvent) => {
      this.queue.appendEvent(task.id, event);
    };

    const taskTimeoutMs = this.queue.getTaskTimeoutMs();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('Task timeout'));
      }, taskTimeoutMs);
    });

    try {
      agent.on('event', onAgentEvent);
      const { reply } = await Promise.race([agent.chat(task.message), timeoutPromise]);
      clearTimeout(timeoutId);
      this.queue.complete(task.id, reply);
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : String(error);
      if (timedOut || !controller.signal.aborted) {
        this.handleRetryableFailure(task, message);
      } else {
        this.queue.cancel(task.id);
      }
    } finally {
      agent.off('event', onAgentEvent);
      this.queue.release(task.id);
      this.processNext();
    }
  }
}
