import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryDocumentConflictError,
  MemoryDocumentStore,
} from '../../src/memory/MemoryDocumentStore.js';

describe('MemoryDocumentStore', () => {
  let root: string;
  let globalRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-document-store-'));
    globalRoot = path.join(root, 'home');
    workspaceRoot = path.join(root, 'workspace');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('uses one global file and one folder-scoped file', async () => {
    const store = new MemoryDocumentStore({ globalRoot, workspaceRoot });
    expect(store.read('global').path).toBe(path.join(globalRoot, 'GLOBAL_MEMORY.md'));
    expect(store.read('workspace').path).toBe(path.join(workspaceRoot, '.one-agent', 'MEMORY.md'));
    await store.write('workspace', '# Workspace Memory\n\n- Use pnpm.\n');
    expect(fs.readFileSync(store.workspacePath, 'utf8')).toContain('Use pnpm');
  });

  it('serializes concurrent writers against the latest committed document', async () => {
    const store = new MemoryDocumentStore({ globalRoot, workspaceRoot });
    const first = store.update(async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ...current, global: `${current.global}\n- first` };
    });
    const second = store.update((current) => ({
      ...current, global: `${current.global}\n- second`,
    }));
    await Promise.all([first, second]);
    expect(store.read('global').content).toContain('- first');
    expect(store.read('global').content).toContain('- second');
  });

  it('does not overwrite a direct external edit made during consolidation', async () => {
    const store = new MemoryDocumentStore({ globalRoot, workspaceRoot });
    await store.write('global', '# Global Memory\n\n- original\n');
    await expect(store.update(async (current) => {
      fs.writeFileSync(store.globalPath, '# Global Memory\n\n- user edit\n');
      return { ...current, global: '# Global Memory\n\n- agent edit\n' };
    })).rejects.toBeInstanceOf(MemoryDocumentConflictError);
    expect(store.read('global').content).toContain('user edit');
  });

  it('checks browser hashes inside the writer lock', async () => {
    const store = new MemoryDocumentStore({ globalRoot, workspaceRoot });
    const hash = store.read('workspace').hash;
    await store.write('workspace', '# Workspace Memory\n\n- first\n', hash);
    await expect(store.write('workspace', '# Workspace Memory\n\n- stale\n', hash))
      .rejects.toBeInstanceOf(MemoryDocumentConflictError);
    expect(store.read('workspace').content).toContain('- first');
  });
});
