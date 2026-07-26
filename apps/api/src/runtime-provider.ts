import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRuntime,
  config,
  createConnection,
} from '@one-agent/agent-core';

export interface RuntimeContext {
  workspaceRoot: string;
  runtime: AgentRuntime;
}

export interface RuntimeProvider {
  current(): RuntimeContext;
}

const activeRuntimeOperations = new WeakMap<AgentRuntime, number>();

export function beginRuntimeOperation(runtime: AgentRuntime): () => void {
  activeRuntimeOperations.set(
    runtime,
    (activeRuntimeOperations.get(runtime) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeRuntimeOperations.get(runtime) ?? 1) - 1;
    if (remaining > 0) {
      activeRuntimeOperations.set(runtime, remaining);
    } else {
      activeRuntimeOperations.delete(runtime);
    }
  };
}

export function isRuntimeActive(runtime: AgentRuntime): boolean {
  return (activeRuntimeOperations.get(runtime) ?? 0) > 0;
}

export type RuntimeRouteOptions =
  | { runtime: AgentRuntime; workspaceRoot?: string }
  | { runtimes: RuntimeProvider };

export function currentRuntime(options: RuntimeRouteOptions): RuntimeContext {
  if ('runtimes' in options) return options.runtimes.current();
  return {
    workspaceRoot: options.workspaceRoot ?? config.workspaceRoot,
    runtime: options.runtime,
  };
}

export class FixedRuntimeProvider implements RuntimeProvider {
  constructor(private readonly context: RuntimeContext) {}

  current(): RuntimeContext {
    return this.context;
  }
}

export interface WebWorkspaceState {
  current: string;
  recent: string[];
}

export interface WorkspaceRuntimeRegistryOptions {
  initialWorkspaceRoot?: string;
  statePath?: string;
  homeDir?: string;
}

interface RuntimeEntry extends RuntimeContext {
  db: ReturnType<typeof createConnection>;
}

const MAX_RECENT_WORKSPACES = 8;

export function getDefaultWebWorkspaceStatePath(
  homeDir: string = os.homedir(),
): string {
  return path.join(homeDir, '.one-agent', 'web-state.json');
}

function readWorkspaceState(statePath: string): Partial<WebWorkspaceState> {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<WebWorkspaceState>;
    return {
      current: typeof parsed.current === 'string' ? parsed.current : undefined,
      recent: Array.isArray(parsed.recent)
        ? parsed.recent.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    return {};
  }
}

function expandHome(value: string, homeDir: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return path.join(homeDir, trimmed.slice(2));
  return trimmed;
}

export function validateWorkspacePath(value: string, homeDir: string = os.homedir()): string {
  const expanded = expandHome(value, homeDir);
  if (!expanded || !path.isAbsolute(expanded)) {
    throw new Error('工作目录必须使用绝对路径，例如 /Users/name/project。');
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(expanded);
  } catch {
    throw new Error(`工作目录不存在：${expanded}`);
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`工作目录不是文件夹：${canonical}`);
  }
  try {
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`工作目录不可读写：${canonical}`);
  }
  return canonical;
}

export class WorkspaceRuntimeRegistry implements RuntimeProvider {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly statePath: string;
  private readonly homeDir: string;
  private currentWorkspaceRoot: string;
  private recentWorkspaces: string[];

  private constructor(
    currentWorkspaceRoot: string,
    options: Required<Pick<WorkspaceRuntimeRegistryOptions, 'statePath' | 'homeDir'>>,
    recent: string[],
  ) {
    this.currentWorkspaceRoot = currentWorkspaceRoot;
    this.statePath = options.statePath;
    this.homeDir = options.homeDir;
    this.recentWorkspaces = recent;
  }

