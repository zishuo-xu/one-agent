ALTER TABLE trace_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_trace_events_run_sequence ON trace_events(run_id, sequence);

ALTER TABLE agent_runs ADD COLUMN trace_status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE agent_runs ADD COLUMN dropped_trace_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN trace_error TEXT;
