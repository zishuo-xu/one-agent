import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, createConnection } from '@one-agent/agent-core';
import { memoryRoutes } from '../src/routes/memory.js';

describe('memory document routes', () => {
  let root: string;
  let server: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-api-memory-'));
    server = Fastify({ logger: false });
    const runtime = new AgentRuntime({ workspaceRoot: root, db: createConnection({ path: ':memory:' }) });
    await server.register(memoryRoutes, { runtime });
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the workspace memory document and its visible path', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/memory/workspace' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      scope: 'workspace',
      content: '# Workspace Memory\n',
      path: path.join(root, '.one-agent', 'MEMORY.md'),
    });
  });

  it('replaces a document with optimistic browser conflict protection', async () => {
    const initial = JSON.parse((await server.inject({
      method: 'GET', url: '/api/memory/workspace',
    })).body) as { hash: string };
    const saved = await server.inject({
      method: 'PUT',
      url: '/api/memory/workspace',
      payload: { content: '# Workspace Memory\n\n- Use pnpm.\n', expectedHash: initial.hash },
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.body).content).toContain('Use pnpm');

    const conflict = await server.inject({
      method: 'PUT',
      url: '/api/memory/workspace',
      payload: { content: '# Workspace Memory\n\n- stale edit\n', expectedHash: initial.hash },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('validates scope and Markdown content', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/memory/thread' })).statusCode).toBe(400);
    expect((await server.inject({
      method: 'PUT', url: '/api/memory/workspace', payload: { content: '' },
    })).statusCode).toBe(400);
  });
});
