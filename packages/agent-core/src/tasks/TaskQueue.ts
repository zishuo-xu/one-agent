import { EventEmitter } from 'node:events';
import { Task, TaskStatus, CreateTaskInput, TaskStore } from './types.js';
import type { AgentEvent } from '../agents/events.js';
import { TaskStatusStore } from './TaskStatusStore.js';

export interface TaskQueueOptions {
  maxConcurrency?: number;
  store?: TaskStore;
  taskTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface QueuedTask {
  task: Task;
  abortController: AbortController;
}

export class TaskQueue extends EventEmitter {
  private readonly tasks = new Map<string, QueuedTask>();
  private readonly pending: string[] = [];
  private readonly running = new Set<string>();
  private readonly store: TaskStore;
  private readonly maxConcurrency: number;
  private readonly taskTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: TaskQueueOptions = {}) {
    super();
    this.store = options.store ?? new TaskStatusStore();
    this.maxConcurrency = options.maxConcurrency ?? 1;
    this.taskTimeoutMs = options.taskTimeoutMs ?? 300000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  enqueue(input: CreateTaskInput): Task {
    const task = this.store.create(input);
    // Duplicate idempotency key: the store returned the pre-existing task
    // instead of creating a fresh one (fresh tasks are always 'pending').
    // Do not re-queue it — that would re-execute the work and clobber the
    // live AbortController, leaving cancel() aborting a controller that
    // nothing is listening to.
    if (this.tasks.has(task.id) || task.status !== 'pending') {
      return { ...task };
    }
    const abortController = new AbortController();
    this.tasks.set(task.id, { task, abortController });
    this.pending.push(task.id);
    this.emit('enqueued', task);
    // Defer dispatch so callers can capture the initial pending state.
    process.nextTick(() => this.tryDispatch());
    return { ...task };
  }

  get(id: string): Task | undefined {
    return this.store.get(id);
  }

  getAbortController(id: string): AbortController | undefined {
    return this.tasks.get(id)?.abortController;
  }

  list(): Task[] {
    return this.store.list();
  }

  listByThread(threadId: string): Task[] {
    return this.store.listByThread(threadId);
  }

  listByStatus(statuses: TaskStatus[]): Task[] {
    return this.store.listByStatus(statuses);
  }

  acquireNext(): Task | undefined {
    if (this.running.size >= this.maxConcurrency || this.pending.length === 0) {
      return undefined;
    }

    const id = this.pending.shift();
    if (!id) return undefined;

    const entry = this.tasks.get(id);
    if (!entry) return undefined;

    this.store.setStatus(id, 'running');
    this.running.add(id);
    const fresh = this.store.get(id)!;
    entry.task = fresh;
    this.emit('started', fresh);
    return fresh;
  }

  release(id: string): void {
    this.running.delete(id);
    this.tryDispatch();
  }

  appendEvent(id: string, event: AgentEvent): void {
    this.store.appendEvent(id, event);
    const task = this.store.get(id);
    if (task) {
      this.emit('event', { taskId: id, event });
    }
  }

  complete(id: string, reply: string): void {
    this.store.update(id, { status: 'completed', reply });
    const task = this.store.get(id);
    if (task) {
      this.emit('completed', task);
    }
  }

  fail(id: string, error: string): void {
    this.store.update(id, { status: 'failed', error });
    const task = this.store.get(id);
    if (task) {
      this.emit('failed', task, error);
    }
  }

  cancel(id: string): boolean {
    const entry = this.tasks.get(id);
    if (!entry) return false;

    const task = entry.task;
    if (task.status === 'running') {
      entry.abortController.abort();
      this.store.setStatus(id, 'cancelled');
      const fresh = this.store.get(id)!;
      this.emit('cancelled', fresh);
      return true;
    }

    if (task.status === 'pending') {
      const index = this.pending.indexOf(id);
      if (index >= 0) {
        this.pending.splice(index, 1);
      }
      this.store.setStatus(id, 'cancelled');
      const fresh = this.store.get(id)!;
      this.emit('cancelled', fresh);
      return true;
    }

    return false;
  }

  retry(id: string): boolean {
    const task = this.store.get(id);
    if (!task || task.status === 'completed' || task.status === 'cancelled') {
      return false;
    }

    const retryCount = task.retryCount + 1;
    this.store.update(id, { status: 'pending', retryCount, error: undefined });

    const entry = this.tasks.get(id);
    if (entry) {
      entry.abortController = new AbortController();
      entry.task = this.store.get(id)!;
    } else {
      this.tasks.set(id, {
        task: this.store.get(id)!,
        abortController: new AbortController(),
      });
    }

    this.pending.push(id);
    this.emit('enqueued', this.store.get(id)!);
    process.nextTick(() => this.tryDispatch());
    return true;
  }

  deadLetter(id: string, error: string): void {
    this.store.update(id, { status: 'dead_letter', error, failedReason: error });
    const task = this.store.get(id);
    if (task) {
      this.emit('dead_letter', task, error);
    }
  }

  restore(task: Task): void {
    if (this.tasks.has(task.id)) return;
    // A task that was 'running' when the process died never finished:
    // requeue it as pending rather than leaking its concurrency slot forever
    // (with maxConcurrency=1 a leaked slot jams the whole queue).
    if (task.status === 'running') {
      this.store.setStatus(task.id, 'pending');
      task = this.store.get(task.id)!;
    }
    const abortController = new AbortController();
    this.tasks.set(task.id, { task, abortController });
    if (task.status === 'pending') {
      this.pending.push(task.id);
      this.emit('ready');
    }
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  getTaskTimeoutMs(): number {
    return this.taskTimeoutMs;
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }

  getRetryDelayMs(): number {
    return this.retryDelayMs;
  }

  private tryDispatch(): void {
    if (this.pending.length === 0) return;
    if (this.running.size >= this.maxConcurrency) return;
    this.emit('ready');
  }
}
