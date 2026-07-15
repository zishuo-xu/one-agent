import Fastify, { FastifyInstance } from 'fastify';
import {
  getSharedConnection,
  RunStore,
  ThreadStore,
  TraceEventStore,
} from '@one-agent/agent-core';
import type { TraceEvent } from '@one-agent/agent-core';

export interface TraceWebServerOptions {
  port: number;
  host: string;
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
    // Attach a preview (assistant reply or tool call) to each run so the
    // list is readable without clicking into details.
    return runs.map((run) => {
      const traces = traceEventStore.getByRun(run.id);
      let preview = '';
      // Accumulate message_delta chunks into full text for a meaningful preview.
      let deltaText = '';
      for (const t of traces) {
        if (t.eventType === 'message_delta' && t.eventData?.content) {
          deltaText += String(t.eventData.content);
        } else if (t.eventType === 'message' && t.eventData?.content) {
          if (!deltaText) deltaText = String(t.eventData.content);
          break;
        } else if (deltaText) {
          break; // deltas ended, stop accumulating
        }
      }
      if (deltaText) {
        preview = deltaText.replace(/\n/g, ' ').slice(0, 120);
      }
      if (!preview) {
        for (const t of traces) {
          if (t.eventType === 'tool_call' && t.eventData?.toolCall?.name) {
            preview = '🔧 ' + t.eventData.toolCall.name;
            break;
          }
          if (t.eventType === 'plan' && t.eventData?.plan?.steps?.length) {
            preview = '📋 ' + t.eventData.plan.steps.map((s: { description: string }) => s.description).join(' -> ');
            break;
          }
        }
      }
      return { ...run, preview: preview || run.status };
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
        <div class="item \${selectedThreadId === t.id ? 'active' : ''}" onclick="selectThread('\${t.id}')">
          <div class="item-title">\${escapeHtml(t.title || '(no title)')}</div>
          <div class="item-meta">\${t.id} · \${formatTime(t.updatedAt)}</div>
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
          <div class="item \${selectedRunId === r.id ? 'active' : ''}" onclick="selectRun('\${r.id}')">
            <div class="item-title">\${escapeHtml(r.preview || r.status)}</div>
            <div class="item-meta">\${r.status} · \${formatTime(r.startTime)}</div>
          </div>
        \`).join('');
      }
      await showAllThreadTraces();
    }

    async function selectRun(id) {
      selectedRunId = id;
      const items = document.querySelectorAll('#runs .item');
      items.forEach(el => el.classList.remove('active'));
      const active = Array.from(items).find(el => el.querySelector('.item-meta').textContent.includes(id));
      if (active) active.classList.add('active');
      const traces = await fetchJson(\`/api/runs/\${id}/traces\`);
      renderTraces(traces, 'Run ' + id.slice(0, 8));
    }

    async function showAllThreadTraces() {
      if (!selectedThreadId) return;
      const traces = await fetchJson(\`/api/threads/\${selectedThreadId}/traces\`);
      renderTraces(traces, 'All traces for thread');
    }

    async function refreshTraces() {
      if (selectedRunId) await selectRun(selectedRunId);
      else if (selectedThreadId) await showAllThreadTraces();
    }

    function summarizeEvent(e) {
      const d = e.eventData ?? {};
      switch (e.eventType) {
        case 'plan': {
          const steps = d.plan?.steps ?? [];
          const stepText = steps.map(s => s.description + (s.toolName ? ' [' + s.toolName + ']' : '')).join(' → ');
          return { label: steps.length + ' steps', preview: stepText };
        }
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
          if (!tr.success) return { label: 'failed', preview: tr.error ?? '' };
          const data = tr.data;
          if (data?.results && Array.isArray(data.results)) {
            return { label: data.results.length + ' results', preview: data.results.map(r => r.title ?? r.url ?? '').slice(0, 3).join(' | ') };
          }
          if (typeof data === 'object' && data !== null) {
            const keys = Object.keys(data);
            return { label: 'ok', preview: keys.slice(0, 5).join(', ') };
          }
          return { label: 'ok', preview: typeof data === 'string' ? data.slice(0, 200) : '' };
        }
        case 'message':
          return { label: '', preview: (d.content ?? '').slice(0, 300) };
        case 'message_delta':
        case 'reasoning_delta':
          return { label: e.chunkCount + ' chunks', preview: (e.fullText ?? d.content ?? '').slice(0, 300) };
        default:
          return { label: '', preview: JSON.stringify(d).slice(0, 200) };
      }
    }

    function renderTraces(traces, context) {
      const container = document.getElementById('timeline');
      if (traces.length === 0) {
        container.innerHTML = '<div class="empty">No traces found</div>';
        return;
      }

      // Group consecutive message_delta / reasoning_delta events into a
      // single "stream" entry so the timeline isn't flooded with 100+ chunks.
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
          grouped.push({
            eventType: type,
            createdAt: startTime,
            endTime,
            chunkCount: chunks.length,
            fullText: chunks.join(''),
          });
        } else {
          grouped.push(e);
          i++;
        }
      }

      container.innerHTML = grouped.map(e => {
        const isStream = e.chunkCount !== undefined;
        const summary = summarizeEvent(e);
        const typeLabel = e.eventType + (summary.label ? ' · ' + summary.label : '');
        const timeLabel = isStream && e.endTime
          ? formatTime(e.createdAt) + ' - ' + formatTime(e.endTime)
          : formatTime(e.createdAt);
        const preview = summary.preview || '(empty)';
        return \`
          <div class="event \${e.eventType}">
            <div class="event-header">
              <span class="event-type">\${escapeHtml(typeLabel)}</span>
              <span class="event-time">\${timeLabel}</span>
            </div>
            <div class="event-data">\${escapeHtml(preview)}</div>
          </div>
        \`;
      }).join('');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleString();
    }

    refreshThreads();
    setInterval(refreshThreads, 5000);
  </script>
</body>
</html>`;
}
