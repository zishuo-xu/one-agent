import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Task, TaskStatus, CreateTaskInput, TaskStore } from '../tasks/types.js';
import type { AgentEvent } from '../agents/events.js';

interface TaskRow {
  id: string;
  thread_id: string | null;
  message: string;
  status: TaskStatus;
  reply: string | null;
  error: string | null;
  retry_count: number;
  failed_reason: string | null;
  idempotency_key: string | null;
  events: string;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    threadId: row.thread_id ?? undefined,
    message: row.message,
    status: row.status,
    reply: row.reply ?? undefined,
    error: row.error ?? undefined,
    retryCount: row.retry_count,
    failedReason: row.failed_reason ?? undefined,
    events: JSON.parse(row.events) as AgentEvent[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deriveTaskId(idempotencyKey: string): string {
  return crypto.createHash('sha256').update(idempotencyKey).digest('hex');
}

export class SqliteTaskStore implements TaskStore {
  constructor(private db: Database.Database) {}

  create(input: CreateTaskInput): Task {
    if (input.idempotencyKey) {
      const existing = this.db
        .prepare('SELECT * FROM tasks WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as TaskRow | undefined;
      if (existing) {
        return rowToTask(existing);
      }
    }

    const id = input.idempotencyKey ? deriveTaskId(input.idempotencyKey) : crypto.randomUUID();
    const now = new Date().toISOString();
    const status: TaskStatus = 'pending';

    this.db
      .prepare(
        `INSERT INTO tasks (id, thread_id, message, status, reply, error, retry_count, failed_reason, idempotency_key, events, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.threadId ?? null,
        input.message,
        status,
        null,
        null,
        0,
        null,
        input.idempotencyKey ?? null,
        JSON.stringify([]),
        now,
        now
      );

    return this.get(id)!;
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  getOrThrow(id: string): Task {
    const task = this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return task;
  }

  update(id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>): Task {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.message !== undefined) {
      sets.push('message = ?');
      values.push(updates.message);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.reply !== undefined) {
      sets.push('reply = ?');
      values.push(updates.reply);
    }
    if (updates.error !== undefined) {
      sets.push('error = ?');
      values.push(updates.error);
    }
    if (updates.retryCount !== undefined) {
      sets.push('retry_count = ?');
      values.push(updates.retryCount);
    }
    if (updates.failedReason !== undefined) {
      sets.push('failed_reason = ?');
      values.push(updates.failedReason);
    }
    if (updates.events !== undefined) {
      sets.push('events = ?');
      values.push(JSON.stringify(updates.events));
    }

    if (sets.length === 0) return this.getOrThrow(id);

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getOrThrow(id);
  }

  setStatus(id: string, status: TaskStatus): Task {
    return this.update(id, { status });
  }

  appendEvent(id: string, event: AgentEvent): Task {
    const task = this.getOrThrow(id);
    const events = [...task.events, event];
    return this.update(id, { events });
  }

  listByThread(threadId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId) as TaskRow[];
    return rows.map(rowToTask);
  }

  listByStatus(statuses: TaskStatus[]): Task[] {
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...statuses) as TaskRow[];
    return rows.map(rowToTask);
  }

  list(): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM tasks WHERE thread_id = ?').run(threadId);
  }
}
