import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Message } from '../agents/types.js';
import { PersistedMessage, messageToPersisted } from './types.js';
import { normalizeUtcDateTime } from './dateTime.js';

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  internal: number;
  sequence: number;
  created_at: string;
}

function rowToPersistedMessage(row: MessageRow): PersistedMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    internal: row.internal === 1,
    createdAt: normalizeUtcDateTime(row.created_at),
  };
}

export class MessageStore {
  constructor(private db: Database.Database) {}

  save(threadId: string, message: Message): PersistedMessage {
    const id = crypto.randomUUID();
    const persisted = messageToPersisted(message);

    // Assign a per-thread monotonic sequence so messages written within the
    // same second still resume in the exact order they were saved. SQLite's
    // datetime('now') has 1-second resolution, which is too coarse to order
    // tool_call/tool_result/final-reply reliably on a fast turn.
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), -1) AS max_seq FROM messages WHERE thread_id = ?')
      .get(threadId) as { max_seq: number } | undefined;
    const sequence = (row?.max_seq ?? -1) + 1;

    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, tool_calls, tool_call_id, internal, sequence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        id,
        threadId,
        persisted.role,
        persisted.content,
        persisted.toolCalls ?? null,
        persisted.toolCallId ?? null,
        persisted.internal ? 1 : 0,
        sequence
      );

    return this.getById(id)!;
  }

  getById(id: string): PersistedMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined;

    return row ? rowToPersistedMessage(row) : undefined;
  }

  getByThread(threadId: string): PersistedMessage[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence ASC, created_at ASC, id ASC'
      )
      .all(threadId) as MessageRow[];

    return rows.map(rowToPersistedMessage);
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
  }
}
