import crypto from 'node:crypto';
import { Task, TaskStatus, CreateTaskInput, TaskStore } from './types.js';
import type { AgentEvent } from '../agents/events.js';

function deriveTaskId(idempotencyKey: string): string {
  return crypto.createHash('sha256').update(idempotencyKey).digest('hex');
}

export class TaskStatusStore implements TaskStore {
  private tasks = new Map<string, Task>();
  private idempotencyKeys = new Map<string, string>();

  create(input: CreateTaskInput): Task {
    if (input.idempotencyKey) {
      const existingId = this.idempotencyKeys.get(input.idempotencyKey);
      if (existingId) {
        const existing = this.tasks.get(existingId);
        if (existing) {
          return existing;
        }
      }
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: input.idempotencyKey ? deriveTaskId(input.idempotencyKey) : crypto.randomUUID(),
      threadId: input.threadId,
      message: input.message,
      status: 'pending',
      retryCount: 0,
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    if (input.idempotencyKey) {
      this.idempotencyKeys.set(input.idempotencyKey, task.id);
    }
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getOrThrow(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return task;
  }

  update(id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>): Task {
    const task = this.getOrThrow(id);
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    return task;
  }

  setStatus(id: string, status: TaskStatus): Task {
    return this.update(id, { status });
  }

  appendEvent(id: string, event: AgentEvent): Task {
    const task = this.getOrThrow(id);
    task.events.push(event);
    task.updatedAt = new Date().toISOString();
    return task;
  }

  listByThread(threadId: string): Task[] {
    const tasks: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.threadId === threadId) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  listByStatus(statuses: TaskStatus[]): Task[] {
    const statusSet = new Set(statuses);
    const tasks: Task[] = [];
    for (const task of this.tasks.values()) {
      if (statusSet.has(task.status)) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }
}
