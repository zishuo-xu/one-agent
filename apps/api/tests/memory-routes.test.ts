import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSharedConnection } from '@one-agent/agent-core';
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
    process.env.DATABASE_PATH = ':memory:';
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
