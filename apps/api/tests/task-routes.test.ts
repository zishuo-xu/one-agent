import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSharedConnection, SqliteTaskStore, getSharedConnection } from '@one-agent/agent-core';
import { buildServer } from '../src/server.js';

const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  },
}));

describe('task routes', () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    resetSharedConnection();
    mockCreate.mockReset();
  });

  afterEach(() => {
    resetSharedConnection();
  });

  it('POST /api/tasks creates a task', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.taskId).toBeDefined();
    expect(body.status).toBe('pending');
  });

  it('GET /api/tasks/:id returns task status', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello' } }],
    } as never);

    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi' },
    });
    const { taskId } = JSON.parse(created.body);

    await vi.waitFor(
      async () => {
        const status = await server.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
        return JSON.parse(status.body).status === 'completed';
      },
      { timeout: 1000 }
    );
  });

  it('GET /api/tasks returns all tasks', async () => {
    const server = await buildServer();
    await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'First' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Second' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(2);
    const messages = body.map((t: { message: string }) => t.message);
    expect(messages).toContain('First');
    expect(messages).toContain('Second');
  });

  it('POST /api/tasks/:id/cancel cancels a pending task', async () => {
    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi' },
    });
    const { taskId } = JSON.parse(created.body);

    const response = await server.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/cancel`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('cancelled');
  });

  it('GET /api/tasks?status=dead_letter lists dead letter tasks', async () => {
    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi' },
    });
    const { taskId } = JSON.parse(created.body);

    const taskStore = new SqliteTaskStore(getSharedConnection());
    taskStore.update(taskId, { status: 'dead_letter', failedReason: 'test' });

    const response = await server.inject({
      method: 'GET',
      url: '/api/tasks?status=dead_letter',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(taskId);
    expect(body[0].status).toBe('dead_letter');
  });

  it('POST /api/tasks/:id/retry retries a dead letter task', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello' } }],
    } as never);

    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi' },
    });
    const { taskId } = JSON.parse(created.body);

    const taskStore = new SqliteTaskStore(getSharedConnection());
    taskStore.update(taskId, { status: 'dead_letter', failedReason: 'test' });

    const retryResponse = await server.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/retry`,
    });
    expect(retryResponse.statusCode).toBe(200);
    const retryBody = JSON.parse(retryResponse.body);
    expect(retryBody.status).toBe('pending');

    await vi.waitFor(
      async () => {
        const status = await server.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
        return JSON.parse(status.body).status === 'completed';
      },
      { timeout: 2000 }
    );
  });

  it('POST /api/tasks returns the same taskId for the same idempotencyKey', async () => {
    const server = await buildServer();

    const first = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi', idempotencyKey: 'unique-key-123' },
    });
    const second = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi again', idempotencyKey: 'unique-key-123' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(first.body).taskId).toBe(JSON.parse(second.body).taskId);
  });

  it('POST /api/tasks creates different tasks for different idempotency keys', async () => {
    const server = await buildServer();

    const first = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi', idempotencyKey: 'key-a' },
    });
    const second = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi', idempotencyKey: 'key-b' },
    });

    expect(JSON.parse(first.body).taskId).not.toBe(JSON.parse(second.body).taskId);
  });
});
