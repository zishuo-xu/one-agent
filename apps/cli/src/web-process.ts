import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

export interface WebProcessSystem {
  findListeningPids(port: number): number[];
  getProcessCommand(pid: number): string | undefined;
  isProcessAlive(pid: number): boolean;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  wait(ms: number): Promise<void>;
}

export interface RestartWebProcessOptions {
  port: number;
  print?: (message: string) => void;
  system?: WebProcessSystem;
  gracefulShutdownTimeoutMs?: number;
}

export interface WebProcessRecord {
  pid: number;
  host: string;
  port: number;
  workspaceRoot: string;
  startedAt: string;
}

function parsePids(output: string): number[] {
  return [...new Set(
    output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  )];
}

export const defaultWebProcessSystem: WebProcessSystem = {
  findListeningPids(port) {
    try {
      const output = execFileSync(
        'lsof',
        ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return parsePids(output);
    } catch {
      return [];
    }
  },

  getProcessCommand(pid) {
    try {
      return execFileSync(
        'ps',
        ['-p', String(pid), '-o', 'command='],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch {
      return undefined;
    }
  },

  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },

  signalProcess(pid, signal) {
    process.kill(pid, signal);
  },

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export function isOneAgentWebCommand(command: string | undefined): boolean {
  if (!command) return false;
  return /(?:^|[/\s])one-agent(?:[/\s]|$)/i.test(command) &&
    /(?:^|\s)web(?:\s|$)/i.test(command);
}

async function waitForExit(
  pid: number,
  system: WebProcessSystem,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (system.isProcessAlive(pid) && Date.now() < deadline) {
    await system.wait(50);
  }
  return !system.isProcessAlive(pid);
}

export async function restartExistingWebProcess(
  options: RestartWebProcessOptions,
): Promise<number[]> {
  const system = options.system ?? defaultWebProcessSystem;
  const print = options.print ?? console.log;
  const pids = system.findListeningPids(options.port)
    .filter((pid) => pid !== process.pid && system.isProcessAlive(pid));
  if (pids.length === 0) return [];

  const processes = pids.map((pid) => ({
    pid,
    command: system.getProcessCommand(pid),
  }));
  const foreign = processes.find((candidate) => !isOneAgentWebCommand(candidate.command));
  if (foreign) {
    const detail = foreign.command ? `：${foreign.command}` : '';
    throw new Error(
      `端口 ${options.port} 已被其他进程占用（PID ${foreign.pid}${detail}），未自动终止该进程。`,
    );
  }

  for (const candidate of processes) {
    print(`检测到旧的 One Agent Web 进程（PID ${candidate.pid}），正在重启……`);
    try {
      system.signalProcess(candidate.pid, 'SIGTERM');
    } catch {
      if (system.isProcessAlive(candidate.pid)) {
        throw new Error(`无法停止旧的 One Agent Web 进程（PID ${candidate.pid}）。`);
      }
      continue;
    }

    const stopped = await waitForExit(
      candidate.pid,
      system,
      options.gracefulShutdownTimeoutMs ?? GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    );
    if (!stopped) {
      print(`旧进程 PID ${candidate.pid} 未及时退出，正在强制停止……`);
      try {
        system.signalProcess(candidate.pid, 'SIGKILL');
      } catch {
        if (system.isProcessAlive(candidate.pid)) {
          throw new Error(`无法强制停止旧的 One Agent Web 进程（PID ${candidate.pid}）。`);
        }
        continue;
      }
      if (!await waitForExit(candidate.pid, system, 1000)) {
        throw new Error(`无法停止旧的 One Agent Web 进程（PID ${candidate.pid}）。`);
      }
    }
  }

  return processes.map(({ pid }) => pid);
}

export function getWebProcessRecordPath(
  port: number,
  homeDir: string = os.homedir(),
): string {
  return path.join(homeDir, '.one-agent', 'run', `web-${port}.json`);
}

export function writeWebProcessRecord(
  record: WebProcessRecord,
  homeDir?: string,
): string {
  const recordPath = getWebProcessRecordPath(record.port, homeDir);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return recordPath;
}

export function removeWebProcessRecord(recordPath: string): void {
  try {
    fs.unlinkSync(recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
