import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { CreateThreadInput, Thread } from './types.js';

interface ThreadRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ThreadStore {
  constructor(private db: Database.Database) {}

  create(input: CreateThreadInput = {}): Thread {
    const id = input.id ?? crypto.randomUUID();
    const title = input.title ?? null;

    this.db
      .prepare(
        `INSERT INTO threads (id, title, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))`
      )
      .run(id, title);

    return this.getById(id)!;
  }

  getById(id: string): Thread | undefined {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE id = ?')
      .get(id) as ThreadRow | undefined;

    return row ? rowToThread(row) : undefined;
  }

  list(): Thread[] {
    const rows = this.db
      .prepare('SELECT * FROM threads ORDER BY updated_at DESC')
      .all() as ThreadRow[];

    return rows.map(rowToThread);
  }

  updateTimestamp(id: string): void {
    this.db
      .prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  updateTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE threads SET title = ? WHERE id = ?')
      .run(title, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }
}
