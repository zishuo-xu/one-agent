ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE memories ADD COLUMN source_run_id TEXT;
ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7;
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memories ADD COLUMN expires_at DATETIME;
ALTER TABLE memories ADD COLUMN last_used_at DATETIME;
ALTER TABLE memories ADD COLUMN superseded_by_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_status_scope ON memories(status, scope, updated_at);
