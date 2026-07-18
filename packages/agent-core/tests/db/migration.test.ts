import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/connection.js';
import { SqliteTaskStore } from '../../src/db/taskStore.js';

describe('migrate', () => {
  it('adds trace sequence before creating its index on an old database', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE trace_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        thread_id TEXT,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL,
        model TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT,
        thread_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO trace_events (id, run_id, event_type, event_data)
      VALUES ('trace-1', 'run-1', 'message', '{}');
    `);

    expect(() => migrate(db)).not.toThrow();

    const columns = db.prepare('PRAGMA table_info(trace_events)').all() as Array<{ name: string }>;
    const indexes = db.prepare('PRAGMA index_list(trace_events)').all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'sequence')).toBe(true);
    expect(indexes.some((index) => index.name === 'idx_trace_events_run_sequence')).toBe(true);
    expect(
      db.prepare('SELECT sequence FROM trace_events WHERE id = ?').get('trace-1')
    ).toEqual({ sequence: 0 });
    const runColumns = db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
    expect(runColumns.some((column) => column.name === 'checkpoint')).toBe(true);
    const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(messageColumns.some((column) => column.name === 'internal')).toBe(true);
    const memoryColumns = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    expect(memoryColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'scope', 'source_run_id', 'confidence', 'status', 'expires_at', 'last_used_at',
      'superseded_by_id',
    ]));
    const memoryIndexes = db.prepare('PRAGMA index_list(memories)').all() as Array<{ name: string }>;
    expect(memoryIndexes.some((index) => index.name === 'idx_memories_status_scope')).toBe(true);
  });

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
