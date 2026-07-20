import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MemoryDocumentScope = 'global' | 'workspace';

export interface MemoryDocument {
  scope: MemoryDocumentScope;
  path: string;
  content: string;
  hash: string;
  updatedAt?: string;
}

export interface MemoryDocumentContents {
  global: string;
  workspace: string;
}

export interface MemoryDocumentStoreOptions {
  workspaceRoot: string;
  globalRoot?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export class MemoryDocumentConflictError extends Error {
  constructor(message = 'Memory document changed while it was being updated') {
    super(message);
    this.name = 'MemoryDocumentConflictError';
  }
}

const DEFAULT_DOCUMENTS: Record<MemoryDocumentScope, string> = {
  global: '# Global Memory\n',
  workspace: '# Workspace Memory\n',
};

function normalizeDocument(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trimEnd();
  return `${normalized || '# Memory'}\n`;
}

function hashDocument(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The only source of truth for durable memory.
 *
 * A single machine-local writer lock intentionally serializes both scopes.
 * Reads remain lock-free because every commit uses an atomic rename.
 */
export class MemoryDocumentStore {
  readonly globalPath: string;
  readonly workspacePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(options: MemoryDocumentStoreOptions) {
    const globalRoot = path.resolve(options.globalRoot ?? path.join(os.homedir(), '.one-agent'));
    const workspaceRoot = path.resolve(options.workspaceRoot);
    this.globalPath = path.join(globalRoot, 'GLOBAL_MEMORY.md');
    this.workspacePath = path.join(workspaceRoot, '.one-agent', 'MEMORY.md');
    this.lockPath = path.join(globalRoot, 'memory.lock');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
    this.staleLockMs = options.staleLockMs ?? 10 * 60_000;
  }

  read(scope: MemoryDocumentScope): MemoryDocument {
    const filePath = this.pathFor(scope);
    let content = DEFAULT_DOCUMENTS[scope];
    let updatedAt: string | undefined;
    try {
      content = normalizeDocument(fs.readFileSync(filePath, 'utf8'));
      updatedAt = fs.statSync(filePath).mtime.toISOString();
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return {
      scope,
      path: filePath,
      content,
      hash: hashDocument(content),
      updatedAt,
    };
  }

  readAll(): MemoryDocument[] {
    return [this.read('global'), this.read('workspace')];
  }

  async write(
    scope: MemoryDocumentScope,
    content: string,
    expectedHash?: string,
  ): Promise<MemoryDocument> {
    await this.update(async (current) => {
      if (expectedHash && hashDocument(current[scope]) !== expectedHash) {
        throw new MemoryDocumentConflictError('Memory document changed; reload before saving');
      }
      return { ...current, [scope]: content };
    });
    return this.read(scope);
  }

  /**
   * Update both documents from the latest locked snapshot. The callback may
   * call a model, so the writer lock deliberately covers the whole operation.
   */
  async update(
    transform: (current: MemoryDocumentContents) => Promise<MemoryDocumentContents> | MemoryDocumentContents,
  ): Promise<MemoryDocument[]> {
    const release = await this.acquireLock();
    try {
      const before = this.readAll();
      const current: MemoryDocumentContents = {
        global: before[0].content,
        workspace: before[1].content,
      };
      const next = await transform(current);

      // An external editor does not honor our lock. Never overwrite it.
      const latest = this.readAll();
      if (latest.some((document, index) => document.hash !== before[index].hash)) {
        throw new MemoryDocumentConflictError();
      }

      const normalized: MemoryDocumentContents = {
        global: normalizeDocument(next.global),
        workspace: normalizeDocument(next.workspace),
      };
      if (normalized.global !== current.global) {
        await this.atomicWrite(this.globalPath, normalized.global);
      }
      if (normalized.workspace !== current.workspace) {
        await this.atomicWrite(this.workspacePath, normalized.workspace);
      }
      return this.readAll();
    } finally {
      await release();
    }
  }

  private pathFor(scope: MemoryDocumentScope): string {
    return scope === 'global' ? this.globalPath : this.workspacePath;
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const startedAt = Date.now();
    await fs.promises.mkdir(path.dirname(this.lockPath), { recursive: true });
    while (true) {
      try {
        await fs.promises.mkdir(this.lockPath);
        await fs.promises.writeFile(
          path.join(this.lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          'utf8',
        );
        return async () => {
          await fs.promises.rm(this.lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await this.removeStaleLock();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out waiting for memory lock: ${this.lockPath}`);
        }
        await delay(100);
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.lockPath);
      if (Date.now() - stat.mtimeMs > this.staleLockMs) {
        await fs.promises.rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
