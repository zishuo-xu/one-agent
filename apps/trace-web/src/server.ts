import Fastify, { FastifyInstance } from 'fastify';
import {
  getSharedConnection,
  RunStore,
  ThreadStore,
  TraceEventStore,
  MessageStore,
} from '@one-agent/agent-core';
import type { AgentRun, TraceEvent } from '@one-agent/agent-core';

export interface TraceWebServerOptions {
  port: number;
  host: string;
}

export interface RunOverview {
  run: AgentRun;
  metrics: {
    durationMs: number;
    eventCount: number;
    modelCallCount: number;
    modelFailureCount: number;
    retryCount: number;
    totalTokens: number;
    toolCallCount: number;
    toolFailureCount: number;
  };
  recovery: {
    resumedFromRunId?: string;
    resumedByRunIds: string[];
  };
}

/** Build a read-only summary from persisted facts; it never changes Run state. */
export function buildRunOverview(
  run: AgentRun,
  traces: TraceEvent[],
  threadRuns: AgentRun[],
): RunOverview {
  const modelEvents = traces.filter((event) => event.eventType === 'model_call');
  const modelStarts = modelEvents.filter((event) => event.eventData.type === 'model_call' && event.eventData.phase === 'started');
  const modelTerminals = modelEvents.filter((event) => event.eventData.type === 'model_call' && event.eventData.phase !== 'started');
  const toolResults = traces.filter((event) => event.eventType === 'tool_result');
  const endMs = run.endTime
    ? Date.parse(run.endTime)
    : traces.length > 0
      ? Date.parse(traces[traces.length - 1].createdAt)
      : Date.parse(run.startTime);
  const startMs = Date.parse(run.startTime);
  const resumedFromTrace = traces.find(
    (event) => event.eventData.type === 'run' && event.eventData.phase === 'started' && event.eventData.resumedFromRunId,
  );
  const resumedFromRunId = run.checkpoint?.resumedFromRunId
    ?? (resumedFromTrace?.eventData.type === 'run' ? resumedFromTrace.eventData.resumedFromRunId : undefined);

  return {
    run,
    metrics: {
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
      eventCount: traces.length,
      modelCallCount: modelStarts.length,
      modelFailureCount: modelTerminals.filter(
        (event) => event.eventData.type === 'model_call' && event.eventData.phase === 'failed',
      ).length,
      retryCount: modelStarts.filter(
        (event) => event.eventData.type === 'model_call' && event.eventData.attempt > 1,
      ).length,
      totalTokens: modelTerminals.reduce((total, event) => {
        if (event.eventData.type !== 'model_call' || event.eventData.phase !== 'completed') return total;
        return total + (event.eventData.usage?.totalTokens ?? 0);
      }, 0),
      toolCallCount: traces.filter((event) => event.eventType === 'tool_call').length,
      toolFailureCount: toolResults.filter(
        (event) => event.eventData.type === 'tool_result' && !event.eventData.toolResult.success,
      ).length,
    },
    recovery: {
      resumedFromRunId,
      resumedByRunIds: threadRuns
        .filter((candidate) => candidate.checkpoint?.resumedFromRunId === run.id)
        .map((candidate) => candidate.id),
    },
  };
}

