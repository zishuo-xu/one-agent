import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolveWorkspaceRoot, parseWorkspaceArg } from '../src/workspace.js';

describe('workspace resolution', () => {
  it('uses --workspace argument', () => {
    const ws = '/tmp/custom-workspace';
    const root = resolveWorkspaceRoot({ argv: ['--workspace', ws] });
    expect(root).toBe(path.resolve(ws));
  });

  it('uses ONE_AGENT_WORKSPACE env', () => {
    const ws = '/tmp/env-workspace';
    const root = resolveWorkspaceRoot({ env: { ONE_AGENT_WORKSPACE: ws } });
    expect(root).toBe(path.resolve(ws));
  });

  it('prefers --workspace over env', () => {
    const root = resolveWorkspaceRoot({
      argv: ['--workspace', '/tmp/arg-ws'],
      env: { ONE_AGENT_WORKSPACE: '/tmp/env-ws' },
    });
    expect(root).toBe('/tmp/arg-ws');
  });

  it('uses current directory when .env exists', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-cwd-'));
    writeFileSync(path.join(tmpDir, '.env'), 'OPENAI_API_KEY=test');
    const root = resolveWorkspaceRoot({ cwd: tmpDir });
    expect(root).toBe(tmpDir);
  });

  it('uses repo root when repo .env exists', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-repo-'));
    mkdirSync(path.join(tmpDir, 'apps', 'cli', 'src'), { recursive: true });
    const repoEnv = path.join(tmpDir, '.env');
    writeFileSync(repoEnv, 'OPENAI_API_KEY=test');
    const root = resolveWorkspaceRoot({
      cwd: '/',
      repoEnv,
    });
    expect(root).toBe(tmpDir);
  });

  it('falls back to ~/.one-agent', () => {
    const root = resolveWorkspaceRoot({
      argv: [],
      env: {},
      cwd: '/',
      repoEnv: '/nonexistent/path/.env',
    });
    expect(root).toBe(path.join(os.homedir(), '.one-agent'));
  });

  it('parses --workspace argument', () => {
    expect(parseWorkspaceArg(['--workspace', '/a/b'])).toBe('/a/b');
    expect(parseWorkspaceArg([])).toBeUndefined();
    expect(parseWorkspaceArg(['--workspace'])).toBeUndefined();
  });
});
