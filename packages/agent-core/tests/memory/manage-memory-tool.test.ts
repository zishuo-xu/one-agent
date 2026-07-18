import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { MemoryStore } from '../../src/db/memoryStore.js';
import { createManageMemoryTool } from '../../src/memory/manageMemoryTool.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';

describe('manage_memory tool', () => {
  let db: Database.Database;
  let store: MemoryStore;
  let executor: ToolExecutor;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    store = new MemoryStore(db);
    const tools = new ToolRegistry();
    tools.register(createManageMemoryTool({ memoryStore: store, threadId: 'thread-1' }));
    executor = new ToolExecutor(tools);
  });

  it('remembers, corrects, inspects and forgets an explicit fact', async () => {
    const remembered = await executor.execute({
      id: 'remember-1',
      name: 'manage_memory',
      arguments: {
        action: 'remember',
        key: 'package manager',
        value: 'pnpm',
        kind: 'project_rule',
      },
    });
    expect(remembered.success).toBe(true);
    expect(store.list({ status: 'active' })[0]).toMatchObject({
      key: 'package manager',
      value: 'pnpm',
      explicit: true,
      confidence: 1,
      source: 'explicit_user',
    });

    const corrected = await executor.execute({
      id: 'correct-1',
      name: 'manage_memory',
      arguments: {
        action: 'correct',
        key: 'package manager',
        value: 'npm',
        kind: 'project_rule',
      },
    });
    expect(corrected.success).toBe(true);
    expect(store.list({ status: 'active' })[0].value).toBe('npm');

    const inspected = await executor.execute({
      id: 'inspect-1',
      name: 'manage_memory',
      arguments: { action: 'inspect', query: 'package manager' },
    });
    expect(inspected).toMatchObject({
      success: true,
      data: {
        action: 'inspected',
        memories: [{ key: 'package manager', value: 'npm' }],
      },
    });

    const forgotten = await executor.execute({
      id: 'forget-1',
      name: 'manage_memory',
      arguments: { action: 'forget', key: 'package manager' },
    });
    expect(forgotten).toMatchObject({ success: true, data: { action: 'forgotten' } });
    expect(store.list({ status: 'active' })).toEqual([]);
    expect(store.list({ status: 'forgotten' })[0].value).toBe('[forgotten]');
  });

  it('supports thread-scoped explicit memory', async () => {
    const result = await executor.execute({
      id: 'thread-remember',
      name: 'manage_memory',
      arguments: {
        action: 'remember',
        key: 'temporary convention',
        value: 'Use fixture A in this conversation',
        scope: 'thread',
      },
    });

    expect(result.success).toBe(true);
    expect(store.list({ status: 'active' })[0]).toMatchObject({
      scope: 'thread',
      threadId: 'thread-1',
    });
  });

  it('rejects credential-shaped memory keys', async () => {
    const result = await executor.execute({
      id: 'secret-remember',
      name: 'manage_memory',
      arguments: {
        action: 'remember',
        key: 'OpenAI API key',
        value: 'secret-value',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Credentials and secrets');
    expect(store.list()).toEqual([]);
  });
});
