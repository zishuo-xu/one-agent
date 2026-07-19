import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureSystem, resetSharedConnection, getSharedConnection, RunStore, SqliteTaskStore, ThreadStore, TraceEventStore } from '@one-agent/agent-core';
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

describe('trace routes', () => {
  beforeEach(() => {
    configureSystem({ storage: { databasePath: ':memory:' } });
    resetSharedConnection();
  });

  afterEach(() => {
    resetSharedConnection();
  });

  it('GET /api/runs/:id/traces returns 404 for missing run', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/runs/nonexistent/traces',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Run not found');
  });

  it('GET /api/runs/:id/traces returns trace events for a run', async () => {
    const server = await buildServer();
    const db = getSharedConnection();
    const threadStore = new ThreadStore(db);
    const runStore = new RunStore(db);
    const traceEventStore = new TraceEventStore(db);

    const thread = threadStore.create({});
    const run = runStore.create({ threadId: thread.id, model: 'test', status: 'completed' });
    traceEventStore.create({
      runId: run.id,
      threadId: thread.id,
      eventType: 'message',
      eventData: { type: 'message', content: 'Hello' },
      model: 'test',
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/runs/${run.id}/traces`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe(run.id);
    expect(body[0].eventType).toBe('message');
  });

  it('GET /api/tasks/:id/traces returns trace events for a task', async () => {
    const server = await buildServer();
    const db = getSharedConnection();
    const threadStore = new ThreadStore(db);
    const taskStore = new SqliteTaskStore(db);
    const runStore = new RunStore(db);
    const traceEventStore = new TraceEventStore(db);

    const thread = threadStore.create({});
    const task = taskStore.create({ threadId: thread.id, message: 'Hello' });
    const run = runStore.create({ threadId: thread.id, taskId: task.id, model: 'test', status: 'completed' });
    traceEventStore.create({
      runId: run.id,
      taskId: task.id,
      threadId: thread.id,
      eventType: 'tool_call',
      eventData: { type: 'tool_call', toolCall: { id: 'c1', name: 'echo' } },
      model: 'test',
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/traces`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].taskId).toBe(task.id);
    expect(body[0].eventType).toBe('tool_call');
  });

  it('GET /api/tasks/:id/traces returns 404 for missing task', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/tasks/nonexistent/traces',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Task not found');
  });

  it('GET /api/threads/:id/traces returns trace events for a thread', async () => {
    const server = await buildServer();
    const db = getSharedConnection();
    const threadStore = new ThreadStore(db);
    const runStore = new RunStore(db);
    const traceEventStore = new TraceEventStore(db);

    const thread = threadStore.create({});
    const run = runStore.create({ threadId: thread.id, model: 'test', status: 'completed' });
    traceEventStore.create({
      runId: run.id,
      threadId: thread.id,
      eventType: 'plan',
      eventData: { type: 'plan', plan: { steps: [] } },
      model: 'test',
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/traces`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].threadId).toBe(thread.id);
    expect(body[0].eventType).toBe('plan');
  });

  it('GET /api/threads/:id/traces returns 404 for missing thread', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/threads/nonexistent/traces',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Thread not found');
  });
});
