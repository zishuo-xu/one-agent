import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { CreateThreadInput, Thread } from './types.js';
import { normalizeUtcDateTime } from './dateTime.js';

interface ThreadRow {
  id: string;
  title: string | null;
  memory_extracted: number;
  created_at: string;
  updated_at: string;
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    memoryExtracted: row.memory_extracted === 1,
    createdAt: normalizeUtcDateTime(row.created_at),
    updatedAt: normalizeUtcDateTime(row.updated_at),
  };
}

export class ThreadStore {
  constructor(private db: Database.Database) {}

  create(input: CreateThreadInput = {}): Thread {
    const id = input.id ?? crypto.randomUUID();
    const title = input.title ?? null;

    this.db
      .prepare(
        `INSERT INTO threads (id, title, memory_extracted, created_at, updated_at)
         VALUES (?, ?, 1, datetime('now'), datetime('now'))`
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

  listUnextracted(): Thread[] {
    const rows = this.db
      .prepare('SELECT * FROM threads WHERE memory_extracted = 0 ORDER BY updated_at ASC')
      .all() as ThreadRow[];
    return rows.map(rowToThread);
  }

  updateTimestamp(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  markMemoryExtracted(id: string): void {
    this.db.prepare('UPDATE threads SET memory_extracted = 1 WHERE id = ?').run(id);
  }

  markMemoryExtractedIfUnchanged(id: string, expectedUpdatedAt: string): boolean {
    const result = this.db
      .prepare('UPDATE threads SET memory_extracted = 1 WHERE id = ? AND updated_at = ?')
      .run(id, expectedUpdatedAt);
    return result.changes === 1;
  }

  markMemoryUnextracted(id: string): void {
    this.db.prepare('UPDATE threads SET memory_extracted = 0 WHERE id = ?').run(id);
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
