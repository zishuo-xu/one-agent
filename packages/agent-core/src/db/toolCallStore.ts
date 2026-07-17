import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { PersistedToolCall, CreateToolCallInput } from './types.js';
import { normalizeUtcDateTime } from './dateTime.js';

interface ToolCallRow {
  id: string;
  run_id: string;
  name: string;
  arguments: string | null;
  result: string | null;
  success: number;
  created_at: string;
}

function rowToPersistedToolCall(row: ToolCallRow): PersistedToolCall {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    arguments: row.arguments ?? undefined,
    result: row.result ?? undefined,
    success: row.success === 1,
    createdAt: normalizeUtcDateTime(row.created_at),
  };
}

export class ToolCallStore {
  constructor(private db: Database.Database) {}

  create(input: CreateToolCallInput): PersistedToolCall {
    const id = crypto.randomUUID();
    const args = input.toolCall.arguments
      ? JSON.stringify(input.toolCall.arguments)
      : null;
    const result = input.result ? JSON.stringify(input.result) : null;

    this.db
      .prepare(
        `INSERT INTO tool_calls (id, run_id, name, arguments, result, success, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        id,
        input.runId,
        input.toolCall.name,
        args,
        result,
        input.result.success ? 1 : 0
      );

    return this.getById(id)!;
  }

  getById(id: string): PersistedToolCall | undefined {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as
      | ToolCallRow
      | undefined;

    return row ? rowToPersistedToolCall(row) : undefined;
  }

  getByRun(runId: string): PersistedToolCall[] {
    const rows = this.db
      .prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as ToolCallRow[];

    return rows.map(rowToPersistedToolCall);
  }

  deleteByRun(runId: string): void {
    this.db.prepare('DELETE FROM tool_calls WHERE run_id = ?').run(runId);
  }
}
