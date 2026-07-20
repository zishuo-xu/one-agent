import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEvalDataset, resolveBundledDatasetDir } from '../../src/eval/datasetLoader.js';

describe('loadEvalDataset', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'one-agent-dataset-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the bundled dataset (19 mock + 2 real + 40 capability tasks)', () => {
    const tasks = loadEvalDataset(resolveBundledDatasetDir());
    expect(tasks).toHaveLength(61);
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(61);
    expect(ids).toContain('tool-chain');
    expect(ids).toContain('real-model-planning');
    expect(ids).toContain('real-model-benchmark');
    expect(ids).toContain('l2-timeout-double');
    expect(ids).toContain('l6-weekly-report');
  });

  it('preserves capability-schema fields (tags, checkpoints) after parsing', () => {
    // Regression: zod strips unknown keys, so new EvalTask fields must be
    // declared in the loader schema or dataset JSONs silently lose them.
    const tasks = loadEvalDataset(resolveBundledDatasetDir());
    const l2 = tasks.find((t) => t.id === 'l2-timeout-double');
    expect(l2?.capabilities).toEqual(['tool-chain', 'file-ops']);
    expect(l2?.difficulty).toBe('easy');
    expect(l2?.finalAnswerContainsAll).toEqual(['3000']);

    const l6 = tasks.find((t) => t.id === 'l6-weekly-report');
    expect(l6?.checkpoints?.length).toBeGreaterThanOrEqual(3);
    const fileCheckpoint = l6?.checkpoints?.find((c) => c.id === 'items');
    expect(fileCheckpoint?.points).toBe(2);
    expect(fileCheckpoint?.expectedFiles?.[0].containsAll).toContain('登录页开发');
  });

  it('loads tasks from subdirectories and validates required fields', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      join(dir, 'sub', 'task-a.json'),
      JSON.stringify({ id: 'a', name: 'A', description: 'task a', prompt: 'do a' }),
    );
    writeFileSync(
      join(dir, 'task-b.json'),
      JSON.stringify({ id: 'b', name: 'B', description: 'task b', prompt: 'do b' }),
    );

    const tasks = loadEvalDataset(dir);
    // Sorted by full path: <dir>/sub/task-a.json comes before <dir>/task-b.json.
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('throws a file-scoped error for invalid JSON', () => {
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    expect(() => loadEvalDataset(dir)).toThrow(/broken\.json/);
  });

  it('throws a file-scoped error for schema violations', () => {
    writeFileSync(join(dir, 'no-prompt.json'), JSON.stringify({ id: 'x', name: 'X', description: '' }));
    expect(() => loadEvalDataset(dir)).toThrow(/no-prompt\.json/);
  });

  it('rejects duplicate task ids', () => {
    const task = { id: 'dup', name: 'D', description: 'd', prompt: 'p' };
    writeFileSync(join(dir, 'one.json'), JSON.stringify(task));
    writeFileSync(join(dir, 'two.json'), JSON.stringify(task));
    expect(() => loadEvalDataset(dir)).toThrow(/Duplicate eval task id "dup"/);
  });

  it('throws when the directory does not exist', () => {
    expect(() => loadEvalDataset(join(dir, 'missing'))).toThrow(/not found/);
  });
});
