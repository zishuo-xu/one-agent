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
  kind TEXT NOT NULL DEFAULT 'fact',
  explicit INTEGER NOT NULL DEFAULT 0,
  source_message_id TEXT,
  observed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_status_scope ON memories(status, scope, updated_at);
