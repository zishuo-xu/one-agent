import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { TraceEvent, CreateTraceEventInput } from './types.js';
import { sanitizeTraceEvent } from '../agents/traceSanitizer.js';

interface TraceEventRow {
  id: string;
  run_id: string | null;
  task_id: string | null;
  thread_id: string | null;
  event_type: string;
  event_data: string;
  model: string | null;
  sequence: number;
  created_at: string;
}

function rowToTraceEvent(row: TraceEventRow): TraceEvent {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    threadId: row.thread_id,
    eventType: row.event_type,
    // Public Trace consumers never receive raw secrets from durable recovery
    // points. Recovery itself is an internal RunStore read of the same row.
    eventData: sanitizeTraceEvent(JSON.parse(row.event_data) as TraceEvent['eventData']),
    model: row.model,
    sequence: row.sequence,
    createdAt: row.created_at,
  };
}

export class TraceEventStore {
  constructor(private db: Database.Database) {}

  create(input: CreateTraceEventInput): TraceEvent {
    const id = input.id ?? crypto.randomUUID();
    const now = input.createdAt ?? new Date().toISOString();
    const sequence =
      input.sequence ??
      (input.runId
        ? ((this.db
            .prepare('SELECT COALESCE(MAX(sequence), -1) AS max_sequence FROM trace_events WHERE run_id = ?')
            .get(input.runId) as { max_sequence: number }).max_sequence + 1)
        : 0);

    this.db
      .prepare(
        `INSERT INTO trace_events (id, run_id, task_id, thread_id, event_type, event_data, model, sequence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId ?? null,
        input.taskId ?? null,
        input.threadId ?? null,
        input.eventType,
        JSON.stringify(input.eventData),
        input.model ?? null,
        sequence,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): TraceEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM trace_events WHERE id = ?')
      .get(id) as TraceEventRow | undefined;

    return row ? rowToTraceEvent(row) : undefined;
  }

  getByRun(runId: string): TraceEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM trace_events WHERE run_id = ? ORDER BY sequence ASC, created_at ASC, rowid ASC'
      )
      .all(runId) as TraceEventRow[];

    return rows.map(rowToTraceEvent);
  }

  getByTask(taskId: string): TraceEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM trace_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(taskId) as TraceEventRow[];

    return rows.map(rowToTraceEvent);
  }

  getByThread(threadId: string): TraceEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM trace_events WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(threadId) as TraceEventRow[];

    return rows.map(rowToTraceEvent);
  }

  deleteByRun(runId: string): void {
    this.db.prepare('DELETE FROM trace_events WHERE run_id = ?').run(runId);
  }

  deleteByTask(taskId: string): void {
    this.db.prepare('DELETE FROM trace_events WHERE task_id = ?').run(taskId);
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM trace_events WHERE thread_id = ?').run(threadId);
  }
}
