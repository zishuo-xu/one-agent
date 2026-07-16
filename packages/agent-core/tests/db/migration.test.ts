import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/connection.js';
import { SqliteTaskStore } from '../../src/db/taskStore.js';

describe('migrate', () => {
  it('adds idempotency_key to pre-existing tasks tables', () => {
    const db = new Database(':memory:');
    // Old schema: tasks table before retry_count / failed_reason /
    // idempotency_key were introduced.
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        reply TEXT,
        error TEXT,
        events TEXT NOT NULL DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // SQLite forbids ALTER TABLE ... ADD COLUMN ... UNIQUE — the migration
    // must add the column plain and enforce uniqueness via an index instead.
    migrate(db);

    const store = new SqliteTaskStore(db);
    const first = store.create({ message: 'Hello', idempotencyKey: 'key-1' });
    const duplicate = store.create({ message: 'Hello again', idempotencyKey: 'key-1' });
    expect(duplicate.id).toBe(first.id);
    expect(store.create({ message: 'Other', idempotencyKey: 'key-2' }).id).not.toBe(first.id);

    // Uniqueness is enforced even for rows written directly, bypassing the
    // store's SELECT-first fast path.
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, message, status, idempotency_key) VALUES ('x', 'm', 'pending', 'key-1')`
        )
        .run()
    ).toThrow();
  });
});
