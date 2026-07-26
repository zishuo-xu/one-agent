import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import {
  getWebProcessRecordPath,
  isOneAgentWebCommand,
  removeWebProcessRecord,
  restartExistingWebProcess,
  writeWebProcessRecord,
} from '../src/web-process.js';
import type { WebProcessSystem } from '../src/web-process.js';

function createSystem(options: {
  pids?: number[];
  commands?: Record<number, string | undefined>;
  stopOnTerm?: boolean;
}) {
  const alive = new Set(options.pids ?? []);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const system: WebProcessSystem = {
    findListeningPids: () => [...alive],
    getProcessCommand: (pid) => options.commands?.[pid],
    isProcessAlive: (pid) => alive.has(pid),
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === 'SIGKILL' || options.stopOnTerm !== false) alive.delete(pid);
    },
    wait: async () => {},
  };
  return { system, signals };
}

describe('Web process restart', () => {
  it('recognizes CLI and compiled One Agent Web commands', () => {
    expect(isOneAgentWebCommand('one-agent web')).toBe(true);
    expect(isOneAgentWebCommand(
      'node /Users/test/Documents/one-agent/apps/cli/dist/index.js web',
    )).toBe(true);
    expect(isOneAgentWebCommand('node server.js web')).toBe(false);
    expect(isOneAgentWebCommand('one-agent doctor')).toBe(false);
  });

  it('gracefully stops an existing One Agent Web listener', async () => {
    const { system, signals } = createSystem({
      pids: [4321],
      commands: { 4321: 'node /opt/one-agent/apps/cli/dist/index.js web' },
    });
    const output: string[] = [];

    await expect(restartExistingWebProcess({
      port: 3000,
      system,
      print: (message) => output.push(message),
    })).resolves.toEqual([4321]);
    expect(signals).toEqual([{ pid: 4321, signal: 'SIGTERM' }]);
    expect(output.join('\n')).toContain('正在重启');
  });

  it('never terminates an unrelated process using the configured port', async () => {
    const { system, signals } = createSystem({
      pids: [8765],
      commands: { 8765: 'node another-server.js' },
    });

    await expect(restartExistingWebProcess({
      port: 3000,
      system,
    })).rejects.toThrow('其他进程占用');
    expect(signals).toEqual([]);
  });

  it('uses SIGKILL only when graceful shutdown times out', async () => {
    const { system, signals } = createSystem({
      pids: [2468],
      commands: { 2468: 'one-agent web' },
      stopOnTerm: false,
    });

    await restartExistingWebProcess({
      port: 3000,
      system,
      gracefulShutdownTimeoutMs: 0,
      print: () => {},
    });
    expect(signals).toEqual([
      { pid: 2468, signal: 'SIGTERM' },
      { pid: 2468, signal: 'SIGKILL' },
    ]);
  });

  it('writes and removes the process record with private permissions', () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-home-'));
    const recordPath = writeWebProcessRecord({
      pid: 1357,
      host: '127.0.0.1',
      port: 3000,
      workspaceRoot: '/tmp/project',
      startedAt: '2026-07-26T00:00:00.000Z',
    }, homeDir);

    expect(recordPath).toBe(getWebProcessRecordPath(3000, homeDir));
    expect(existsSync(recordPath)).toBe(true);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    removeWebProcessRecord(recordPath);
    expect(existsSync(recordPath)).toBe(false);
  });
});
