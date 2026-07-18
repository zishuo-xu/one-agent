import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db: Database.Database | null = null;

export interface DatabaseOptions {
  path: string;
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  internal INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  task_id TEXT,
  model TEXT NOT NULL,
  start_time DATETIME,
  end_time DATETIME,
  status TEXT,
  error TEXT,
  reasoning_chain TEXT,
  trace_status TEXT NOT NULL DEFAULT 'recording',
  dropped_trace_events INTEGER NOT NULL DEFAULT 0,
  trace_error TEXT,
  checkpoint TEXT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_id ON agent_runs(thread_id);

CREATE TABLE IF NOT EXISTS trace_events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  task_id TEXT,
  thread_id TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT NOT NULL,
  model TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trace_events_run_id ON trace_events(run_id);
CREATE INDEX IF NOT EXISTS idx_trace_events_task_id ON trace_events(task_id);
CREATE INDEX IF NOT EXISTS idx_trace_events_thread_id ON trace_events(thread_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  reply TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  failed_reason TEXT,
  idempotency_key TEXT UNIQUE,
  events TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_thread_id ON tasks(thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at ON tasks(status, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT,
  thread_id TEXT,
  scope TEXT NOT NULL DEFAULT 'global',
  source_run_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at DATETIME,
  last_used_at DATETIME,
  superseded_by_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments TEXT,
  result TEXT,
  success BOOLEAN,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);
`;

export function createConnection(options: DatabaseOptions): Database.Database {
  const dbPath = options.path === ':memory:' ? ':memory:' : path.resolve(options.path);
  const dir = path.dirname(dbPath);

  if (dbPath !== ':memory:' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const instance = new Database(dbPath);
  if (dbPath !== ':memory:') {
    instance.pragma('journal_mode = WAL');
  }
  migrate(instance);
  return instance;
}

export function getSharedConnection(): Database.Database {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH ?? 'workspace/data.db';
    db = createConnection({ path: dbPath });
  }
  return db;
}

export function migrate(instance: Database.Database): void {
  instance.exec(INIT_SQL);

  // Backward-compatible column additions for existing databases.
  try {
    instance.exec('ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists.
  }
  try {
    instance.exec('ALTER TABLE tasks ADD COLUMN failed_reason TEXT');
  } catch {
    // Column already exists.
  }
  try {
    // SQLite cannot add a UNIQUE column via ALTER TABLE; add the column plain
    // and enforce uniqueness with the partial unique index below.
    instance.exec('ALTER TABLE tasks ADD COLUMN idempotency_key TEXT');
  } catch {
    // Column already exists.
  }
  try {
    instance.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency_key_unique ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL'
    );
  } catch {
    // Index already exists.
  }
  try {
    instance.exec('ALTER TABLE messages ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists.
  }
  try {
    instance.exec('ALTER TABLE messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists.
  }
  try {
    instance.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread_sequence ON messages(thread_id, sequence)');
  } catch {
    // Index already exists or pending creation.
  }
  for (const sql of [
    "ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
    'ALTER TABLE memories ADD COLUMN source_run_id TEXT',
    'ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7',
    "ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    'ALTER TABLE memories ADD COLUMN expires_at DATETIME',
    'ALTER TABLE memories ADD COLUMN last_used_at DATETIME',
    'ALTER TABLE memories ADD COLUMN superseded_by_id TEXT',
  ]) {
    try {
      instance.exec(sql);
    } catch {
      // Column already exists.
    }
  }
  try {
    instance.exec('CREATE INDEX IF NOT EXISTS idx_memories_status_scope ON memories(status, scope, updated_at)');
  } catch {
    // Index already exists.
  }
  try {
    instance.exec("ALTER TABLE agent_runs ADD COLUMN trace_status TEXT NOT NULL DEFAULT 'complete'");
  } catch {
    // Column already exists.
  }
  try {
    instance.exec('ALTER TABLE agent_runs ADD COLUMN dropped_trace_events INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists.
  }
  try {
    instance.exec('ALTER TABLE agent_runs ADD COLUMN trace_error TEXT');
  } catch {
    // Column already exists.
  }
  try {
    instance.exec('ALTER TABLE agent_runs ADD COLUMN checkpoint TEXT');
  } catch {
    // Column already exists.
  }
  try {
    instance.exec('ALTER TABLE trace_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists.
  }
  try {
    instance.exec('CREATE INDEX IF NOT EXISTS idx_trace_events_run_sequence ON trace_events(run_id, sequence)');
  } catch {
    // Index already exists.
  }
}

export function resetSharedConnection(): void {
  db?.close();
  db = null;
}
