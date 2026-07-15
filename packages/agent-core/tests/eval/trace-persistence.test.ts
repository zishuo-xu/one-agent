import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/config.js', () => ({
  config: {
    port: 3000,
    host: '127.0.0.1',
    model: 'gpt-test',
    systemPrompt: 'You are a test assistant.',
    openai: {
      chat: { completions: { create: vi.fn() } },
    },
  },
}));

import { EvalRunner } from '../../src/eval/runner.js';
import { createConnection } from '../../src/db/connection.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { RunStore } from '../../src/db/runStore.js';
import { TraceEventStore } from '../../src/db/traceEventStore.js';
import { createTextResponse, createToolCallResponse } from '../../src/eval/fixtures.js';
import type { EvalTask } from '../../src/eval/types.js';

const passingTask: EvalTask = {
  id: 'trace-pass',
  name: 'Trace pass task',
  description: 'A task that passes its assertions.',
  prompt: 'Say hi.',
  finalAnswerContains: ['hi'],
  mockResponses: [createTextResponse('hi there')],
};

const failingTask: EvalTask = {
  id: 'trace-fail',
  name: 'Trace fail task',
  description: 'A task whose assertions fail.',
  prompt: 'Read the file.',
  // The mock calls read_file, but the assertion demands write_file.
  expectedTools: [{ name: 'write_file' }],
  mockResponses: [
    createToolCallResponse([{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }]),
    createTextResponse('done'),
  ],
};

describe('EvalRunner trace persistence', () => {
  let workspaceRoot: string;
  let traceDbPath: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'one-agent-eval-trace-'));
    traceDbPath = join(workspaceRoot, 'eval-traces.db');
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('persists thread, run and trace events, marking the outcome as PASS', async () => {
    const runner = new EvalRunner();
    const summary = await runner.run({
      tasks: [passingTask],
      workspaceRoot,
      mode: 'mock',
      traceDbPath,
    });

    expect(summary.passed).toBe(1);
    const result = summary.results[0];
    expect(result.threadId).toBeDefined();
    expect(result.runId).toBeDefined();

    const db = createConnection({ path: traceDbPath });
    try {
      const thread = new ThreadStore(db).getById(result.threadId!);
      expect(thread?.title).toBe('[PASS] eval: Trace pass task');

      const run = new RunStore(db).getById(result.runId!);
      expect(run?.status).toBe('completed');

      const traces = new TraceEventStore(db).getByRun(result.runId!);
      expect(traces.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('marks failed tasks as failed runs with assertion errors', async () => {
    const runner = new EvalRunner();
    const summary = await runner.run({
      tasks: [failingTask],
      workspaceRoot,
      mode: 'mock',
      traceDbPath,
    });

    expect(summary.failed).toBe(1);
    const result = summary.results[0];
    expect(result.errors.length).toBeGreaterThan(0);

    const db = createConnection({ path: traceDbPath });
    try {
      const thread = new ThreadStore(db).getById(result.threadId!);
      expect(thread?.title).toBe('[FAIL] eval: Trace fail task');

      const run = new RunStore(db).getById(result.runId!);
      expect(run?.status).toBe('failed');
      expect(run?.error).toContain('write_file');
    } finally {
      db.close();
    }
  });

  it('does not create a db file when traceDbPath is not set', async () => {
    const runner = new EvalRunner();
    const summary = await runner.run({
      tasks: [passingTask],
      workspaceRoot,
      mode: 'mock',
    });

    expect(summary.passed).toBe(1);
    expect(summary.results[0].threadId).toBeUndefined();
    expect(summary.results[0].runId).toBeUndefined();
  });
});
