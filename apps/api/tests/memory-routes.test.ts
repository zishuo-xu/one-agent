import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureSystem, resetSharedConnection } from '@one-agent/agent-core';
import { buildServer } from '../src/server.js';

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn(),
      },
    };
  },
}));

describe('memory routes', () => {
  beforeEach(() => {
    configureSystem({ storage: { databasePath: ':memory:' } });
    resetSharedConnection();
  });

  afterEach(() => {
    resetSharedConnection();
  });

  it('POST /api/memories creates a memory', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'language', value: 'Chinese', source: 'test' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.id).toBeDefined();
    expect(body.key).toBe('language');
    expect(body.value).toBe('Chinese');
    expect(body.source).toBe('test');
    expect(body).toMatchObject({
      scope: 'global',
      confidence: 0.7,
      status: 'active',
      governanceAction: 'created',
    });
  });

  it('POST /api/memories validates key and value', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'language' },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('key and value are required');
  });

  it('GET /api/memories lists all memories', async () => {
    const server = await buildServer();
    await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'language', value: 'Chinese' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'stack', value: 'TypeScript' },
    });

    const response = await server.inject({ method: 'GET', url: '/api/memories' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(2);
    const keys = body.map((m: { key: string }) => m.key);
    expect(keys).toContain('language');
    expect(keys).toContain('stack');
  });

  it('GET /api/memories?query= returns relevant memories', async () => {
    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'language', value: 'Chinese' },
    });
    const { id: memoryId } = JSON.parse(created.body);

    await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'stack', value: 'TypeScript' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/memories?query=language',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(memoryId);
  });

  it('governs conflicts and exposes lifecycle filters', async () => {
    const server = await buildServer();
    const first = await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: {
        key: 'timezone', value: 'Shanghai', confidence: 0.9,
        observedAt: '2026-07-10T00:00:00.000Z',
      },
    });
    const firstBody = JSON.parse(first.body);
    const conflict = await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: {
        key: 'timezone', value: 'Tokyo', confidence: 0.4,
        observedAt: '2026-07-01T00:00:00.000Z',
      },
    });
    expect(conflict.statusCode).toBe(200);
    expect(JSON.parse(conflict.body)).toMatchObject({
      status: 'superseded',
      governanceAction: 'rejected',
      supersededById: firstBody.id,
    });

    const active = await server.inject({ method: 'GET', url: '/api/memories?status=active' });
    expect(JSON.parse(active.body).map((memory: { id: string }) => memory.id)).toEqual([firstBody.id]);
    const historical = await server.inject({ method: 'GET', url: '/api/memories?status=superseded' });
    expect(JSON.parse(historical.body)).toHaveLength(1);
  });

  it('isolates thread-scoped query recall', async () => {
    const server = await buildServer();
    await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'project language', value: 'Rust', scope: 'thread', threadId: 'thread-1' },
    });

    const visible = await server.inject({
      method: 'GET',
      url: '/api/memories?query=language&threadId=thread-1',
    });
    expect(JSON.parse(visible.body)).toHaveLength(1);
    const hidden = await server.inject({
      method: 'GET',
      url: '/api/memories?query=language&threadId=thread-2',
    });
    expect(JSON.parse(hidden.body)).toEqual([]);
  });

  it('PATCH /api/memories/:id updates governance metadata', async () => {
    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'language', value: 'Chinese' },
    });
    const { id } = JSON.parse(created.body);

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/memories/${id}`,
      payload: { confidence: 0.95, status: 'expired', value: 'Simplified Chinese' },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      confidence: 0.95,
      status: 'expired',
      value: 'Simplified Chinese',
    });
  });

  it('GET /api/memories/:id returns a single memory', async () => {
    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'language', value: 'Chinese' },
    });
    const { id: memoryId } = JSON.parse(created.body);

    const response = await server.inject({ method: 'GET', url: `/api/memories/${memoryId}` });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.key).toBe('language');
  });

  it('GET /api/memories/:id returns 404 for missing memory', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/memories/nonexistent' });
    expect(response.statusCode).toBe(404);
  });

  it('DELETE /api/memories/:id removes a memory', async () => {
    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { key: 'language', value: 'Chinese' },
    });
    const { id: memoryId } = JSON.parse(created.body);

    const deleteResponse = await server.inject({ method: 'DELETE', url: `/api/memories/${memoryId}` });
    expect(deleteResponse.statusCode).toBe(204);

    const getResponse = await server.inject({ method: 'GET', url: `/api/memories/${memoryId}` });
    expect(getResponse.statusCode).toBe(404);
  });
});
