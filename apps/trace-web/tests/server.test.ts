import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resetSharedConnection,
  getSharedConnection,
  ThreadStore,
  RunStore,
  TraceEventStore,
} from '@one-agent/agent-core';
import { buildTraceWebServer } from '../src/server.js';

describe('trace web server', () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    resetSharedConnection();
  });

  afterEach(() => {
    resetSharedConnection();
  });

  it('GET / returns the viewer HTML page', async () => {
    const server = buildTraceWebServer();
    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('one-agent Trace Viewer');
    expect(response.body).toContain('/api/threads');
  });

  it('GET /api/threads lists all threads', async () => {
    const db = getSharedConnection();
    const threadStore = new ThreadStore(db);
    threadStore.create({ title: 'First thread' });
    threadStore.create({ title: 'Second thread' });

    const server = buildTraceWebServer();
    const response = await server.inject({ method: 'GET', url: '/api/threads' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(2);
    const titles = body.map((t: { title: string }) => t.title);
    expect(titles).toContain('First thread');
    expect(titles).toContain('Second thread');
  });

  it('GET /api/threads/:id/runs returns runs for a thread', async () => {
    const db = getSharedConnection();
    const threadStore = new ThreadStore(db);
    const runStore = new RunStore(db);
    const thread = threadStore.create({});
    runStore.create({ threadId: thread.id, model: 'test', status: 'completed' });

    const server = buildTraceWebServer();
    const response = await server.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/runs`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].threadId).toBe(thread.id);
  });

  it('GET /api/threads/:id/runs returns 404 for missing thread', async () => {
    const server = buildTraceWebServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/threads/nonexistent/runs',
    });

    expect(response.statusCode).toBe(404);
  });

  it('GET /api/runs/:id/traces returns trace events for a run', async () => {
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

    const server = buildTraceWebServer();
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

  it('GET /api/runs/:id/traces returns 404 for missing run', async () => {
    const server = buildTraceWebServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/runs/nonexistent/traces',
    });

    expect(response.statusCode).toBe(404);
  });

  it('GET /api/threads/:id/traces returns trace events for a thread', async () => {
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

    const server = buildTraceWebServer();
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
});
