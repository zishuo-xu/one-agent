import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/recovery-crash-child.mjs', import.meta.url));

interface RunRow {
  id: string;
  status: string;
  checkpoint: string | null;
}

beforeAll(() => {
  // The child intentionally runs as a plain Node process, exactly like the
  // built CLI, so compile the package before injecting OS-level crashes.
  execFileSync('pnpm', ['--filter', '@one-agent/agent-core', 'build'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
});

describe('process crash recovery', () => {
  it('resumes after a crash during the step model call', async () => {
    const harness = startHarness('model');
    const oldRun = await waitForRun(harness.dbPath, (run, checkpoint) =>
      run.status === 'running' &&
      checkpoint?.plan.steps[0]?.status === 'running' &&
      !checkpoint?.activeToolCall
    );
    await killProcess(harness.child);

    const resumed = resumeHarness(harness, oldRun.id);
    expect(resumed.ok).toBe(true);

    const db = new Database(harness.dbPath);
    const runs = db.prepare('SELECT id, status, checkpoint FROM agent_runs ORDER BY start_time ASC').all() as RunRow[];
    expect(runs.map((run) => run.status)).toEqual(['interrupted', 'completed']);
    const newCheckpoint = JSON.parse(runs[1].checkpoint!);
    expect(newCheckpoint.resumedFromRunId).toBe(oldRun.id);
    expect(newCheckpoint.plan.steps[0].status).toBe('completed');
    const resumedTrace = db.prepare(
      `SELECT event_data FROM trace_events WHERE run_id = ? AND event_type = 'run' ORDER BY sequence LIMIT 1`
    ).get(runs[1].id) as { event_data: string };
    expect(JSON.parse(resumedTrace.event_data).resumedFromRunId).toBe(oldRun.id);
    db.close();
  }, 15_000);

  it('retries an interrupted read and repairs the orphaned tool-call history', async () => {
    const harness = startHarness('read');
    const oldRun = await waitForRun(harness.dbPath, (_run, checkpoint) =>
      checkpoint?.activeToolCall?.name === 'read_file' &&
      checkpoint.activeToolCall.status === 'running'
    );
    await killProcess(harness.child);

    const resumed = resumeHarness(harness, oldRun.id);
    expect(resumed.ok).toBe(true);
    expect(readFileSync(path.join(harness.workspace, 'read-count.txt'), 'utf8').trim().split('\n')).toHaveLength(2);

    const db = new Database(harness.dbPath);
    const paired = db.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE role = 'tool' AND tool_call_id = 'read-tool-call'`
    ).get() as { count: number };
    expect(paired.count).toBeGreaterThanOrEqual(1);
    db.close();
  }, 15_000);

  it('does not replay a write whose side effect completed before the crash', async () => {
    const harness = startHarness('write');
    const oldRun = await waitForRun(harness.dbPath, (_run, checkpoint) =>
      checkpoint?.activeToolCall?.name === 'write_file' &&
      checkpoint.activeToolCall.status === 'running' &&
      existsSync(path.join(harness.workspace, 'result.txt'))
    );
    await killProcess(harness.child);

    const resumed = resumeHarness(harness, oldRun.id);
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain('cannot be replayed automatically');
    expect(readFileSync(path.join(harness.workspace, 'result.txt'), 'utf8')).toBe('written-once');
    expect(readFileSync(path.join(harness.workspace, 'write-count.txt'), 'utf8').trim().split('\n')).toHaveLength(1);

    const db = new Database(harness.dbPath);
    const runs = db.prepare('SELECT id, status, checkpoint FROM agent_runs').all() as RunRow[];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('recovery_required');
    db.close();
  }, 15_000);
});

function startHarness(scenario: 'model' | 'read' | 'write'): {
  child: ChildProcess;
  scenario: string;
  workspace: string;
  dbPath: string;
} {
  const workspace = mkdtempSync(path.join(tmpdir(), `one-agent-crash-${scenario}-`));
  const dbPath = path.join(workspace, 'recovery.db');
  const child = spawn(process.execPath, [fixture, 'initial', scenario, dbPath, workspace], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, scenario, workspace, dbPath };
}

function resumeHarness(
  harness: { scenario: string; workspace: string; dbPath: string },
  runId: string,
): { ok: boolean; runId?: string; reply?: string; error?: string } {
  const output = execFileSync(
    process.execPath,
    [fixture, 'resume', harness.scenario, harness.dbPath, harness.workspace, runId],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 },
  );
  return JSON.parse(output.trim());
}

async function waitForRun(
  dbPath: string,
  predicate: (run: RunRow, checkpoint: Record<string, any> | undefined) => boolean,
): Promise<RunRow> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const run = db.prepare(
          'SELECT id, status, checkpoint FROM agent_runs ORDER BY start_time DESC LIMIT 1'
        ).get() as RunRow | undefined;
        const checkpoint = run?.checkpoint ? JSON.parse(run.checkpoint) : undefined;
        if (run && predicate(run, checkpoint)) return run;
      } finally {
        db.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the child process checkpoint');
}

async function killProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) throw new Error(`Child exited before crash injection: ${child.exitCode}`);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}
