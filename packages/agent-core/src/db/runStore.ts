import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { AgentRun, CreateRunInput } from './types.js';
import type { RunCheckpoint } from '../agents/checkpoint.js';

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
  trace_status: AgentRun['traceStatus'];
  dropped_trace_events: number;
  trace_error: string | null;
  checkpoint: string | null;
}

function recoveryPointFromTrace(
  db: Database.Database,
  runId: string,
): RunCheckpoint | undefined {
  const row = db
    .prepare(
      `SELECT event_data FROM trace_events
       WHERE run_id = ? AND event_type = 'recovery_point'
       ORDER BY sequence DESC, created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(runId) as { event_data: string } | undefined;
  if (!row) return undefined;
  try {
    const event = JSON.parse(row.event_data) as {
      type?: string;
      checkpoint?: RunCheckpoint;
    };
    return event.type === 'recovery_point' ? event.checkpoint : undefined;
  } catch {
    return undefined;
  }
}

function rowToAgentRun(row: RunRow, db: Database.Database): AgentRun {
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
    traceStatus: row.trace_status,
    droppedTraceEvents: row.dropped_trace_events,
    traceError: row.trace_error ?? undefined,
    // New runs recover from their ordered Trace. The column is only a
    // backward-compatibility fallback for runs created before recovery_point.
    checkpoint:
      recoveryPointFromTrace(db, row.id) ??
      (row.checkpoint ? JSON.parse(row.checkpoint) : undefined),
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
        `INSERT INTO agent_runs (id, thread_id, task_id, model, start_time, end_time, status, error, reasoning_chain, trace_status, dropped_trace_events, trace_error, checkpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        input.reasoningChain ? JSON.stringify(input.reasoningChain) : null,
        input.traceStatus ?? 'recording',
        input.droppedTraceEvents ?? 0,
        input.traceError ?? null,
        input.checkpoint ? JSON.stringify(input.checkpoint) : null
      );

    return this.getById(id)!;
  }

  getById(id: string): AgentRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE id = ?')
      .get(id) as RunRow | undefined;

    return row ? rowToAgentRun(row, this.db) : undefined;
  }

  getByThread(threadId: string): AgentRun[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY start_time DESC'
      )
      .all(threadId) as RunRow[];

    return rows.map((row) => rowToAgentRun(row, this.db));
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

    if (updates.traceStatus !== undefined) {
      sets.push('trace_status = ?');
      values.push(updates.traceStatus);
    }
    if (updates.droppedTraceEvents !== undefined) {
      sets.push('dropped_trace_events = ?');
      values.push(updates.droppedTraceEvents);
    }
    if (updates.traceError !== undefined) {
      sets.push('trace_error = ?');
      values.push(updates.traceError);
    }
    if (updates.checkpoint !== undefined) {
      sets.push('checkpoint = ?');
      values.push(JSON.stringify(updates.checkpoint));
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

  getRecoverableByThread(threadId: string): AgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE thread_id = ? AND status = 'running'
           AND (
             checkpoint IS NOT NULL OR EXISTS (
               SELECT 1 FROM trace_events
               WHERE trace_events.run_id = agent_runs.id
                 AND trace_events.event_type = 'recovery_point'
             )
           )
         ORDER BY start_time DESC`
      )
      .all(threadId) as RunRow[];
    return rows.map((row) => rowToAgentRun(row, this.db));
  }

  getWaitingByThread(threadId: string): AgentRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE thread_id = ? AND status = 'waiting_for_input'
           AND (
             checkpoint IS NOT NULL OR EXISTS (
               SELECT 1 FROM trace_events
               WHERE trace_events.run_id = agent_runs.id
                 AND trace_events.event_type = 'recovery_point'
             )
           )
         ORDER BY start_time DESC LIMIT 1`
      )
      .get(threadId) as RunRow | undefined;
    return row ? rowToAgentRun(row, this.db) : undefined;
  }

  /** Atomically claim a waiting run so the same answer cannot resume it twice. */
  claimWaiting(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'interrupted', end_time = ?, error = ?
         WHERE id = ? AND status = 'waiting_for_input'`
      )
      .run(new Date().toISOString(), 'User input received; continuation started.', id);
    return result.changes === 1;
  }

  cancelWaiting(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'cancelled', end_time = ?, error = ?
         WHERE id = ? AND status = 'waiting_for_input'`
      )
      .run(new Date().toISOString(), 'Waiting task cancelled by user.', id);
    return result.changes === 1;
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM agent_runs WHERE thread_id = ?').run(threadId);
  }
}
