import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { AgentRun, CreateRunInput } from './types.js';

interface RunRow {
  id: string;
  thread_id: string;
  task_id: string | null;
  model: string;
  start_time: string;
  end_time: string | null;
  status: AgentRun['status'];
  error: string | null;
  reasoning_chain: string | null;
}

function rowToAgentRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    threadId: row.thread_id,
    taskId: row.task_id,
    model: row.model,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    error: row.error,
    reasoningChain: row.reasoning_chain ? JSON.parse(row.reasoning_chain) : undefined,
  };
}

export class RunStore {
  constructor(private db: Database.Database) {}

  create(input: CreateRunInput): AgentRun {
    const id = input.id ?? crypto.randomUUID();
    const status = input.status ?? 'running';
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO agent_runs (id, thread_id, task_id, model, start_time, end_time, status, error, reasoning_chain)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.threadId,
        input.taskId ?? null,
        input.model,
        now,
        null,
        status,
        input.error ?? null,
        input.reasoningChain ? JSON.stringify(input.reasoningChain) : null
      );

    return this.getById(id)!;
  }

  getById(id: string): AgentRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE id = ?')
      .get(id) as RunRow | undefined;

    return row ? rowToAgentRun(row) : undefined;
  }

  getByThread(threadId: string): AgentRun[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY start_time DESC'
      )
      .all(threadId) as RunRow[];

    return rows.map(rowToAgentRun);
  }

  update(id: string, updates: Partial<AgentRun>): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }

    if (updates.endTime !== undefined) {
      sets.push('end_time = ?');
      values.push(updates.endTime);
    }

    if (updates.error !== undefined) {
      sets.push('error = ?');
      values.push(updates.error);
    }

    if (updates.reasoningChain !== undefined) {
      sets.push('reasoning_chain = ?');
      values.push(JSON.stringify(updates.reasoningChain));
    }

    if (sets.length === 0) return;

    values.push(id);
    this.db
      .prepare(
        `UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`
      )
      .run(...values);
  }

  complete(id: string): void {
    this.update(id, { status: 'completed', endTime: new Date().toISOString() });
  }

  fail(id: string, error: string): void {
    this.update(id, { status: 'failed', endTime: new Date().toISOString(), error });
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM agent_runs WHERE thread_id = ?').run(threadId);
  }
}
