import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Message } from '../agents/types.js';
import { PersistedMessage, messageToPersisted } from './types.js';

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
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
    createdAt: row.created_at,
  };
}

export class MessageStore {
  constructor(private db: Database.Database) {}

  save(threadId: string, message: Message): PersistedMessage {
    const id = crypto.randomUUID();
    const persisted = messageToPersisted(message);

    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, tool_calls, tool_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        id,
        threadId,
        persisted.role,
        persisted.content,
        persisted.toolCalls ?? null,
        persisted.toolCallId ?? null
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
        'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
      )
      .all(threadId) as MessageRow[];

    return rows.map(rowToPersistedMessage);
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
  }
}