export function buildTraceWebServer(): FastifyInstance {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  const db = getSharedConnection();
  const threadStore = new ThreadStore(db);
  const runStore = new RunStore(db);
  const traceEventStore = new TraceEventStore(db);
  const messageStore = new MessageStore(db);

  fastify.get('/api/threads', async () => {
    return threadStore.list();
  });

  fastify.get<{ Params: { id: string } }>('/api/threads/:id/runs', async (request, reply) => {
    const { id } = request.params;
    const thread = threadStore.getById(id);
    if (!thread) {
      return reply.status(404).send({ error: `Thread not found: ${id}` });
    }
    const runs = runStore.getByThread(id);
    // Match each run to the user question that triggered it by chronological
    // order (both runs and user messages are sequential per thread).
    const userMessages = messageStore
      .getByThread(id)
      .filter((m) => m.role === 'user' && !m.content.startsWith('Execute the following step'));

    // Runs come back DESC (newest first); reverse to match ascending user messages.
    const runsAsc = [...runs].reverse();

    return runs.map((run) => {
      const runIdx = runsAsc.indexOf(run);
      const userMsg = userMessages[runIdx];
      const prompt = userMsg
        ? userMsg.content.replace(/\n/g, ' ').slice(0, 120)
        : '';
      return { ...run, preview: prompt || run.status };
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/threads/:id/traces', async (request, reply) => {
    const { id } = request.params;
    const thread = threadStore.getById(id);
    if (!thread) {
      return reply.status(404).send({ error: `Thread not found: ${id}` });
    }
    return traceEventStore.getByThread(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id/traces', async (request, reply) => {
    const { id } = request.params;
    const run = runStore.getById(id);
    if (!run) {
      return reply.status(404).send({ error: `Run not found: ${id}` });
    }
    return traceEventStore.getByRun(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id/overview', async (request, reply) => {
    const { id } = request.params;
    const run = runStore.getById(id);
    if (!run) {
      return reply.status(404).send({ error: `Run not found: ${id}` });
    }
    return buildRunOverview(run, traceEventStore.getByRun(id), runStore.getByThread(run.threadId));
  });

  fastify.get('/', async (request, reply) => {
    return reply.type('text/html').send(renderViewerPage());
  });

  return fastify;
}

export async function startTraceWebServer(options: TraceWebServerOptions): Promise<void> {
  const server = buildTraceWebServer();
  await server.listen({ port: options.port, host: options.host });
  console.log(`Trace viewer running at http://${options.host}:${options.port}`);
}

function renderViewerPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>one-agent Trace Viewer</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --panel-hover: #334155;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --border: #334155;
      --plan: #8b5cf6;
      --thought: #3b82f6;
      --tool_call: #f59e0b;
      --tool_result: #10b981;
      --message: #ec4899;
      --reflection: #6366f1;
      --message_delta: #64748b;
      --failed: #ef4444;
      --sub_agent: #14b8a6;
      --verification: #22c55e;
      --run: #f8fafc;
      --model_call: #06b6d4;
      --plan_step: #a78bfa;
      --warning: #f97316;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      overflow: hidden;
    }
    .container {
      display: flex;
      height: 100vh;
    }
    .sidebar, .runs, .timeline {
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--border);
      overflow: hidden;
    }
    .sidebar { width: 280px; flex-shrink: 0; }
    .runs { width: 320px; flex-shrink: 0; }
    .timeline { flex: 1; border-right: none; }
    .header {
      padding: 16px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header h1 { margin: 0; font-size: 16px; }
    .list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .item {
      padding: 10px 12px;
      margin-bottom: 6px;
      border-radius: 8px;
      cursor: pointer;
      background: var(--panel);
      border: 1px solid transparent;
      transition: background 0.15s, border-color 0.15s;
      word-break: break-all;
    }
    .item:hover { background: var(--panel-hover); }
    .item.active {
      background: var(--panel-hover);
      border-color: var(--thought);
    }
    .item.failed {
      border-left: 3px solid var(--failed);
    }
    .item.interrupted, .item.recovery_required { border-left: 3px solid var(--warning); }
    .status-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10px;
      line-height: 1.4;
      background: var(--panel-hover);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .status-badge.completed { color: #6ee7b7; background: #064e3b; }
    .status-badge.failed { color: #fca5a5; background: #7f1d1d; }
    .status-badge.running, .status-badge.pending { color: #67e8f9; background: #164e63; }
    .status-badge.interrupted, .status-badge.recovery_required { color: #fdba74; background: #7c2d12; }
    .item-error {
      font-size: 12px;
      color: var(--failed);
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item-title { font-size: 14px; margin-bottom: 4px; }
    .item-meta { font-size: 12px; color: var(--muted); }
    .empty {
      padding: 40px 20px;
      text-align: center;
      color: var(--muted);
    }
    .event-list {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }
    .event {
      position: relative;
      padding: 14px 16px;
      margin-bottom: 12px;
      background: var(--panel);
      border-radius: 10px;
      border-left: 4px solid var(--muted);
    }
    .event.plan { border-left-color: var(--plan); }
    .event.thought { border-left-color: var(--thought); }
    .event.tool_call { border-left-color: var(--tool_call); }
    .event.tool_result { border-left-color: var(--tool_result); }
    .event.message { border-left-color: var(--message); }
    .event.reflection { border-left-color: var(--reflection); }
    .event.message_delta { border-left-color: var(--message_delta); }
    .event.sub_agent { border-left-color: var(--sub_agent); }
    .event.verification { border-left-color: var(--verification); }
    .event.run { border-left-color: var(--run); }
    .event.model_call { border-left-color: var(--model_call); }
    .event.plan_step { border-left-color: var(--plan_step); }
    .event-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .event-type {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: var(--panel-hover);
    }
    .event-time { font-size: 12px; color: var(--muted); }
    .event-data {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text);
      background: var(--bg);
      padding: 10px;
      border-radius: 6px;
      max-height: 240px;
      overflow-y: auto;
    }
    .toolbar {
      display: flex;
      gap: 8px;
    }
    button {
      background: var(--panel-hover);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover { background: var(--border); }
    .breadcrumbs {
      font-size: 13px;
      color: var(--muted);
      font-weight: normal;
    }
    .run-overview {
      display: none;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      background: rgba(30, 41, 59, 0.72);
    }
    .overview-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .overview-title { min-width: 0; }
    .overview-id {
      margin-top: 4px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(80px, 1fr));
      gap: 8px;
    }
    .metric {
      min-width: 0;
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
    }
    .metric-value { font-size: 16px; font-weight: 650; }
    .metric-label { margin-top: 2px; font-size: 10px; color: var(--muted); }
    .metric.warning .metric-value { color: #fdba74; }
    .recovery-links {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
      font-size: 11px;
      color: var(--muted);
    }
    .run-link {
      color: #93c5fd;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    /* Visual timeline bar */
    .timeline-bar {
      display: flex;
      height: 32px;
      background: var(--bg);
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 12px;
      cursor: pointer;
    }
    .timeline-seg {
      height: 100%;
      min-width: 2px;
      opacity: 0.85;
      transition: opacity 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      color: transparent;
      overflow: hidden;
    }
    .timeline-seg:hover { opacity: 1; color: #fff; }
    .timeline-seg.plan { background: var(--plan); }
    .timeline-seg.thought { background: var(--thought); }
    .timeline-seg.tool_call { background: var(--tool_call); }
    .timeline-seg.tool_result { background: var(--tool_result); }
    .timeline-seg.message { background: var(--message); }
    .timeline-seg.reflection { background: var(--reflection); }
    .timeline-seg.message_delta { background: var(--message_delta); }
    .timeline-seg.reasoning_delta { background: #475569; }
    .timeline-seg.sub_agent { background: var(--sub_agent); }
    .timeline-seg.verification { background: var(--verification); }
    .timeline-seg.run { background: var(--run); }
    .timeline-seg.model_call { background: var(--model_call); }
    .timeline-seg.plan_step { background: var(--plan_step); }
    /* Filter buttons */
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 8px 0;
    }
    .filter-btn {
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      border: 1px solid var(--border);
      background: var(--panel);
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.15s;
    }
    .filter-btn.active { opacity: 1; }
    .filter-btn.plan { border-color: var(--plan); }
    .filter-btn.thought { border-color: var(--thought); }
    .filter-btn.tool_call { border-color: var(--tool_call); }
    .filter-btn.tool_result { border-color: var(--tool_result); }
    .filter-btn.message { border-color: var(--message); }
    .filter-btn.reflection { border-color: var(--reflection); }
    .filter-btn.message_delta { border-color: var(--message_delta); }
    .filter-btn.reasoning_delta { border-color: #475569; }
    .filter-btn.sub_agent { border-color: var(--sub_agent); }
    .filter-btn.verification { border-color: var(--verification); }
    .filter-btn.run { border-color: var(--run); }
    .filter-btn.model_call { border-color: var(--model_call); }
    .filter-btn.plan_step { border-color: var(--plan_step); }
    /* Collapsible events */
    .event { cursor: pointer; }
    .event .event-full { display: none; margin-top: 8px; }
    .event.expanded .event-full { display: block; }
    .event.expanded .event-data { display: none; }
    /* Nested sub-agent events (shown alongside the raw JSON when expanded) */
    .event .event-children { display: none; margin-top: 8px; }
    .event.expanded .event-children { display: block; }
    .event-children .children-title {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .event-children .child-event {
      border-left: 3px solid var(--muted);
      background: var(--bg);
      border-radius: 0 6px 6px 0;
      padding: 6px 10px;
      margin-bottom: 4px;
      cursor: default;
    }
    .event-children .child-event.plan { border-left-color: var(--plan); }
    .event-children .child-event.thought { border-left-color: var(--thought); }
    .event-children .child-event.tool_call { border-left-color: var(--tool_call); }
    .event-children .child-event.tool_result { border-left-color: var(--tool_result); }
    .event-children .child-event.message { border-left-color: var(--message); }
    .event-children .child-event.reflection { border-left-color: var(--reflection); }
    .event-children .child-event.verification { border-left-color: var(--verification); }
    .event-children .child-header { margin-bottom: 2px; }
    .event-children .child-preview {
      font-size: 12px;
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
    }
    @media (max-width: 1100px) {
      .sidebar { width: 220px; }
      .runs { width: 260px; }
      .metrics { grid-template-columns: repeat(3, minmax(80px, 1fr)); }
    }
    @media (max-width: 760px) {
      body { height: auto; overflow: auto; }
      .container { display: block; height: auto; }
      .sidebar, .runs, .timeline { width: 100%; height: auto; max-height: none; border-right: none; border-bottom: 1px solid var(--border); }
      .sidebar, .runs { max-height: 34vh; }
      .timeline { min-height: 70vh; }
      .list, .event-list { max-height: inherit; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <div class="header">
        <h1>Threads</h1>
        <div class="toolbar">
          <button onclick="refreshThreads()">↻</button>
        </div>
      </div>
      <div id="threads" class="list">
        <div class="empty">Loading threads...</div>
      </div>
    </div>
    <div class="runs">
      <div class="header">
        <h1>Runs</h1>
        <div class="breadcrumbs" id="run-breadcrumb"></div>
      </div>
      <div id="runs" class="list">
        <div class="empty">Select a thread to see runs</div>
      </div>
    </div>
    <div class="timeline">
      <div class="header">
        <h1>Trace Timeline</h1>
        <div class="toolbar">
          <button onclick="refreshTraces()">Refresh</button>
          <button onclick="showAllThreadTraces()">All traces</button>
        </div>
      </div>
      <div id="run-overview" class="run-overview"></div>
      <div id="filters" class="filters" style="padding: 8px 16px; display: none;"></div>
      <div id="timeline-bar-container" style="padding: 0 16px; display: none;">
        <div id="timeline-bar" class="timeline-bar"></div>
      </div>
      <div id="timeline" class="event-list">
        <div class="empty">Select a run to view traces</div>
      </div>
    </div>
  </div>

  <script>
    let selectedThreadId = null;
    let selectedRunId = null;

    async function fetchJson(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      return res.json();
    }

    async function refreshThreads() {
      const threads = await fetchJson('/api/threads');
      const container = document.getElementById('threads');
      if (threads.length === 0) {
        container.innerHTML = '<div class="empty">No threads found</div>';
        return;
      }
      container.innerHTML = threads.map(t => \`
        <div class="item \${selectedThreadId === t.id ? 'active' : ''}" onclick="selectThread(\${escapeHtml(JSON.stringify(t.id))})">
          <div class="item-title">\${escapeHtml(t.title || '(no title)')}</div>
          <div class="item-meta">\${escapeHtml(t.id)} · \${formatTime(t.updatedAt)}</div>
        </div>
      \`).join('');
    }

    async function selectThread(id) {
      selectedThreadId = id;
      selectedRunId = null;
      refreshThreads();
      const runs = await fetchJson(\`/api/threads/\${id}/runs\`);
      const container = document.getElementById('runs');
      document.getElementById('run-breadcrumb').textContent = 'Thread ' + id.slice(0, 8);
      if (runs.length === 0) {
        container.innerHTML = '<div class="empty">No runs for this thread</div>';
      } else {
        container.innerHTML = runs.map(r => \`
          <div class="item \${selectedRunId === r.id ? 'active' : ''} \${escapeHtml(r.status)}" data-run-id="\${escapeHtml(r.id)}" onclick="selectRun(\${escapeHtml(JSON.stringify(r.id))})">
            <div class="item-title">\${escapeHtml(r.preview || r.status)}\${r.checkpoint?.resumedFromRunId ? ' ↩ resumed' : ''}</div>
            <div class="item-meta"><span class="status-badge \${escapeHtml(r.status)}">\${escapeHtml(r.status)}</span> · \${escapeHtml(r.id.slice(0, 8))} · trace \${escapeHtml(r.traceStatus || 'unknown')}\${r.droppedTraceEvents ? ' (' + r.droppedTraceEvents + ' dropped)' : ''} · \${formatTime(r.startTime)}</div>
            \${r.status === 'failed' && r.error ? \`<div class="item-error" title="\${escapeHtml(r.error)}">\${escapeHtml(r.error)}</div>\` : ''}
          </div>
        \`).join('');
      }
      await showAllThreadTraces();
    }

    async function selectRun(id) {
      selectedRunId = id;
      const items = document.querySelectorAll('#runs .item');
      items.forEach(el => el.classList.remove('active'));
      const active = Array.from(items).find(el => el.dataset.runId === id);
      if (active) active.classList.add('active');
      const [overview, traces] = await Promise.all([
        fetchJson(\`/api/runs/\${id}/overview\`),
        fetchJson(\`/api/runs/\${id}/traces\`),
      ]);
      renderRunOverview(overview);
      renderTraces(traces, 'Run ' + id.slice(0, 8));
    }

    async function showAllThreadTraces() {
      if (!selectedThreadId) return;
      selectedRunId = null;
      document.querySelectorAll('#runs .item').forEach(el => el.classList.remove('active'));
      document.getElementById('run-overview').style.display = 'none';
      const traces = await fetchJson(\`/api/threads/\${selectedThreadId}/traces\`);
      renderTraces(traces, 'All traces for thread');
    }

    async function refreshTraces() {
      if (selectedRunId) await selectRun(selectedRunId);
      else if (selectedThreadId) await showAllThreadTraces();
    }

    function renderRunOverview(overview) {
      const container = document.getElementById('run-overview');
      const r = overview.run;
      const m = overview.metrics;
      const recoveryLinks = [];
      if (overview.recovery.resumedFromRunId) {
        recoveryLinks.push('resumed from ' + runLink(overview.recovery.resumedFromRunId));
      }
      if (overview.recovery.resumedByRunIds.length > 0) {
        recoveryLinks.push('resumed by ' + overview.recovery.resumedByRunIds.map(runLink).join(', '));
      }
      const traceWarning = r.traceStatus === 'partial' || r.traceStatus === 'failed' || r.droppedTraceEvents > 0;
      container.innerHTML = \`
        <div class="overview-head">
          <div class="overview-title">
            <span class="status-badge \${escapeHtml(r.status)}">\${escapeHtml(r.status)}</span>
            <span class="status-badge">trace \${escapeHtml(r.traceStatus || 'unknown')}</span>
            <div class="overview-id">\${escapeHtml(r.id)} · \${escapeHtml(r.model)}</div>
          </div>
          <div class="item-meta">\${formatTime(r.startTime)}</div>
        </div>
        <div class="metrics">
          \${metric(formatDuration(m.durationMs), 'duration')}
          \${metric(m.totalTokens.toLocaleString(), 'tokens')}
          \${metric(m.modelCallCount, m.modelFailureCount > 0 ? 'model calls · ' + m.modelFailureCount + ' failed' : 'model calls', m.modelFailureCount > 0)}
          \${metric(m.toolCallCount, m.toolFailureCount > 0 ? 'tool calls · ' + m.toolFailureCount + ' failed' : 'tool calls', m.toolFailureCount > 0)}
          \${metric(m.retryCount, 'retries', m.retryCount > 0)}
          \${metric(m.eventCount, 'trace events', traceWarning)}
        </div>
        \${recoveryLinks.length > 0 ? \`<div class="recovery-links">\${recoveryLinks.join(' · ')}</div>\` : ''}
        \${r.error ? \`<div class="item-error" title="\${escapeHtml(r.error)}">\${escapeHtml(r.error)}</div>\` : ''}
      \`;
      container.style.display = 'block';
    }

    function metric(value, label, warning = false) {
      return \`<div class="metric\${warning ? ' warning' : ''}"><div class="metric-value">\${escapeHtml(String(value))}</div><div class="metric-label">\${escapeHtml(label)}</div></div>\`;
    }

    function runLink(id) {
      return \`<span class="run-link" onclick="selectRun(\${escapeHtml(JSON.stringify(id))})">\${escapeHtml(id.slice(0, 8))}</span>\`;
    }

    function summarizeEvent(e) {
      const d = e.eventData ?? {};
      switch (e.eventType) {
        case 'run':
          return {
            label: d.phase ?? '',
            preview: d.error ?? ((d.loopMode ?? '') + (d.resumedFromRunId ? ' · resumed from ' + d.resumedFromRunId.slice(0, 8) : '') + (d.durationMs !== undefined ? ' · ' + d.durationMs + 'ms' : '')),
          };
        case 'model_call': {
          const usage = d.usage?.totalTokens ? ' · ' + d.usage.totalTokens + ' tokens' : '';
          const duration = d.durationMs !== undefined ? ' · ' + d.durationMs + 'ms' : '';
          return { label: (d.purpose ?? '?') + ' · ' + (d.phase ?? '?'), preview: (d.provider ?? '') + '/' + (d.model ?? '') + duration + usage + (d.error ? ' · ' + d.error : '') };
        }
        case 'plan': {
          const steps = d.plan?.steps ?? [];
          const stepText = steps.map(s => s.description + (s.toolName ? ' [' + s.toolName + ']' : '')).join(' → ');
          return { label: steps.length + ' steps', preview: stepText };
        }
        case 'plan_step':
          return { label: (d.stepId ?? '?') + ' · ' + (d.status ?? '?'), preview: d.failureAnalysis?.rootCause ?? '' };
        case 'thought':
          return { label: '', preview: (d.content ?? '').slice(0, 200) };
        case 'reflection':
          return { label: '', preview: (d.content ?? '').slice(0, 200) };
        case 'tool_call': {
          const tc = d.toolCall ?? {};
          const args = tc.arguments ? JSON.stringify(tc.arguments) : '';
          return { label: tc.name ?? '?', preview: args };
        }
        case 'tool_result': {
          const tr = d.toolResult ?? {};
          if (!tr.success) return { label: d.status ?? 'failed', preview: (tr.error ?? '') + (d.durationMs !== undefined ? ' · ' + d.durationMs + 'ms' : '') };
          const data = tr.data;
          if (data?.results && Array.isArray(data.results)) {
            return { label: data.results.length + ' results', preview: data.results.map(r => r.title ?? r.url ?? '').slice(0, 3).join(' | ') };
          }
          if (typeof data === 'object' && data !== null) {
            const keys = Object.keys(data);
            return { label: 'ok', preview: keys.slice(0, 5).join(', ') };
          }
          return { label: 'ok' + (d.durationMs !== undefined ? ' · ' + d.durationMs + 'ms' : ''), preview: typeof data === 'string' ? data.slice(0, 200) : '' };
        }
        case 'message':
          return { label: '', preview: (d.content ?? '').slice(0, 300) };
        case 'verification': {
          const outcome = d.outcome ?? {};
          const evidenceCount = Array.isArray(outcome.evidence) ? outcome.evidence.length : 0;
          return { label: 'legacy · ' + (outcome.status ?? 'unknown'), preview: (outcome.reason ?? '') + (evidenceCount ? ' · ' + evidenceCount + ' evidence item(s)' : '') };
        }
        case 'sub_agent': {
          const status = d.status ?? '?';
          const task = (d.task ?? '').slice(0, 120);
          const detail = d.status === 'completed' ? (d.reply ?? '').slice(0, 200) : (d.error ?? '');
          const meta = d.durationMs !== undefined ? ' (' + (d.durationMs / 1000).toFixed(1) + 's)' : '';
          const childCount = Array.isArray(d.events) ? d.events.length : 0;
          const children = childCount > 0 ? ' · ' + childCount + ' events' : '';
          return { label: status + meta + children, preview: task + (detail ? ' — ' + detail : '') };
        }
        case 'memory_recall': {
          const selected = d.selectedCount ?? 0;
          const candidates = d.candidateCount ?? 0;
          const keywords = Array.isArray(d.keywords) ? d.keywords.join(', ') : '';
          const cost = d.estimatedTokens !== undefined ? ' · ~' + d.estimatedTokens + ' tokens' : '';
          const reason = d.skipReason ? ' · ' + d.skipReason : '';
          const error = d.error ? ' · failed: ' + d.error : '';
          return { label: selected + '/' + candidates + ' selected' + cost, preview: keywords + reason + error };
        }
        case 'message_delta':
        case 'reasoning_delta':
          return { label: e.chunkCount + ' chunks', preview: (e.fullText ?? d.content ?? '').slice(0, 300) };
        default:
          return { label: '', preview: JSON.stringify(d).slice(0, 200) };
      }
    }

    let activeFilters = new Set();

    // Group consecutive message_delta / reasoning_delta events.
    function groupDeltas(traces) {
      const grouped = [];
      let i = 0;
      while (i < traces.length) {
        const e = traces[i];
        if (e.eventType === 'message_delta' || e.eventType === 'reasoning_delta') {
          const type = e.eventType;
          const chunks = [];
          const startTime = e.createdAt;
          let endTime = e.createdAt;
          while (i < traces.length && traces[i].eventType === type) {
            const content = traces[i].eventData?.content ?? '';
            if (content) chunks.push(content);
            endTime = traces[i].createdAt;
            i++;
          }
          grouped.push({ eventType: type, createdAt: startTime, endTime, chunkCount: chunks.length, fullText: chunks.join(''), eventData: {} });
        } else {
          grouped.push(e);
          i++;
        }
      }
      return grouped;
    }

    function renderTraces(traces, context) {
      const container = document.getElementById('timeline');
      const barContainer = document.getElementById('timeline-bar-container');
      const filterContainer = document.getElementById('filters');
      if (traces.length === 0) {
        container.innerHTML = '<div class="empty">No traces found</div>';
        barContainer.style.display = 'none';
        filterContainer.style.display = 'none';
        return;
      }

      const grouped = groupDeltas(traces);

      // Collect unique event types for filter buttons.
      const types = [...new Set(grouped.map(e => e.eventType))];
      activeFilters = new Set(types); // all active by default
      filterContainer.innerHTML = types.map(t =>
        \`<span class="filter-btn \${t} active" onclick="toggleFilter('\${t}')">\${t}</span>\`
      ).join('');
      filterContainer.style.display = 'flex';

      // Render visual timeline bar (proportional segments by count).
      barContainer.style.display = 'block';
      const bar = document.getElementById('timeline-bar');
      bar.innerHTML = grouped.map((e, idx) =>
        \`<div class="timeline-seg \${e.eventType}" style="flex: 1" title="\${escapeHtml(e.eventType)}" onclick="scrollToEvent(\${idx})"></div>\`
      ).join('');

      // Render event list with expandable details.
      renderEventList(grouped);
    }

    function renderEventList(grouped) {
      const container = document.getElementById('timeline');
      container.innerHTML = grouped.map((e, idx) => {
        const summary = summarizeEvent(e);
        const typeLabel = e.eventType + (summary.label ? ' · ' + summary.label : '');
        const isStream = e.chunkCount !== undefined;
        const timeLabel = isStream && e.endTime
          ? formatTime(e.createdAt) + ' - ' + formatTime(e.endTime)
          : formatTime(e.createdAt);
        const preview = summary.preview || '(empty)';
        const fullData = JSON.stringify(e.eventData ?? e, null, 2);
        return \`
          <div class="event \${e.eventType}" id="event-\${idx}" onclick="toggleExpand(\${idx})" data-type="\${e.eventType}">
            <div class="event-header">
              <span class="event-type">\${escapeHtml(typeLabel)}</span>
              <span class="event-time">\${e.sequence !== undefined ? '#' + e.sequence + ' · ' : ''}\${timeLabel}</span>
            </div>
            <div class="event-data">\${escapeHtml(preview)}</div>
            \${renderSubAgentChildren(e)}
            <div class="event-full">\${escapeHtml(fullData)}</div>
          </div>
        \`;
      }).join('');
      applyFilters();
    }

    // Render the embedded internal event stream of a sub_agent event as nested
    // cards (raw AgentEvent objects, wrapped for summarizeEvent reuse).
    function renderSubAgentChildren(e) {
      if (e.eventType !== 'sub_agent') return '';
      const children = e.eventData?.events;
      if (!Array.isArray(children) || children.length === 0) return '';
      const wrapped = children.map(c => ({ eventType: c.type, eventData: c, createdAt: '' }));
      const groupedChildren = groupDeltas(wrapped);
      const cards = groupedChildren.map(c => {
        const summary = summarizeEvent(c);
        const typeLabel = c.eventType + (summary.label ? ' · ' + summary.label : '');
        return \`
          <div class="child-event \${c.eventType}">
            <div class="child-header"><span class="event-type">\${escapeHtml(typeLabel)}</span></div>
            <div class="child-preview">\${escapeHtml(summary.preview || '(empty)')}</div>
          </div>
        \`;
      }).join('');
      return \`
        <div class="event-children">
          <div class="children-title">Sub-agent events (\${groupedChildren.length})</div>
          \${cards}
        </div>
      \`;
    }

    function toggleExpand(idx) {
      const el = document.getElementById('event-' + idx);
      if (el) el.classList.toggle('expanded');
    }

    function scrollToEvent(idx) {
      const el = document.getElementById('event-' + idx);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.boxShadow = '0 0 0 2px var(--thought)'; setTimeout(() => el.style.boxShadow = '', 1000); }
    }

    function toggleFilter(type) {
      if (activeFilters.has(type)) activeFilters.delete(type);
      else activeFilters.add(type);
      // Update button visual
      document.querySelectorAll('.filter-btn').forEach(btn => {
        const t = btn.className.split(' ').find(c => c !== 'filter-btn' && c !== 'active');
        if (t) btn.classList.toggle('active', activeFilters.has(t));
      });
      applyFilters();
    }

    function applyFilters() {
      document.querySelectorAll('.event').forEach(el => {
        const type = el.dataset.type;
        el.style.display = activeFilters.has(type) ? '' : 'none';
      });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      // textContent→innerHTML escapes & < > but not quotes — those are needed
      // when the result is interpolated into a quoted HTML attribute.
      return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleString();
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms)) return '—';
      if (ms < 1000) return Math.round(ms) + ' ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.round((ms % 60000) / 1000);
      return minutes + 'm ' + seconds + 's';
    }

    refreshThreads();
    setInterval(refreshThreads, 5000);
  </script>
</body>
</html>`;
}
