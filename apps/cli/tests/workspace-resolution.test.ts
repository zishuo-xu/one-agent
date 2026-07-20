import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolveWorkspaceRoot, parseWorkspaceArg } from '../src/workspace.js';

describe('workspace resolution', () => {
  it('uses --workspace argument', () => {
    const root = resolveWorkspaceRoot({ argv: ['--workspace', '/tmp/custom-workspace'] });
    expect(root).toBe('/tmp/custom-workspace');
  });

  it('prefers --workspace over a config in the current directory', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-cwd-'));
    writeFileSync(path.join(tmpDir, 'one-agent.config.json'), '{}');
    const root = resolveWorkspaceRoot({ argv: ['--workspace', '/tmp/arg-ws'], cwd: tmpDir });
    expect(root).toBe('/tmp/arg-ws');
  });

  it('uses the current directory when one-agent.config.json exists', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-cwd-'));
    writeFileSync(path.join(tmpDir, 'one-agent.config.json'), '{}');
    expect(resolveWorkspaceRoot({ cwd: tmpDir })).toBe(tmpDir);
  });

  it('uses an explicitly discovered repository config', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-repo-'));
    const repoConfig = path.join(tmpDir, 'one-agent.config.json');
    writeFileSync(repoConfig, '{}');
    expect(resolveWorkspaceRoot({ cwd: '/', repoConfig })).toBe(tmpDir);
  });

  it('uses the current folder when no explicit workspace marker exists', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-env-'));
    writeFileSync(path.join(tmpDir, '.env'), 'OPENAI_API_KEY=test');
    expect(resolveWorkspaceRoot({ cwd: tmpDir })).toBe(tmpDir);
  });

  it('falls back to the current folder rather than the global memory folder', () => {
    expect(resolveWorkspaceRoot({ argv: [], cwd: '/', repoConfig: '/missing/config.json' }))
      .toBe('/');
  });

  it('inherits the nearest parent workspace memory boundary', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-memory-workspace-'));
    const child = path.join(tmpDir, 'packages', 'core');
    mkdirSync(path.join(tmpDir, '.one-agent'), { recursive: true });
    mkdirSync(child, { recursive: true });
    writeFileSync(path.join(tmpDir, '.one-agent', 'MEMORY.md'), '# Workspace Memory\n');
    expect(resolveWorkspaceRoot({ cwd: child })).toBe(tmpDir);
  });

  it('parses --workspace argument', () => {
    expect(parseWorkspaceArg(['--workspace', '/a/b'])).toBe('/a/b');
    expect(parseWorkspaceArg([])).toBeUndefined();
    expect(parseWorkspaceArg(['--workspace'])).toBeUndefined();
  });
});
