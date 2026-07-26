import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureSystem,
  createConnection,
  ThreadStore,
} from '@one-agent/agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginRuntimeOperation,
  WorkspaceRuntimeRegistry,
} from '../src/runtime-provider.js';
import { buildServer } from '../src/server.js';

describe('selectable Web workspaces', () => {
  let root: string;
  let workspaceA: string;
  let workspaceB: string;
  let statePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-web-workspaces-'));
    workspaceA = path.join(root, 'workspace-a');
    workspaceB = path.join(root, 'workspace-b');
    statePath = path.join(root, 'state', 'web-state.json');
    fs.mkdirSync(workspaceA);
    fs.mkdirSync(workspaceB);
    workspaceA = fs.realpathSync(workspaceA);
    workspaceB = fs.realpathSync(workspaceB);
    configureSystem({
      storage: { databasePath: 'data.db' },
      api: { logLevel: 'silent' },
    });
  });

  afterEach(() => {
    configureSystem({});
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('switches isolated databases without adding workspace data to Thread', async () => {
    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspaceA,
      workspaceStatePath: statePath,
    });
    const dbA = createConnection({ path: path.join(workspaceA, 'data.db') });
    const threadA = new ThreadStore(dbA).create({ title: 'Workspace A thread' });
    dbA.close();

    const initialThreads = await server.inject({ method: 'GET', url: '/api/threads' });
    expect(JSON.parse(initialThreads.body)).toContainEqual(
      expect.objectContaining({ id: threadA.id, title: 'Workspace A thread' }),
    );

    const switched = await server.inject({
      method: 'POST',
      url: '/api/workspaces/select',
      payload: { path: workspaceB },
    });
    expect(switched.statusCode).toBe(200);
    expect(JSON.parse(switched.body).current).toBe(workspaceB);
    expect(JSON.parse((await server.inject({
      method: 'GET',
      url: '/api/threads',
    })).body)).toEqual([]);
    expect(JSON.parse((await server.inject({
      method: 'GET',
      url: '/api/health',
    })).body).workspace).toBe(workspaceB);

    const switchedBack = await server.inject({
      method: 'POST',
      url: '/api/workspaces/select',
      payload: { path: workspaceA },
    });
    expect(switchedBack.statusCode).toBe(200);
    expect(JSON.parse((await server.inject({
      method: 'GET',
      url: '/api/threads',
    })).body)).toContainEqual(expect.objectContaining({ id: threadA.id }));

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state).toMatchObject({
      current: workspaceA,
      recent: [workspaceA, workspaceB],
    });
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    await server.close();
  });

  it('rejects missing paths and protects switching during a live operation', async () => {
    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspaceA,
      workspaceStatePath: statePath,
    });
    const missing = await server.inject({
      method: 'POST',
      url: '/api/workspaces/select',
      payload: { path: path.join(root, 'missing') },
    });
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body).error).toContain('不存在');

    await server.close();

    const runtimes = await WorkspaceRuntimeRegistry.create({
      initialWorkspaceRoot: workspaceA,
      statePath,
      homeDir: root,
    });
    const releaseOperation = beginRuntimeOperation(runtimes.current().runtime);
    await expect(runtimes.select(workspaceB)).rejects.toThrow('正在执行');
    releaseOperation();
    await expect(runtimes.select(workspaceB)).resolves.toMatchObject({
      workspaceRoot: workspaceB,
    });
    runtimes.close();
  });

  it('does not treat stale persisted run status as live Web activity', async () => {
    const db = createConnection({ path: path.join(workspaceA, 'data.db') });
    const thread = new ThreadStore(db).create({});
    db.prepare(
      `INSERT INTO agent_runs
       (id, thread_id, model, start_time, status)
       VALUES ('stale-run', ?, 'test', '2020-01-01T00:00:00.000Z', 'running')`,
    ).run(thread.id);
    db.close();

    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspaceA,
      workspaceStatePath: statePath,
    });
    const switched = await server.inject({
      method: 'POST',
      url: '/api/workspaces/select',
      payload: { path: workspaceB },
    });
    expect(switched.statusCode).toBe(200);
    await server.close();
  });

  it('returns a directory from the native picker without switching workspaces', async () => {
    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspaceA,
      workspaceStatePath: statePath,
      workspacePicker: async () => `${workspaceB}${path.sep}`,
    });
    const picked = await server.inject({
      method: 'POST',
      url: '/api/workspaces/pick',
    });
    expect(picked.statusCode).toBe(200);
    expect(JSON.parse(picked.body)).toEqual({ path: workspaceB });
    expect(JSON.parse((await server.inject({
      method: 'GET',
      url: '/api/workspaces',
    })).body).current).toBe(workspaceA);
    await server.close();
  });

  it('returns no content when the native picker is cancelled', async () => {
    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspaceA,
      workspaceStatePath: statePath,
      workspacePicker: async () => undefined,
    });
    const picked = await server.inject({
      method: 'POST',
      url: '/api/workspaces/pick',
    });
    expect(picked.statusCode).toBe(204);
    await server.close();
  });

  it('rejects cross-workspace switching with an absolute database path', async () => {
    configureSystem({
      storage: { databasePath: path.join(root, 'shared.db') },
      api: { logLevel: 'silent' },
    });
    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspaceA,
      workspaceStatePath: statePath,
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/workspaces/select',
      payload: { path: workspaceB },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain('相对路径');
    await server.close();
  });
});