  static async create(
    options: WorkspaceRuntimeRegistryOptions = {},
  ): Promise<WorkspaceRuntimeRegistry> {
    const homeDir = options.homeDir ?? os.homedir();
    const statePath = options.statePath ?? getDefaultWebWorkspaceStatePath(homeDir);
    const stored = readWorkspaceState(statePath);
    const requested = options.initialWorkspaceRoot ?? stored.current ?? homeDir;
    const initial = validateWorkspacePath(requested, homeDir);
    const recent = [initial, ...(stored.recent ?? [])]
      .map((item) => {
        try {
          return validateWorkspacePath(item, homeDir);
        } catch {
          return undefined;
        }
      })
      .filter((item): item is string => Boolean(item));
    const registry = new WorkspaceRuntimeRegistry(
      initial,
      { statePath, homeDir },
      [...new Set(recent)].slice(0, MAX_RECENT_WORKSPACES),
    );
    await registry.getOrCreate(initial);
    registry.persistState();
    return registry;
  }

  current(): RuntimeContext {
    const entry = this.entries.get(this.currentWorkspaceRoot);
    if (!entry) throw new Error(`Runtime not initialized for ${this.currentWorkspaceRoot}`);
    return entry;
  }

  state(): WebWorkspaceState {
    return {
      current: this.currentWorkspaceRoot,
      recent: [...this.recentWorkspaces],
    };
  }

  async select(value: string): Promise<RuntimeContext> {
    const workspaceRoot = validateWorkspacePath(value, this.homeDir);
    if (workspaceRoot === this.currentWorkspaceRoot) return this.current();
    if (this.isCurrentWorkspaceBusy()) {
      throw new Error('当前工作区仍有任务正在执行，请等待完成后再切换。');
    }
    if (
      config.storage.databasePath !== ':memory:' &&
      path.isAbsolute(config.storage.databasePath)
    ) {
      throw new Error(
        'Web 多工作区模式要求 storage.databasePath 使用相对路径，不能使用全局绝对数据库路径。',
      );
    }
    const context = await this.getOrCreate(workspaceRoot);
    this.currentWorkspaceRoot = workspaceRoot;
    this.recentWorkspaces = [
      workspaceRoot,
      ...this.recentWorkspaces.filter((item) => item !== workspaceRoot),
    ].slice(0, MAX_RECENT_WORKSPACES);
    this.persistState();
    return context;
  }

  close(): void {
    for (const entry of this.entries.values()) {
      if (entry.db.open) entry.db.close();
    }
    this.entries.clear();
  }

  hasActiveOperations(): boolean {
    return [...this.entries.values()].some((entry) => isRuntimeActive(entry.runtime));
  }

  hasPendingOperations(): boolean {
    return [...this.entries.values()].some((entry) => {
      if (isRuntimeActive(entry.runtime)) return true;
      const pending = entry.db
        .prepare(
          `SELECT 1 FROM agent_runs
           WHERE status = 'waiting_for_input'
           LIMIT 1`,
        )
        .get();
      return Boolean(pending);
    });
  }

  async reload(): Promise<RuntimeContext> {
    if (this.hasPendingOperations()) {
      throw new Error('当前仍有任务正在执行，请等待完成后再保存 Agent 配置。');
    }
    for (const entry of this.entries.values()) {
      if (entry.db.open) entry.db.close();
    }
    this.entries.clear();
    return this.getOrCreate(this.currentWorkspaceRoot);
  }

  private async getOrCreate(workspaceRoot: string): Promise<RuntimeEntry> {
    const existing = this.entries.get(workspaceRoot);
    if (existing) return existing;
    const configuredPath = config.storage.databasePath;
    const databasePath =
      configuredPath === ':memory:' || path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(workspaceRoot, configuredPath);
    const db = createConnection({ path: databasePath });
    const runtime = new AgentRuntime({ workspaceRoot, db });
    await runtime.memory.recoverUnextracted();
    const entry = { workspaceRoot, runtime, db };
    this.entries.set(workspaceRoot, entry);
    return entry;
  }

  private isCurrentWorkspaceBusy(): boolean {
    const entry = this.entries.get(this.currentWorkspaceRoot);
    if (!entry) return false;
    return isRuntimeActive(entry.runtime);
  }

  private persistState(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(this.state(), null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(temporaryPath, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }
}
