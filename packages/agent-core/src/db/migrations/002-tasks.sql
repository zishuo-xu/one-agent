CREATE TABLE IF NOT EXISTS tasks (
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

CREATE INDEX IF NOT EXISTS idx_tasks_thread_id ON tasks(thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at ON tasks(status, created_at);
