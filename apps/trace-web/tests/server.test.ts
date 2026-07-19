import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resetSharedConnection,
  configureSystem,
  getSharedConnection,
  ThreadStore,
  RunStore,
  TraceEventStore,
} from '@one-agent/agent-core';
import { buildTraceWebServer } from '../src/server.js';

describe('trace web server', () => {
  let servers: Array<ReturnType<typeof buildTraceWebServer>> = [];

  function buildServer() {
    const server = buildTraceWebServer();
    servers.push(server);
    return server;
  }

  beforeEach(() => {
    configureSystem({ storage: { databasePath: ':memory:' } });
    resetSharedConnection();
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    resetSharedConnection();
  });

  it('GET / returns the viewer HTML page', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('one-agent Trace Viewer');
    expect(response.body).toContain('/api/threads');
  });

  it('GET / escapes stored ids/errors for HTML, attribute, and JS-string contexts', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/' });
    const html = response.body;

    // escapeHtml must also neutralize quotes (attribute breakouts).
    expect(html).toContain(`return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');`);
    // DB ids must not be interpolated raw into onclick JS strings nor innerHTML:
    // JSON.stringify protects the JS-string context, escapeHtml the attribute
    // context. The old raw-interpolation forms must be gone.
    expect(html).toContain('selectThread(${escapeHtml(JSON.stringify(t.id))})');
    expect(html).toContain('selectRun(${escapeHtml(JSON.stringify(r.id))})');
    expect(html).not.toContain("selectThread('${t.id}')");
    expect(html).not.toContain("selectRun('${r.id}')");
    expect(html).not.toContain('<div class="item-meta">${t.id}');
    expect(html).not.toContain('<div class="item-meta">${r.status}');
  });

  it('GET /api/threads lists all threads', async () => {
    const db = getSharedConnection();
    const threadStore = new ThreadStore(db);
    threadStore.create({ title: 'First thread' });
    threadStore.create({ title: 'Second thread' });

    const server = buildServer();
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

    const server = buildServer();
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
    const server = buildServer();
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

    const server = buildServer();
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
    const server = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/runs/nonexistent/traces',
    });

    expect(response.statusCode).toBe(404);
  });

  it('GET /api/runs/:id/overview summarizes cost, failures, retries, and recovery', async () => {
    const db = getSharedConnection();
    const threadStore = new ThreadStore(db);
    const runStore = new RunStore(db);
    const traceEventStore = new TraceEventStore(db);
    const thread = threadStore.create({});
    const run = runStore.create({ threadId: thread.id, model: 'test-model', status: 'completed' });
    const base = { runId: run.id, threadId: thread.id, model: 'test-model' };

    traceEventStore.create({
      ...base,
      eventType: 'run',
      eventData: { type: 'run', phase: 'started', resumedFromRunId: 'previous-run' },
    });
    traceEventStore.create({
      ...base,
      eventType: 'model_call',
      eventData: {
        type: 'model_call', phase: 'started', modelCallId: 'm1', purpose: 'main',
        provider: 'test', model: 'test-model', attempt: 2, streaming: false,
        startedAt: new Date().toISOString(),
      },
    });
    traceEventStore.create({
      ...base,
      eventType: 'model_call',
      eventData: {
        type: 'model_call', phase: 'completed', modelCallId: 'm1', purpose: 'main',
        provider: 'test', model: 'test-model', attempt: 2, streaming: false,
        startedAt: new Date().toISOString(), usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    });
    traceEventStore.create({
      ...base,
      eventType: 'tool_call',
      eventData: { type: 'tool_call', toolCall: { id: 'c1', name: 'read_file', arguments: { path: 'missing.txt' } } },
    });
    traceEventStore.create({
      ...base,
      eventType: 'tool_result',
      eventData: { type: 'tool_result', toolCallId: 'c1', toolResult: { success: false, error: 'missing' } },
    });

    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: `/api/runs/${run.id}/overview` });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.run.id).toBe(run.id);
    expect(body.metrics).toMatchObject({
      eventCount: 5,
      modelCallCount: 1,
      modelFailureCount: 0,
      retryCount: 1,
      totalTokens: 30,
      toolCallCount: 1,
      toolFailureCount: 1,
    });
    expect(body.recovery.resumedFromRunId).toBe('previous-run');
  });

  it('GET /api/runs/:id/overview returns 404 for a missing run', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/runs/nonexistent/overview' });
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

    const server = buildServer();
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

  it('GET /api/runs/:id/traces round-trips the embedded sub-agent event stream', async () => {
    const db = getSharedConnection();
    const threadStore = new ThreadStore(db);
    const runStore = new RunStore(db);
    const traceEventStore = new TraceEventStore(db);
    const thread = threadStore.create({});
    const run = runStore.create({ threadId: thread.id, model: 'test', status: 'completed' });
    traceEventStore.create({
      runId: run.id,
      threadId: thread.id,
      eventType: 'sub_agent',
      eventData: {
        type: 'sub_agent',
        task: 'read a file',
        status: 'completed',
        reply: 'done',
        durationMs: 1200,
        events: [
          { type: 'tool_call', toolCall: { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } } },
          { type: 'tool_result', toolResult: { success: true, data: { content: 'file-data' } } },
          { type: 'message', content: 'done' },
        ],
      },
      model: 'test',
    });

    const server = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: `/api/runs/${run.id}/traces`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].eventType).toBe('sub_agent');
    const childEvents = body[0].eventData.events;
    expect(childEvents).toHaveLength(3);
    expect(childEvents[0].type).toBe('tool_call');
    expect(childEvents[0].toolCall.name).toBe('read_file');
  });

  it('GET / includes the nested sub-agent rendering hooks', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('renderSubAgentChildren');
    expect(response.body).toContain('event-children');
    expect(response.body).toContain('.timeline-seg.sub_agent');
    expect(response.body).toContain('.filter-btn.sub_agent');
  });

  it('GET / includes run overview and stable run selection hooks', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('/api/runs/${id}/overview');
    expect(response.body).toContain('renderRunOverview');
    expect(response.body).toContain('data-run-id="${escapeHtml(r.id)}"');
    expect(response.body).toContain("el.dataset.runId === id");
  });
});
