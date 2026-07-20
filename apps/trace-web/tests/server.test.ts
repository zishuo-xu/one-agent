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
    expect(response.body).toContain('Memory Documents');
    expect(response.body).toContain("/api/memory/");
  });

  it('GET /api/memory/workspace exposes the user-visible folder document', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/memory/workspace' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      scope: 'workspace',
      content: '# Workspace Memory\n',
    });
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

  it('GET /api/threads/:id/approvals projects approved, rejected, and waiting chains across runs', async () => {
    const db = getSharedConnection();
    const thread = new ThreadStore(db).create({});
    const runStore = new RunStore(db);
    const traceStore = new TraceEventStore(db);
    const requestRun = runStore.create({ threadId: thread.id, model: 'test', status: 'waiting_for_input' });
    const approvedRun = runStore.create({ threadId: thread.id, model: 'test', status: 'completed' });
    const rejectedRequestRun = runStore.create({ threadId: thread.id, model: 'test', status: 'waiting_for_input' });
    const rejectedRun = runStore.create({ threadId: thread.id, model: 'test', status: 'completed' });
    const waitingRun = runStore.create({ threadId: thread.id, model: 'test', status: 'waiting_for_input' });
    const base = (runId: string) => ({ runId, threadId: thread.id, model: 'test' });

    traceStore.create({
      ...base(requestRun.id),
      eventType: 'input_required',
      eventData: {
        type: 'input_required',
        request: {
          id: 'approval-approved',
          kind: 'tool_approval',
          question: 'Allow command?',
          createdAt: new Date().toISOString(),
          approval: {
            toolCall: { id: 'command-1', name: 'run_command', arguments: { command: 'pwd' } },
            fingerprint: 'fingerprint-1',
          },
        },
      },
    });
    traceStore.create({
      ...base(approvedRun.id),
      eventType: 'input_received',
      eventData: { type: 'input_received', requestId: 'approval-approved' },
    });
    traceStore.create({
      ...base(approvedRun.id),
      eventType: 'tool_policy',
      eventData: {
        type: 'tool_policy', toolCallId: 'command-1:approved:1', toolName: 'run_command',
        decision: 'allow', approved: true,
      },
    });
    traceStore.create({
      ...base(approvedRun.id),
      eventType: 'tool_result',
      eventData: {
        type: 'tool_result', toolCallId: 'command-1:approved:1', status: 'succeeded',
        toolResult: { success: true, data: { stdout: '/workspace' } },
      },
    });

    traceStore.create({
      ...base(rejectedRequestRun.id),
      eventType: 'input_required',
      eventData: {
        type: 'input_required',
        request: {
          id: 'approval-rejected',
          kind: 'tool_approval',
          question: 'Allow deletion?',
          createdAt: new Date().toISOString(),
          approval: {
            toolCall: { id: 'delete-1', name: 'delete_file', arguments: { path: 'keep.txt' } },
            fingerprint: 'fingerprint-2',
          },
        },
      },
    });
    traceStore.create({
      ...base(rejectedRun.id),
      eventType: 'input_received',
      eventData: { type: 'input_received', requestId: 'approval-rejected' },
    });
    traceStore.create({
      ...base(rejectedRun.id),
      eventType: 'tool_result',
      eventData: {
        type: 'tool_result', toolCallId: 'delete-1', status: 'rejected',
        toolResult: { success: false, error: 'Tool execution rejected by user.' },
      },
    });

    traceStore.create({
      ...base(waitingRun.id),
      eventType: 'input_required',
      eventData: {
        type: 'input_required',
        request: {
          id: 'approval-waiting',
          kind: 'tool_approval',
          question: 'Allow deletion?',
          createdAt: new Date().toISOString(),
          approval: {
            toolCall: { id: 'delete-2', name: 'delete_file', arguments: { path: 'old.txt' } },
            fingerprint: 'fingerprint-3',
          },
        },
      },
    });

    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: `/api/threads/${thread.id}/approvals` });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requestId: 'approval-approved', decision: 'approved', execution: 'succeeded',
        requestRunId: requestRun.id, responseRunId: approvedRun.id,
      }),
      expect.objectContaining({
        requestId: 'approval-rejected', decision: 'rejected', execution: 'not_executed',
        requestRunId: rejectedRequestRun.id, responseRunId: rejectedRun.id,
      }),
      expect.objectContaining({
        requestId: 'approval-waiting', decision: 'waiting', execution: 'pending',
        requestRunId: waitingRun.id,
      }),
    ]));
  });

  it('GET /api/threads/:id/approvals returns 404 for a missing thread', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/threads/nonexistent/approvals' });
    expect(response.statusCode).toBe(404);
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
    expect(response.body).toContain('renderApprovalTimeline');
    expect(response.body).toContain('/api/threads/${selectedThreadId}/approvals');
    expect(response.body).toContain('Approval flow');
  });
});
