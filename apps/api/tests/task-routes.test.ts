import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resetSharedConnection,
  SqliteTaskStore,
  getSharedConnection,
  config,
  OpenAICompatibleProvider,
} from '@one-agent/agent-core';
import { buildServer } from '../src/server.js';

const mockCreate = vi.fn();

// vi.mock('openai') cannot reach the externalized workspace dist, so the
// tests below used to run tasks against the REAL OpenAI client (401s),
// masked by a vacuous waiter. Mutate the shared config object instead —
// module-runner independent.
const originalOpenai = config.openai;
const originalProvider = config.modelProvider;

function stubModelClient(): void {
  config.openai = { chat: { completions: { create: mockCreate } } } as never;
  config.modelProvider = new OpenAICompatibleProvider(config.openai as never, config.model);
}

async function waitForStatus(
  server: Awaited<ReturnType<typeof buildServer>>,
  taskId: string,
  expected: string
): Promise<void> {
  await vi.waitFor(
    async () => {
      const status = await server.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
      const actual = JSON.parse(status.body).status;
      if (actual !== expected) {
        throw new Error(`task ${taskId} is ${actual}, waiting for ${expected}`);
      }
    },
    { timeout: 5000 }
  );
}

describe('task routes', () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    resetSharedConnection();
    mockCreate.mockReset();
    stubModelClient();
  });

  afterEach(() => {
    config.openai = originalOpenai;
    config.modelProvider = originalProvider;
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

    await waitForStatus(server, taskId, 'completed');
    const response = await server.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    const body = JSON.parse(response.body);
    expect(body.status).toBe('completed');
    expect(body.completionOutcome).toBeUndefined();
  });

  it('GET /api/tasks/:id/events streams agent events and a terminal frame', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello from SSE' } }],
    } as never);

    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Hi' },
    });
    const { taskId } = JSON.parse(created.body);

    await waitForStatus(server, taskId, 'completed');

    const response = await server.inject({ method: 'GET', url: `/api/tasks/${taskId}/events` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    // Agent events are replayed, then the terminal task frame closes the stream.
    expect(response.body).toContain('"type":"agent"');
    expect(response.body).toContain('"type":"task"');
    expect(response.body).toContain('"status":"completed"');
    expect(response.body).toContain('Hello from SSE');
    expect(response.body).not.toContain('"outcome"');
  });

  it('correlates persisted task traces with the task id', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Done' } }],
    } as never);

    const server = await buildServer();
    const chat = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Create a thread' },
    });
    const { threadId } = JSON.parse(chat.body);

    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'Run in the thread', threadId },
    });
    const { taskId } = JSON.parse(created.body);
    await waitForStatus(server, taskId, 'completed');

    const response = await server.inject({ method: 'GET', url: `/api/tasks/${taskId}/traces` });
    const traces = JSON.parse(response.body);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((trace: { taskId: string }) => trace.taskId === taskId)).toBe(true);
    expect(traces.some((trace: { eventType: string }) => trace.eventType === 'run')).toBe(true);
    expect(traces.some((trace: { eventType: string }) => trace.eventType === 'model_call')).toBe(true);
    expect(traces.some((trace: { eventType: string }) => trace.eventType === 'verification')).toBe(false);
  });

  it('GET /api/tasks/:id/events returns 404 for unknown tasks', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/tasks/nope/events' });
    expect(response.statusCode).toBe(404);
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

    await waitForStatus(server, taskId, 'completed');
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
