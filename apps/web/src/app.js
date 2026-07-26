export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderInline(value) {
  return value
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function splitTableRow(value) {
  return value
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableSeparator(value) {
  const cells = splitTableRow(value);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderProse(value) {
  const lines = value.split(/\r?\n/);
  const output = [];
  let listType = null;

  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? 'ul' : 'ol';
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${renderInline((unordered ?? ordered)[1])}</li>`);
      continue;
    }

    closeList();
    if (
      line.includes('|') &&
      lines[index + 1]?.includes('|') &&
      isTableSeparator(lines[index + 1])
    ) {
      const headers = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      output.push(`
        <div class="table-scroll">
          <table>
            <thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>
            <tbody>${rows
              .map(
                (row) =>
                  `<tr>${headers
                    .map((_, cellIndex) => `<td>${renderInline(row[cellIndex] ?? '')}</td>`)
                    .join('')}</tr>`,
              )
              .join('')}</tbody>
          </table>
        </div>
      `);
      continue;
    }
    if (!line.trim()) {
      output.push('');
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      output.push('<hr>');
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length + 2;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    output.push(`<p>${renderInline(line)}</p>`);
  }
  closeList();
  return output.join('');
}

export function renderMarkdown(value) {
  const codeBlocks = [];
  const withTokens = String(value ?? '').replace(
    /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g,
    (_match, language, code) => {
      const index = codeBlocks.length;
      const languageLabel = escapeHtml(language || 'code');
      codeBlocks.push(
        `<div class="code-block">
          <div class="code-toolbar">
            <span>${languageLabel}</span>
            <button type="button" data-copy-code>复制</button>
          </div>
          <pre><code${language ? ` data-language="${escapeHtml(language)}"` : ''}>${escapeHtml(code.trimEnd())}</code></pre>
        </div>`,
      );
      return `\u0000CODE_BLOCK_${index}\u0000`;
    },
  );
  let rendered = renderProse(escapeHtml(withTokens));
  codeBlocks.forEach((block, index) => {
    rendered = rendered.replace(`<p>\u0000CODE_BLOCK_${index}\u0000</p>`, block);
    rendered = rendered.replace(`\u0000CODE_BLOCK_${index}\u0000`, block);
  });
  return rendered;
}

export function visibleMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter(
    (message) =>
      !message.internal &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim(),
  );
}

function normalizeMessageText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function conversationMessages(messages, pendingQuestion) {
  const visible = visibleMessages(messages);
  const normalizedPending = normalizeMessageText(pendingQuestion);
  if (!normalizedPending) return visible;

  const latestAssistantIndex = visible.findLastIndex(
    (message) => message.role === 'assistant',
  );
  if (
    latestAssistantIndex >= 0 &&
    normalizeMessageText(visible[latestAssistantIndex].content) === normalizedPending
  ) {
    return visible.filter((_message, index) => index !== latestAssistantIndex);
  }
  return visible;
}

export function approvalProgressLabel(answer, requestKind) {
  if (answer === 'approve') return '已批准，正在执行…';
  if (answer === 'reject') return '正在拒绝…';
  if (requestKind === 'plan_approval') return '正在提交修改…';
  return '正在提交回答…';
}

export function pendingImpactSummary(request) {
  if (!request) return { copy: '', risk: '', tone: '' };
  if (request.kind === 'clarification') {
    return {
      copy: 'Agent 需要你的回答才能继续执行',
      risk: '需要输入',
      tone: '',
    };
  }
  if (request.kind === 'tool_approval') {
    const toolName = request.approval?.toolCall?.name ?? '工具';
    const highRisk = ['delete_file', 'run_command'].includes(toolName);
    return {
      copy: `即将调用 ${toolName}，参数可在下方核对`,
      risk: highRisk ? '高风险' : '需确认',
      tone: highRisk ? 'high' : '',
    };
  }
  const question = String(request.question ?? '');
  const stepMatches = question.match(/^\s*\d+(?:\.\d+)*\.\s+/gm) ?? [];
  const subAgentMatches = question.match(/\[(?:并行)?子 Agent\]|\[(?:parallel )?sub-agent\]/gi) ?? [];
  const mutating = /\[(?:write_file|append_file|delete_file|run_command)\]/i.test(question);
  const parts = [
    stepMatches.length ? `${stepMatches.length} 个步骤` : '计划已生成',
    subAgentMatches.length ? `${subAgentMatches.length} 个子 Agent` : '',
    mutating ? '可能修改工作区' : '未发现写入工具',
  ].filter(Boolean);
  return {
    copy: parts.join(' · '),
    risk: mutating ? '需确认' : '低风险',
    tone: mutating ? '' : 'low',
  };
}

export function runStatePresentation({ busy, pending, run, events }) {
  const eventSummary = summarizeEvents(events);
  if (pending?.inputRequest) {
    const kind = pending.inputRequest.kind;
    const titles = {
      plan_approval: '等待你确认计划',
      tool_approval: '等待你批准工具调用',
      clarification: '等待你补充信息',
    };
    return {
      hidden: false,
      tone: 'waiting',
      title: titles[kind] ?? '等待你的输入',
      detail: pendingImpactSummary(pending.inputRequest).copy,
    };
  }
  if (busy || isRunInProgress(run)) {
    const detail = eventSummary.subAgents
      ? `${eventSummary.subAgents} 个子 Agent 正在执行`
      : eventSummary.tools
        ? `已调用 ${eventSummary.tools} 个工具`
        : '模型正在处理当前请求';
    return { hidden: false, tone: 'running', title: 'One Agent 正在执行', detail };
  }
  if (run?.status === 'completed') {
    const details = [
      eventSummary.tools ? `${eventSummary.tools} 个工具` : '',
      eventSummary.subAgents ? `${eventSummary.subAgents} 个子 Agent` : '',
    ].filter(Boolean);
    return {
      hidden: false,
      tone: 'success',
      title: '本轮任务已完成',
      detail: details.join(' · ') || '结果已写入当前对话',
    };
  }
  if (run?.status === 'failed') {
    return {
      hidden: false,
      tone: 'failed',
      title: '本轮任务执行失败',
      detail: run.error || '可以查看执行详情定位原因',
    };
  }
  if (run?.status === 'cancelled') {
    return {
      hidden: false,
      tone: 'idle',
      title: '任务已取消',
      detail: '未继续执行后续步骤',
    };
  }
  return { hidden: true, tone: 'idle', title: '', detail: '' };
}

export function isRunInProgress(run) {
  return run?.status === 'pending' || run?.status === 'running';
}

export function pendingInputFromEvents(run, events) {
  if (run?.status !== 'waiting_for_input') return null;
  const inputEvent = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => event.eventData?.type === 'input_required');
  return inputEvent?.eventData?.request
    ? { runId: run.id, inputRequest: inputEvent.eventData.request }
    : null;
}

export function buildSubAgentItems(events) {
  const items = [];
  const pendingByKey = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const data = event?.eventData ?? event;
    if (data?.type !== 'sub_agent') continue;
    const key = data.stepId || data.task || 'sub-agent';
    if (data.status === 'started') {
      const index = items.length;
      items.push({
        id: data.stepId ? `step-${data.stepId}` : `sub-agent-${index + 1}`,
        order: index + 1,
        ...data,
        startedAt: event?.createdAt,
      });
      const queue = pendingByKey.get(key) ?? [];
      queue.push(index);
      pendingByKey.set(key, queue);
      continue;
    }

    const queue = pendingByKey.get(key) ?? [];
    const index = queue.shift();
    if (queue.length > 0) pendingByKey.set(key, queue);
    else pendingByKey.delete(key);
    if (index !== undefined) {
      items[index] = {
        ...items[index],
        ...data,
        completedAt: event?.createdAt,
      };
    } else {
      items.push({
        id: data.stepId ? `step-${data.stepId}` : `sub-agent-${items.length + 1}`,
        order: items.length + 1,
        ...data,
        completedAt: event?.createdAt,
      });
    }
  }
  return items;
}

export function buildDialogueTurns(messages, runs) {
  const visible = visibleMessages(messages);
  const turns = [];
  for (let index = 0; index < visible.length; index += 1) {
    const message = visible[index];
    if (message.role !== 'user') continue;
    const response = visible
      .slice(index + 1)
      .find((candidate) => candidate.role === 'user' || candidate.role === 'assistant');
    turns.push({
      id: message.id ?? `${message.createdAt ?? 'message'}-${index}`,
      message,
      response: response?.role === 'assistant' ? response : null,
      runs: [],
    });
  }
  if (turns.length === 0) return turns;

  const sortedRuns = [...(Array.isArray(runs) ? runs : [])].sort(
    (left, right) => Date.parse(left.startTime) - Date.parse(right.startTime),
  );
  for (const run of sortedRuns) {
    const runTime = Date.parse(run.startTime);
    let targetIndex = 0;
    for (let index = 0; index < turns.length; index += 1) {
      const messageTime = Date.parse(turns[index].message.createdAt);
      if (Number.isNaN(runTime) || Number.isNaN(messageTime) || messageTime <= runTime) {
        targetIndex = index;
      } else {
        break;
      }
    }
    turns[targetIndex].runs.push(run);
  }
  return turns;
}

export function summarizeEvents(events) {
  const source = (Array.isArray(events) ? events : []).map(
    (event) => event?.eventData ?? event,
  );
  return {
    tools: source.filter((event) => event?.type === 'tool_call').length,
    subAgents: source.filter(
      (event) => event?.type === 'sub_agent' && event.status === 'started',
    ).length,
    reasoning: extractReasoningItems(source).length,
  };
}

export function mergeModelCallEvents(events) {
  const merged = [];
  const starts = new Map();

  for (const event of Array.isArray(events) ? events : []) {
    const data = event?.eventData ?? event;
    if (data?.type !== 'model_call' || !data.modelCallId) {
      merged.push(event);
      continue;
    }
    if (data.phase === 'started') {
      starts.set(data.modelCallId, merged.length);
      merged.push(event);
      continue;
    }
    const startIndex = starts.get(data.modelCallId);
    if (startIndex === undefined) {
      merged.push(event);
      continue;
    }
    const startedEvent = merged[startIndex];
    const startedData = startedEvent?.eventData ?? startedEvent;
    const combinedData = {
      ...startedData,
      ...data,
      input: startedData.input ?? data.input,
      output: data.output ?? startedData.output,
    };
    merged[startIndex] =
      startedEvent && Object.hasOwn(startedEvent, 'eventData')
        ? { ...startedEvent, eventData: combinedData }
        : combinedData;
    starts.delete(data.modelCallId);
  }

  return merged;
}

function renderModelValue(value, emptyLabel = '（空）') {
  const content =
    typeof value === 'string'
      ? value
      : value === undefined
        ? ''
        : JSON.stringify(value, null, 2);
  return `<pre>${escapeHtml(content || emptyLabel)}</pre>`;
}

export function renderModelCallInspector(event) {
  const input = event?.input;
  const output = event?.output;
  const hasSnapshot = Boolean(input || output);
  const inputMessages = Array.isArray(input?.messages)
    ? input.messages
        .map((message, index) => `
          <section class="model-io-block">
            <div class="model-io-label">
              <strong>${escapeHtml(message.role ?? 'message')}</strong>
              <span>#${index + 1}${message.internal ? ' · internal' : ''}</span>
            </div>
            ${renderModelValue(message.content)}
            ${message.tool_calls ? `
              <div class="model-io-label"><strong>tool calls</strong></div>
              ${renderModelValue(message.tool_calls)}
            ` : ''}
          </section>
        `)
        .join('')
    : '';
  const tools = Array.isArray(input?.tools) && input.tools.length > 0
    ? `
      <section class="model-io-block">
        <div class="model-io-label">
          <strong>可用工具</strong>
          <span>${input.tools.length}</span>
        </div>
        ${renderModelValue(input.tools)}
      </section>
    `
    : '';
  const reasoning = output?.reasoning
    ? `
      <section class="model-io-block">
        <div class="model-io-label"><strong>Reasoning</strong></div>
        ${renderModelValue(output.reasoning)}
      </section>
    `
    : '';
  const response = output
    ? `
      ${reasoning}
      <section class="model-io-block">
        <div class="model-io-label"><strong>Content</strong></div>
        ${renderModelValue(output.content)}
      </section>
      ${output.toolCalls?.length ? `
        <section class="model-io-block">
          <div class="model-io-label">
            <strong>Tool Calls</strong>
            <span>${output.toolCalls.length}</span>
          </div>
          ${renderModelValue(output.toolCalls)}
        </section>
      ` : ''}
    `
    : '<p class="model-io-empty">模型尚未返回输出。</p>';

  return `
    <details class="model-io">
      <summary>
        <span>查看输入输出</span>
        <span>${hasSnapshot ? 'Input / Output' : '旧记录'}</span>
      </summary>
      ${hasSnapshot ? `
        <div class="model-io-content">
          <div class="model-io-tabs" role="tablist" aria-label="模型调用数据">
            <button class="model-io-tab is-active" type="button" role="tab" aria-selected="true" data-model-tab="input">
              Input${input?.jsonMode ? ' · JSON' : ''}
            </button>
            <button class="model-io-tab" type="button" role="tab" aria-selected="false" data-model-tab="output">
              Output
            </button>
          </div>
          <div class="model-io-panel" role="tabpanel" data-model-panel="input">
            ${inputMessages || '<p class="model-io-empty">没有消息快照。</p>'}
            ${tools}
          </div>
          <div class="model-io-panel" role="tabpanel" data-model-panel="output" hidden>
            ${response}
          </div>
        </div>
      ` : `
        <p class="model-io-empty model-io-legacy">
          这条历史运行只保存了调用元数据；升级后产生的新运行会记录输入输出。
        </p>
      `}
    </details>
  `;
}

function normalizeReasoningContent(content) {
  const value = String(content ?? '').trim();
  if (value === 'Auto planning decision: direct') {
    return '判定为直接执行：当前请求不需要先生成多步骤计划。';
  }
  if (value === 'Auto planning decision: plan') {
    return '判定为规划执行：当前请求需要先拆解步骤再执行。';
  }
  if (value === 'Auto planning classifier failed; defaulting to plan') {
    return '自动规划判断失败，已按更保守的规划模式继续。';
  }
  return value;
}

export function extractReasoningItems(events) {
  const source = (Array.isArray(events) ? events : []).map(
    (event) => event?.eventData ?? event,
  );
  const items = [];
  const seen = new Set();
  let reasoningBuffer = '';

  const append = (kind, label, content) => {
    const normalized = normalizeReasoningContent(content);
    if (!normalized) return;
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, label, content: normalized });
  };
  const flushReasoning = () => {
    append('reasoning', '模型推理', reasoningBuffer);
    reasoningBuffer = '';
  };

  for (const event of source) {
    if (event?.type === 'reasoning_delta') {
      reasoningBuffer += event.content ?? '';
      continue;
    }
    flushReasoning();
    if (event?.type === 'thought') {
      append('thought', '思考判断', event.content);
    } else if (event?.type === 'reflection') {
      append('reflection', '执行复盘', event.content);
    } else if (event?.type === 'strategy_switch') {
      append('strategy', '策略调整', event.reason);
    } else if (event?.type === 'plan' && event.plan?.reasoning) {
      append('plan', '规划依据', event.plan.reasoning);
    }
  }
  flushReasoning();
  return items;
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function shortId(value) {
  return typeof value === 'string' ? value.slice(0, 8) : '—';
}

function eventDescription(event) {
  switch (event?.type) {
    case 'run':
      return {
        title: event.phase === 'started' ? '开始运行' : `运行${event.phase}`,
        type: 'Run',
        detail: event.loopMode ? `${event.loopMode} loop · ${event.model ?? ''}` : '',
        status: event.phase === 'failed' ? 'failed' : event.phase === 'started' ? 'running' : 'success',
      };
    case 'strategy_switch':
      return {
        title: '升级为规划执行',
        type: 'Strategy',
        detail: event.reason,
        status: 'success',
      };
    case 'thought':
      return {
        title: '思考判断',
        type: 'Thought',
        detail: normalizeReasoningContent(event.content),
        status: 'success',
      };
    case 'reflection':
      return {
        title: '执行复盘',
        type: 'Reflection',
        detail: event.content,
        status: 'success',
      };
    case 'model_call':
      return {
        title: `模型调用 · ${event.purpose}`,
        type: 'Model',
        detail:
          event.phase === 'failed'
            ? event.error
            : `${event.provider} / ${event.model}${event.durationMs ? ` · ${event.durationMs}ms` : ''}`,
        status:
          event.phase === 'failed'
            ? 'failed'
            : event.phase === 'started'
              ? 'running'
              : 'success',
        modelCall: event,
      };
    case 'plan':
      return {
        title: '生成执行计划',
        type: 'Plan',
        detail: `${event.plan?.steps?.length ?? 0} 个顶层步骤`,
        status: 'success',
      };
    case 'plan_review':
      return {
        title: event.phase === 'requested' ? '等待计划确认' : `计划${event.phase}`,
        type: 'Approval',
        detail: event.feedback ?? `修订版本 ${event.revision ?? 0}`,
        status: event.phase === 'requested' ? 'running' : 'success',
      };
    case 'plan_step':
      {
        const labels = {
          running: '正在执行',
          completed: '已完成',
          failed: '执行失败',
          retrying: '正在重试',
        };
        return {
          title: event.description || `计划步骤 ${event.stepId}`,
          type: `步骤 ${event.stepId}`,
          detail:
            event.failureAnalysis?.rootCause ??
            labels[event.status] ??
            event.status,
          status:
            event.status === 'failed'
              ? 'failed'
              : event.status === 'running' || event.status === 'retrying'
                ? 'running'
                : 'success',
        };
      }
    case 'tool_call':
      return {
        title: event.toolCall?.name ?? '调用工具',
        type: 'Tool',
        detail: safeArguments(event.toolCall?.arguments),
        status: 'running',
      };
    case 'tool_result':
      return {
        title: event.toolResult?.success ? '工具执行完成' : '工具执行失败',
        type: 'Tool result',
        detail: event.toolResult?.error ?? event.status ?? '',
        status: event.toolResult?.success ? 'success' : 'failed',
      };
    case 'sub_agent':
      return {
        title: event.task || '子 Agent',
        type: 'Sub-Agent',
        detail:
          event.status === 'started'
            ? '只读委派已开始'
            : event.evidencePacket?.conclusion ?? event.error ?? event.executionStatus ?? event.status,
        evidence: event.evidencePacket,
        status: event.status === 'started' ? 'running' : event.status === 'failed' ? 'failed' : 'success',
      };
    case 'memory_context_loaded':
      return {
        title: '加载长期记忆',
        type: 'Memory',
        detail: `${event.scopes?.join('、') || '无'} · 约 ${event.estimatedTokens ?? 0} tokens`,
        status: event.error ? 'failed' : 'success',
      };
    case 'input_required':
      return {
        title: '等待用户输入',
        type: 'Input',
        detail: event.request?.question ?? '',
        status: 'running',
      };
    default:
      return null;
  }
}

function collectPlanDescriptions(steps, descriptions = new Map()) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step?.id && step.description) descriptions.set(step.id, step.description);
    collectPlanDescriptions(step?.children, descriptions);
  }
  return descriptions;
}

export function meaningfulTimelineEvents(events) {
  const merged = mergeModelCallEvents(events).map((event) => event?.eventData ?? event);
  const descriptions = new Map();
  const delegatedStepIds = new Set();
  const latestPlanStepIndex = new Map();
  const latestSubAgentIndex = new Map();

  merged.forEach((event, index) => {
    if (event?.type === 'plan') {
      collectPlanDescriptions(event.plan?.steps, descriptions);
    }
    if (event?.type === 'sub_agent') {
      if (event.stepId) delegatedStepIds.add(event.stepId);
      latestSubAgentIndex.set(event.stepId || event.task || `sub-agent-${index}`, index);
    }
    if (event?.type === 'plan_step' && event.status !== 'pending') {
      latestPlanStepIndex.set(event.stepId, index);
    }
  });

  return merged
    .filter((event, index) => {
      if (!event) return false;
      if (event.type === 'plan_step') {
        return (
          event.status !== 'pending' &&
          !delegatedStepIds.has(event.stepId) &&
          latestPlanStepIndex.get(event.stepId) === index
        );
      }
      if (event.type === 'sub_agent') {
        const key = event.stepId || event.task || `sub-agent-${index}`;
        return latestSubAgentIndex.get(key) === index;
      }
      return true;
    })
    .map((event) =>
      event.type === 'plan_step'
        ? { ...event, description: descriptions.get(event.stepId) }
        : event,
    );
}

function safeArguments(value) {
  if (!value || typeof value !== 'object') return '';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function createWebApp(doc = document, browserWindow = window) {
  const elements = {
    connection: doc.querySelector('#connection-status'),
    runtimeLabel: doc.querySelector('#runtime-label'),
    workspaceLabel: doc.querySelector('#workspace-label'),
    workspaceContext: doc.querySelector('#workspace-context'),
    workspaceButtonLabel: doc.querySelector('#workspace-button-label'),
    workspaceDialog: doc.querySelector('#workspace-dialog'),
    workspaceForm: doc.querySelector('#workspace-form'),
    workspaceInput: doc.querySelector('#workspace-input'),
    workspaceError: doc.querySelector('#workspace-error'),
    workspaceClose: doc.querySelector('#workspace-dialog-close'),
    workspaceCancel: doc.querySelector('#workspace-cancel-button'),
    workspaceConfirm: doc.querySelector('#workspace-confirm-button'),
    workspaceBrowse: doc.querySelector('#workspace-browse-button'),
    recentWorkspaces: doc.querySelector('#recent-workspaces'),
    threadList: doc.querySelector('#thread-list'),
    threadCount: doc.querySelector('#thread-count'),
    threadTitle: doc.querySelector('#thread-title'),
    runStateStrip: doc.querySelector('#run-state-strip'),
    runStateDot: doc.querySelector('#run-state-dot'),
    runStateText: doc.querySelector('#run-state-text'),
    runStateDetail: doc.querySelector('#run-state-detail'),
    conversation: doc.querySelector('#conversation'),
    messageList: doc.querySelector('#message-list'),
    emptyTemplate: doc.querySelector('#empty-conversation-template'),
    input: doc.querySelector('#message-input'),
    send: doc.querySelector('#send-button'),
    newThread: doc.querySelector('#new-thread-button'),
    settingsButton: doc.querySelector('#settings-button'),
    mobileSettingsButton: doc.querySelector('#mobile-settings-button'),
    settingsPanel: doc.querySelector('#settings-panel'),
    settingsClose: doc.querySelector('#settings-close'),
    settingsForm: doc.querySelector('#settings-form'),
    settingsSave: doc.querySelector('#settings-save-button'),
    settingsSaveStatus: doc.querySelector('#settings-save-status'),
    primaryConnection: doc.querySelector('#settings-primary-connection'),
    primaryModel: doc.querySelector('#settings-primary-model'),
    fallbackConnection: doc.querySelector('#settings-fallback-connection'),
    fallbackModel: doc.querySelector('#settings-fallback-model'),
    planningModel: doc.querySelector('#settings-planning-model'),
    utilityModel: doc.querySelector('#settings-utility-model'),
    locale: doc.querySelector('#settings-locale'),
    customInstructions: doc.querySelector('#settings-custom-instructions'),
    loop: doc.querySelector('#settings-loop'),
    timeout: doc.querySelector('#settings-timeout'),
    subAgentEnabled: doc.querySelector('#settings-subagent-enabled'),
    mainAgentBudget: doc.querySelector('#settings-main-agent-budget'),
    subAgentBudget: doc.querySelector('#settings-subagent-budget'),
    planApproval: doc.querySelector('#settings-plan-approval'),
    traceMode: doc.querySelector('#settings-trace-mode'),
    connectionList: doc.querySelector('#connection-list'),
    connectionsEmpty: doc.querySelector('#connections-empty'),
    addConnection: doc.querySelector('#add-connection-button'),
    connectionDialog: doc.querySelector('#connection-dialog'),
    connectionForm: doc.querySelector('#connection-form'),
    connectionDialogTitle: doc.querySelector('#connection-dialog-title'),
    connectionDialogClose: doc.querySelector('#connection-dialog-close'),
    connectionId: doc.querySelector('#connection-id'),
    connectionName: doc.querySelector('#connection-name'),
    connectionProvider: doc.querySelector('#connection-provider'),
    connectionBaseUrl: doc.querySelector('#connection-base-url'),
    connectionApiKey: doc.querySelector('#connection-api-key'),
    connectionMaxTokens: doc.querySelector('#connection-max-tokens'),
    connectionModels: doc.querySelector('#connection-models'),
    connectionError: doc.querySelector('#connection-error'),
    deleteConnection: doc.querySelector('#delete-connection-button'),
    testConnection: doc.querySelector('#test-connection-button'),
    pendingCard: doc.querySelector('#pending-card'),
    pendingKind: doc.querySelector('#pending-kind'),
    pendingStatus: doc.querySelector('#pending-status'),
    pendingImpact: doc.querySelector('#pending-impact'),
    pendingImpactCopy: doc.querySelector('#pending-impact-copy'),
    pendingRisk: doc.querySelector('#pending-risk'),
    pendingQuestion: doc.querySelector('#pending-question'),
    pendingOptions: doc.querySelector('#pending-options'),
    pendingRevision: doc.querySelector('#pending-revision'),
    pendingRevise: doc.querySelector('#pending-revise-button'),
    pendingAnswer: doc.querySelector('#pending-answer'),
    pendingAnswerLabel: doc.querySelector('#pending-answer-label'),
    approvalArguments: doc.querySelector('#approval-arguments'),
    continueButton: doc.querySelector('#continue-button'),
    cancelWaiting: doc.querySelector('#cancel-waiting-button'),
    runStatus: doc.querySelector('#run-status'),
    dialogueRunList: doc.querySelector('#dialogue-run-list'),
    executionEmpty: doc.querySelector('#execution-empty'),
    executionPanel: doc.querySelector('#execution-panel'),
    executionToggle: doc.querySelector('#execution-toggle'),
    executionToggleStatus: doc.querySelector('#execution-toggle-status'),
    executionClose: doc.querySelector('#execution-close'),
    executionBackdrop: doc.querySelector('#execution-backdrop'),
    scrollLatest: doc.querySelector('#scroll-latest-button'),
    traceLink: doc.querySelector('#trace-link'),
  };

  const state = {
    threads: [],
    activeThreadId: null,
    busy: false,
    pending: null,
    events: [],
    latestRun: null,
    messages: [],
    runs: [],
    runTraces: new Map(),
    expandedTurnId: null,
    workspace: null,
    recentWorkspaces: [],
    executionOpen: false,
    wideExecutionLayout: Number(browserWindow.innerWidth) >= 1180,
    stickToBottom: true,
    runWatchers: new Map(),
    expandedSubAgents: new Set(),
    settings: null,
    settingsOpen: false,
    editingConnectionId: null,
  };

  function resizeComposerInput() {
    elements.input.style.height = 'auto';
    const measuredHeight = Number(elements.input.scrollHeight) || 28;
    elements.input.style.height = `${Math.min(Math.max(measuredHeight, 28), 120)}px`;
  }

  function setSelectOptions(select, options, selectedValue = '') {
    select.replaceChildren();
    for (const option of options) {
      const node = doc.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
    select.value = selectedValue;
    if (select.value !== selectedValue && select.options.length > 0) {
      select.selectedIndex = 0;
    }
  }

  function connectionById(id) {
    return state.settings?.connections.find((connection) => connection.id === id);
  }

  function modelOptions(connectionId) {
    return (connectionById(connectionId)?.models ?? []).map((model) => ({
      value: model,
      label: model,
    }));
  }

  function markSettingsChanged(message = '有未保存的修改') {
    elements.settingsSaveStatus.textContent = message;
    elements.settingsSaveStatus.classList.add('is-dirty');
  }

  function renderModelSelectors() {
    if (!state.settings) return;
    const connections = state.settings.connections.map((connection) => ({
      value: connection.id,
      label: connection.name,
    }));
    setSelectOptions(
      elements.primaryConnection,
      connections,
      state.settings.agent.primaryConnectionId,
    );
    state.settings.agent.primaryConnectionId = elements.primaryConnection.value;
    setSelectOptions(
      elements.primaryModel,
      modelOptions(elements.primaryConnection.value),
      state.settings.agent.primaryModel,
    );
    state.settings.agent.primaryModel = elements.primaryModel.value;

    setSelectOptions(
      elements.fallbackConnection,
      [{ value: '', label: '不启用' }, ...connections],
      state.settings.agent.fallbackConnectionId,
    );
    state.settings.agent.fallbackConnectionId = elements.fallbackConnection.value;
    setSelectOptions(
      elements.fallbackModel,
      elements.fallbackConnection.value
        ? modelOptions(elements.fallbackConnection.value)
        : [{ value: '', label: '不启用' }],
      state.settings.agent.fallbackModel,
    );
    elements.fallbackModel.disabled = !elements.fallbackConnection.value;
    state.settings.agent.fallbackModel = elements.fallbackModel.value;
  }

  function connectionRole(connection) {
    if (!state.settings) return '';
    const roles = [];
    if (state.settings.agent.primaryConnectionId === connection.id) roles.push('主模型');
    if (state.settings.agent.fallbackConnectionId === connection.id) roles.push('备用模型');
    return roles.join(' · ');
  }

  function renderConnections() {
    elements.connectionList.replaceChildren();
    const connections = state.settings?.connections ?? [];
    elements.connectionsEmpty.hidden = connections.length > 0;
    for (const connection of connections) {
      const card = doc.createElement('article');
      card.className = 'connection-card';
      const role = connectionRole(connection);
      card.innerHTML = `
        <div class="connection-card-header">
          <div class="connection-card-title">
            <strong>${escapeHtml(connection.name)}</strong>
            <span>${escapeHtml(providerLabel(connection.provider))}</span>
          </div>
          <span class="connection-status">已配置</span>
        </div>
        <code>${escapeHtml(connection.baseUrl || 'Provider 默认地址')}</code>
        <div class="connection-card-meta">
          ${escapeHtml(connection.models.join('、'))} · ${connection.apiKey ? 'Key 已配置' : '未配置 Key'}
        </div>
        <div class="connection-card-actions">
          <span class="connection-role">${escapeHtml(role || '可用连接')}</span>
          <div>
            <button class="ghost-button" type="button" data-test-connection="${escapeHtml(connection.id)}">测试</button>
            <button class="ghost-button" type="button" data-edit-connection="${escapeHtml(connection.id)}">编辑</button>
          </div>
        </div>
      `;
      elements.connectionList.appendChild(card);
    }
  }

  function providerLabel(provider) {
    if (provider === 'anthropic') return 'Anthropic 协议';
    if (provider === 'openai') return 'OpenAI';
    return 'OpenAI Compatible';
  }

  function renderSettings() {
    if (!state.settings) return;
    renderModelSelectors();
    elements.planningModel.value = state.settings.agent.planningModel ?? '';
    elements.utilityModel.value = state.settings.agent.utilityModel ?? '';
    elements.locale.value = state.settings.runtime.locale ?? 'zh-CN';
    elements.customInstructions.value = state.settings.runtime.customInstructions ?? '';
    elements.loop.value = state.settings.runtime.loop;
    elements.timeout.value = String(state.settings.agent.timeoutMs);
    elements.subAgentEnabled.checked = state.settings.subAgent.enabled;
    elements.mainAgentBudget.value =
      state.settings.budget.mainAgentTokens == null
        ? ''
        : String(state.settings.budget.mainAgentTokens);
    elements.subAgentBudget.value =
      state.settings.budget.subAgentTokens == null
        ? ''
        : String(state.settings.budget.subAgentTokens);
    elements.planApproval.checked = state.settings.runtime.planApproval;
    elements.traceMode.value = state.settings.trace.contentMode;
    doc.querySelectorAll('[data-tool-name]').forEach((row) => {
      const toolName = row.dataset.toolName;
      row.querySelector('[data-tool-enabled]').checked =
        !state.settings.tools.disabled.includes(toolName);
      row.querySelector('[data-tool-approval]').checked =
        state.settings.tools.requireApproval.includes(toolName);
    });
    renderConnections();
    elements.settingsSaveStatus.classList.remove('is-dirty');
    elements.settingsSaveStatus.textContent =
      state.settings.configPath
        ? `全局配置 · ${state.settings.configPath}`
        : '全局 Agent 配置';
  }

  async function loadSettings() {
    elements.settingsSave.disabled = true;
    elements.settingsSaveStatus.textContent = '正在读取配置…';
    try {
      state.settings = await api('/api/settings');
      renderSettings();
    } catch (error) {
      elements.settingsSaveStatus.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      elements.settingsSave.disabled = false;
    }
  }

  function setSettingsOpen(open) {
    state.settingsOpen = open;
    elements.settingsPanel.hidden = !open;
    const chatPanel = doc.querySelector('[data-panel="chat"]');
    chatPanel.hidden = open;
    elements.settingsButton.classList.toggle('is-active', open);
    elements.settingsButton.setAttribute('aria-pressed', String(open));
    if (open) {
      setExecutionOpen(false);
      loadSettings();
    } else {
      setExecutionOpen(false);
    }
  }

  function showSettingsTab(name) {
    doc.querySelectorAll('[data-settings-tab]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.settingsTab === name);
    });
    doc.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== name;
    });
  }

  function connectionDraftFromDialog() {
    const name = elements.connectionName.value.trim();
    const generatedId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || `connection-${Date.now()}`;
    return {
      id: elements.connectionId.value || generatedId,
      name,
      provider: elements.connectionProvider.value,
      baseUrl: elements.connectionBaseUrl.value.trim() || undefined,
      apiKey: elements.connectionApiKey.value,
      models: elements.connectionModels.value
        .split(/\r?\n|,/)
        .map((model) => model.trim())
        .filter(Boolean),
      maxTokens: Number(elements.connectionMaxTokens.value) || 4096,
    };
  }

  function openConnectionDialog(connectionId = null) {
    const connection = connectionId ? connectionById(connectionId) : null;
    state.editingConnectionId = connection?.id ?? null;
    elements.connectionDialogTitle.textContent = connection ? '编辑连接' : '添加连接';
    elements.connectionId.value = connection?.id ?? '';
    elements.connectionName.value = connection?.name ?? '';
    elements.connectionProvider.value = connection?.provider ?? 'openai-compatible';
    elements.connectionBaseUrl.value = connection?.baseUrl ?? '';
    elements.connectionApiKey.value = connection?.apiKey ?? '';
    elements.connectionMaxTokens.value = String(connection?.maxTokens ?? 4096);
    elements.connectionModels.value = connection?.models?.join('\n') ?? '';
    elements.deleteConnection.hidden = !connection;
    elements.connectionError.hidden = true;
    elements.connectionError.textContent = '';
    elements.connectionDialog.showModal();
    elements.connectionName.focus();
  }

  function closeConnectionDialog() {
    elements.connectionDialog.close();
    state.editingConnectionId = null;
  }

  function validateConnectionDraft(connection) {
    if (!connection.name) return '请输入连接名称。';
    if (!['openai-compatible', 'openai', 'anthropic'].includes(connection.provider)) {
      return '请选择有效的 API 协议。';
    }
    if (connection.models.length === 0) return '至少输入一个模型名称。';
    if (!connection.apiKey) return '请输入 API Key。';
    return '';
  }

  function saveConnectionDraft() {
    const connection = connectionDraftFromDialog();
    const error = validateConnectionDraft(connection);
    if (error) {
      elements.connectionError.textContent = error;
      elements.connectionError.hidden = false;
      return;
    }
    const existingIndex = state.settings.connections.findIndex(
      (item) => item.id === state.editingConnectionId,
    );
    if (
      existingIndex < 0
      && state.settings.connections.some((item) => item.id === connection.id)
    ) {
      elements.connectionError.textContent = '连接名称生成的 ID 已存在，请换一个名称。';
      elements.connectionError.hidden = false;
      return;
    }
    if (existingIndex >= 0) {
      state.settings.connections.splice(existingIndex, 1, connection);
    } else {
      state.settings.connections.push(connection);
    }
    renderModelSelectors();
    renderConnections();
    markSettingsChanged();
    closeConnectionDialog();
  }

  async function testConnection(connection = connectionDraftFromDialog(), button = elements.testConnection) {
    const error = validateConnectionDraft(connection);
    if (error) {
      elements.connectionError.textContent = error;
      elements.connectionError.hidden = false;
      return;
    }
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = '测试中…';
    elements.connectionError.hidden = true;
    try {
      const result = await api('/api/settings/connections/test', {
        method: 'POST',
        body: JSON.stringify({ connection, model: connection.models[0] }),
      });
      button.textContent = `连接成功 · ${result.latencyMs}ms`;
    } catch (testError) {
      button.textContent = '测试失败';
      elements.connectionError.textContent =
        testError instanceof Error ? testError.message : String(testError);
      elements.connectionError.hidden = false;
    } finally {
      button.disabled = false;
      browserWindow.setTimeout(() => {
        button.textContent = previous;
      }, 2200);
    }
  }

  function deleteConnectionDraft() {
    const id = state.editingConnectionId;
    if (!id) return;
    if (state.settings.connections.length <= 1) {
      elements.connectionError.textContent = '至少需要保留一个模型连接。';
      elements.connectionError.hidden = false;
      return;
    }
    state.settings.connections = state.settings.connections.filter(
      (connection) => connection.id !== id,
    );
    if (state.settings.agent.primaryConnectionId === id) {
      const first = state.settings.connections[0];
      state.settings.agent.primaryConnectionId = first.id;
      state.settings.agent.primaryModel = first.models[0];
    }
    if (state.settings.agent.fallbackConnectionId === id) {
      state.settings.agent.fallbackConnectionId = '';
      state.settings.agent.fallbackModel = '';
    }
    renderModelSelectors();
    renderConnections();
    markSettingsChanged('连接已移除，保存后生效');
    closeConnectionDialog();
  }

  function collectSettings() {
    const rows = [...doc.querySelectorAll('[data-tool-name]')];
    const visibleToolNames = new Set(rows.map((row) => row.dataset.toolName));
    const disabled = state.settings.tools.disabled.filter(
      (name) => !visibleToolNames.has(name),
    );
    const requireApproval = state.settings.tools.requireApproval.filter(
      (name) => !visibleToolNames.has(name),
    );
    rows.forEach((row) => {
      const name = row.dataset.toolName;
      if (!row.querySelector('[data-tool-enabled]').checked) disabled.push(name);
      if (row.querySelector('[data-tool-approval]').checked) requireApproval.push(name);
    });
    return {
      ...state.settings,
      agent: {
        ...state.settings.agent,
        primaryConnectionId: elements.primaryConnection.value,
        primaryModel: elements.primaryModel.value,
        fallbackConnectionId: elements.fallbackConnection.value,
        fallbackModel: elements.fallbackModel.value,
        planningModel: elements.planningModel.value.trim(),
        utilityModel: elements.utilityModel.value.trim(),
        timeoutMs: Number(elements.timeout.value),
      },
      runtime: {
        ...state.settings.runtime,
        locale: elements.locale.value,
        customInstructions: elements.customInstructions.value,
        loop: elements.loop.value,
        planApproval: elements.planApproval.checked,
      },
      budget: {
        mainAgentTokens: elements.mainAgentBudget.value.trim()
          ? Number(elements.mainAgentBudget.value)
          : null,
        subAgentTokens: elements.subAgentBudget.value.trim()
          ? Number(elements.subAgentBudget.value)
          : null,
      },
      subAgent: {
        ...state.settings.subAgent,
        enabled: elements.subAgentEnabled.checked,
      },
      tools: {
        disabled,
        requireApproval,
      },
      trace: {
        contentMode: elements.traceMode.value,
      },
    };
  }

  async function saveSettings() {
    if (!state.settings) return;
    elements.settingsSave.disabled = true;
    elements.settingsSave.textContent = '保存中…';
    elements.settingsSaveStatus.textContent = '正在应用配置…';
    try {
      state.settings = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(collectSettings()),
      });
      renderSettings();
      elements.settingsSaveStatus.textContent = '已保存，从下一次任务开始生效';
      elements.runtimeLabel.textContent =
        `${state.settings.agent.primaryModel} · ${state.settings.runtime.loop} loop`;
    } catch (error) {
      elements.settingsSaveStatus.textContent =
        error instanceof Error ? error.message : String(error);
      elements.settingsSaveStatus.classList.add('is-dirty');
    } finally {
      elements.settingsSave.disabled = false;
      elements.settingsSave.textContent = '保存配置';
    }
  }

  async function api(path, options = {}) {
    const response = await browserWindow.fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
    if (!response.ok) {
      throw new Error(body?.error ?? `Request failed with status ${response.status}`);
    }
    return body;
  }

  function setConnection(ok, label) {
    elements.connection.className = `status-pill ${ok ? 'success' : 'danger'}`;
    elements.connection.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(label)}</span>`;
  }

  function workspaceName(value) {
    if (!value) return '未选择';
    const parts = value.split('/').filter(Boolean);
    return parts.at(-1) || value;
  }

  function renderWorkspaceState() {
    const current = state.workspace ?? '未选择';
    elements.workspaceLabel.textContent = current;
    elements.workspaceLabel.title = current;
    elements.workspaceButtonLabel.textContent = workspaceName(current);
    elements.workspaceContext.title = current;
    elements.recentWorkspaces.replaceChildren();
    if (state.recentWorkspaces.length === 0) return;
    const label = doc.createElement('span');
    label.className = 'recent-workspaces-label';
    label.textContent = '最近使用';
    elements.recentWorkspaces.appendChild(label);
    for (const workspace of state.recentWorkspaces) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = workspace === state.workspace ? 'is-current' : '';
      button.innerHTML = `
        <strong>${escapeHtml(workspaceName(workspace))}</strong>
        <span>${escapeHtml(workspace)}</span>
      `;
      button.addEventListener('click', () => {
        elements.workspaceInput.value = workspace;
        elements.workspaceInput.focus();
      });
      elements.recentWorkspaces.appendChild(button);
    }
  }

  function openWorkspaceDialog() {
    if (state.busy) return;
    elements.workspaceInput.value = state.workspace ?? '';
    elements.workspaceError.hidden = true;
    elements.workspaceError.textContent = '';
    renderWorkspaceState();
    elements.workspaceDialog.showModal();
    elements.workspaceInput.focus();
    elements.workspaceInput.select();
  }

  function closeWorkspaceDialog() {
    elements.workspaceDialog.close();
  }

  async function browseWorkspace() {
    if (state.busy) return;
    elements.workspaceBrowse.disabled = true;
    elements.workspaceError.hidden = true;
    try {
      const result = await api('/api/workspaces/pick', { method: 'POST' });
      if (result?.path) {
        elements.workspaceInput.value = result.path;
        elements.workspaceInput.focus();
      }
    } catch (error) {
      elements.workspaceError.textContent =
        error instanceof Error ? error.message : String(error);
      elements.workspaceError.hidden = false;
    } finally {
      elements.workspaceBrowse.disabled = false;
    }
  }

  async function switchWorkspace() {
    const requestedPath = elements.workspaceInput.value.trim();
    if (!requestedPath || state.busy) return;
    elements.workspaceConfirm.disabled = true;
    elements.workspaceError.hidden = true;
    try {
      const result = await api('/api/workspaces/select', {
        method: 'POST',
        body: JSON.stringify({ path: requestedPath }),
      });
      state.workspace = result.current;
      state.recentWorkspaces = result.recent ?? [];
      state.activeThreadId = null;
      state.pending = null;
      state.latestRun = null;
      state.events = [];
      state.messages = [];
      state.runs = [];
      state.runTraces.clear();
      state.expandedTurnId = null;
      state.expandedSubAgents.clear();
      stopRunWatchers();
      renderWorkspaceState();
      renderPending();
      renderExecution([], null);
      await loadThreads();
      resetNewThread();
      closeWorkspaceDialog();
    } catch (error) {
      elements.workspaceError.textContent =
        error instanceof Error ? error.message : String(error);
      elements.workspaceError.hidden = false;
    } finally {
      elements.workspaceConfirm.disabled = false;
    }
  }

  function renderThreads() {
    elements.threadList.replaceChildren();
    elements.threadCount.textContent = String(state.threads.length);
    for (const thread of state.threads) {
      const isRunning = [...state.runWatchers.values()].some(
        (watcher) => watcher.threadId === thread.id && !watcher.cancelled,
      );
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = `thread-button${thread.id === state.activeThreadId ? ' is-active' : ''}`;
      button.innerHTML = `
        <span class="thread-title">${escapeHtml(thread.title || '未命名会话')}</span>
        <span class="thread-meta-row">
          <span class="thread-time">${escapeHtml(relativeTime(thread.updatedAt))}</span>
          ${isRunning ? '<span class="thread-running"><span></span>执行中</span>' : ''}
        </span>
      `;
      button.addEventListener('click', () => selectThread(thread.id));
      elements.threadList.appendChild(button);
    }
  }

  function isConversationNearBottom() {
    const remaining =
      elements.conversation.scrollHeight -
      elements.conversation.scrollTop -
      elements.conversation.clientHeight;
    return remaining < 96;
  }

  function updateScrollLatestButton(show, label = '有新消息') {
    elements.scrollLatest.hidden = !show;
    elements.scrollLatest.firstChild.textContent = `${label} `;
  }

  function scrollConversationToBottom(force = false) {
    if (!force && !state.stickToBottom) {
      updateScrollLatestButton(true);
      return;
    }
    const scroll = () => {
      elements.conversation.scrollTop = elements.conversation.scrollHeight;
      state.stickToBottom = true;
      updateScrollLatestButton(false);
    };
    if (typeof browserWindow.requestAnimationFrame === 'function') {
      browserWindow.requestAnimationFrame(scroll);
    } else {
      scroll();
    }
  }

  function renderEmptyConversation() {
    elements.messageList.replaceChildren(elements.emptyTemplate.content.cloneNode(true));
    elements.conversation.scrollTop = 0;
    state.stickToBottom = true;
    updateScrollLatestButton(false);
    elements.messageList.querySelectorAll('.suggestion-list button').forEach((button) => {
      button.addEventListener('click', () => {
        elements.input.value = button.textContent;
        resizeComposerInput();
        elements.input.focus();
      });
    });
  }

  function renderMessages(messages, { forceScroll = false } = {}) {
    const shouldFollowLatest =
      forceScroll || state.stickToBottom || isConversationNearBottom();
    const previousScrollTop = elements.conversation.scrollTop;
    const visible = conversationMessages(
      messages,
      state.pending?.inputRequest?.question,
    );
    elements.messageList.replaceChildren();
    if (visible.length === 0) {
      renderEmptyConversation();
      return;
    }
    const latestUserIndex = visible.findLastIndex((message) => message.role === 'user');
    const followingAssistant = visible
      .slice(latestUserIndex + 1)
      .find((message) => message.role === 'assistant');
    const reasoningItems = extractReasoningItems(state.events).filter(
      (item) => item.content.trim() !== followingAssistant?.content?.trim(),
    );
    const shouldOpenReasoning =
      state.busy || state.latestRun?.status === 'running';

    const appendReasoning = () => {
      if (reasoningItems.length === 0) return;
      const article = doc.createElement('article');
      article.className = 'message reasoning-message';
      const items = reasoningItems
        .map((item) => `
          <li class="reasoning-item ${escapeHtml(item.kind)}">
            <span class="reasoning-label">${escapeHtml(item.label)}</span>
            <div class="reasoning-content">${renderMarkdown(item.content)}</div>
          </li>
        `)
        .join('');
      article.innerHTML = `
        <div class="message-avatar" aria-hidden="true">1</div>
        <details class="reasoning-panel"${shouldOpenReasoning ? ' open' : ''}>
          <summary>
            <span class="reasoning-summary-title">
              <span class="reasoning-symbol" aria-hidden="true">⌁</span>
              <strong>思考过程</strong>
            </span>
            <span class="reasoning-summary-meta">${reasoningItems.length} 条记录</span>
          </summary>
          <div class="reasoning-body">
            <ol class="reasoning-list">${items}</ol>
            <p class="reasoning-note">来自本次运行中可展示的 Trace 记录</p>
          </div>
        </details>
      `;
      elements.messageList.appendChild(article);
    };

    visible.forEach((message, index) => {
      const article = doc.createElement('article');
      article.className = `message ${message.role}`;
      const avatar = doc.createElement('div');
      avatar.className = 'message-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = message.role === 'user' ? '你' : '1';
      const content = doc.createElement('div');
      content.className = 'message-content';
      content.innerHTML = renderMarkdown(message.content);
      if (message.createdAt) {
        const meta = doc.createElement('div');
        meta.className = 'message-meta';
        meta.textContent = relativeTime(message.createdAt);
        content.appendChild(meta);
      }
      if (message.role === 'user') article.append(content, avatar);
      else article.append(avatar, content);
      elements.messageList.appendChild(article);
      if (index === latestUserIndex) appendReasoning();
    });
    appendSubAgentPanel();
    if (shouldFollowLatest) {
      scrollConversationToBottom(true);
    } else {
      elements.conversation.scrollTop = previousScrollTop;
      state.stickToBottom = false;
      updateScrollLatestButton(true, '回到最新');
    }
  }

  function appendThinking(forceScroll = false) {
    doc.querySelector('#thinking-message')?.remove();
    const article = doc.createElement('article');
    article.className = 'message';
    article.id = 'thinking-message';
    article.innerHTML = `
      <div class="message-avatar" aria-hidden="true">1</div>
      <div class="message-content thinking">
        <span>One Agent 正在执行</span>
        <span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      </div>
    `;
    elements.messageList.appendChild(article);
    scrollConversationToBottom(forceScroll);
  }

  function showError(error) {
    const banner = doc.createElement('div');
    banner.className = 'error-banner';
    banner.textContent = error instanceof Error ? error.message : String(error);
    elements.messageList.appendChild(banner);
    scrollConversationToBottom();
  }

  function setExecutionOpen(value) {
    const wideLayout = state.wideExecutionLayout;
    state.executionOpen = state.settingsOpen ? false : wideLayout ? true : Boolean(value);
    elements.executionPanel.classList.toggle('is-open', state.executionOpen);
    elements.executionPanel.setAttribute('aria-hidden', String(!state.executionOpen));
    elements.executionToggle.setAttribute('aria-expanded', String(state.executionOpen));
    elements.executionBackdrop.hidden = wideLayout || !state.executionOpen;
    if (state.executionOpen) {
      elements.executionPanel.scrollTop = elements.executionPanel.scrollHeight;
    } else {
      const mobileExecution = doc.querySelector('[data-mobile-panel="execution"]');
      if (mobileExecution?.classList.contains('is-active')) {
        mobileExecution.classList.remove('is-active');
        doc.querySelector('[data-mobile-panel="chat"]')?.classList.add('is-active');
        doc.querySelector('[data-panel="threads"]')?.classList.remove('is-mobile-visible');
        doc.querySelector('[data-panel="chat"]')?.classList.add('is-mobile-visible');
      }
    }
  }

  function syncExecutionLayout() {
    const wideLayout = Number(browserWindow.innerWidth) >= 1180;
    if (wideLayout === state.wideExecutionLayout) return;
    state.wideExecutionLayout = wideLayout;
    setExecutionOpen(wideLayout);
  }

  function setBusy(value) {
    state.busy = value;
    const runInProgress = isRunInProgress(state.latestRun);
    const disabled = value || Boolean(state.pending) || runInProgress;
    elements.input.disabled = disabled;
    elements.send.disabled = disabled;
    elements.input.placeholder = state.pending
      ? '请先处理当前审批，完成后可继续对话'
      : runInProgress
        ? '当前会话正在后台执行，可切换到其他会话'
        : value
          ? 'One Agent 正在执行…'
          : '描述你希望 One Agent 完成的任务…';
    elements.send.textContent = state.pending
      ? '等待审批'
      : runInProgress
        ? '后台执行中'
        : value
          ? '执行中'
          : '发送';
    elements.newThread.disabled = value;
    const status =
      value || runInProgress
        ? 'running'
        : state.pending
          ? 'waiting_for_input'
          : state.latestRun?.status ?? 'idle';
    const labels = {
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      waiting_for_input: '等待输入',
      running: '执行中',
      interrupted: '可恢复',
      recovery_required: '需要恢复',
      idle: '空闲',
    };
    const statusClass =
      status === 'completed'
        ? 'success'
        : status === 'failed'
          ? 'danger'
          : status === 'running' || status === 'waiting_for_input'
            ? 'warning'
            : '';
    elements.runStatus.textContent = labels[status] ?? status;
    elements.runStatus.className = `status-pill ${statusClass}`;
    elements.executionToggleStatus.textContent = labels[status] ?? status;
    elements.executionToggleStatus.className = `execution-toggle-status ${statusClass}`;
    const presentation = runStatePresentation({
      busy: state.busy,
      pending: state.pending,
      run: state.latestRun,
      events: state.events,
    });
    elements.runStateStrip.hidden = presentation.hidden;
    elements.runStateStrip.className = `run-state-strip ${presentation.tone}`;
    elements.runStateText.textContent = presentation.title;
    elements.runStateDetail.textContent = presentation.detail;
  }

  function renderPending() {
    const request = state.pending?.inputRequest;
    elements.pendingCard.hidden = !request;
    elements.pendingCard.classList.remove('is-processing');
    elements.pendingStatus.textContent = '等待输入';
    elements.pendingCard.querySelectorAll('button').forEach((button) => {
      button.disabled = false;
    });
    elements.pendingAnswer.disabled = false;
    if (!request) {
      elements.pendingImpact.hidden = true;
      elements.pendingOptions.replaceChildren();
      elements.pendingRevision.hidden = true;
      elements.pendingRevise.hidden = true;
      elements.continueButton.hidden = true;
      elements.pendingAnswer.value = '';
      setBusy(state.busy);
      return;
    }

    const labels = {
      plan_approval: '计划确认',
      tool_approval: '工具审批',
      clarification: '需要补充信息',
    };
    elements.pendingKind.textContent = labels[request.kind] ?? '需要确认';
    const impact = pendingImpactSummary(request);
    elements.pendingImpact.hidden = !impact.copy;
    elements.pendingImpactCopy.textContent = impact.copy;
    elements.pendingRisk.textContent = impact.risk;
    elements.pendingRisk.className = `pending-risk ${impact.tone}`;
    elements.pendingQuestion.innerHTML = renderMarkdown(request.question);
    elements.pendingOptions.replaceChildren();
    elements.pendingAnswer.value = '';
    elements.approvalArguments.hidden = true;

    if (request.kind === 'tool_approval' && request.approval?.toolCall) {
      elements.approvalArguments.hidden = false;
      elements.approvalArguments.textContent = `${request.approval.toolCall.name}\n${JSON.stringify(request.approval.toolCall.arguments, null, 2)}`;
    }

    for (const option of request.options ?? []) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent =
        option === 'approve' ? '批准执行' : option === 'reject' ? '拒绝' : option;
      button.addEventListener('click', () => continueRun(option, button));
      elements.pendingOptions.appendChild(button);
    }

    const mayRevise =
      request.kind === 'plan_approval' &&
      (request.planReview?.revision ?? 0) < (request.planReview?.maxRevisions ?? 1);
    const needsAnswer = request.kind === 'clarification';
    elements.pendingRevision.hidden = !needsAnswer;
    elements.pendingAnswer.hidden = false;
    elements.pendingAnswerLabel.hidden = false;
    elements.pendingRevise.hidden = !mayRevise;
    elements.pendingRevise.textContent = '修改计划';
    elements.pendingRevise.classList.remove('is-active');
    elements.continueButton.hidden = !needsAnswer;
    elements.continueButton.textContent = needsAnswer ? '提交回答' : '提交修改';
    elements.cancelWaiting.hidden = request.kind !== 'clarification';
    elements.pendingAnswerLabel.textContent =
      request.kind === 'plan_approval' ? '计划修改意见' : '你的回答';
    setBusy(state.busy);
    scrollConversationToBottom();
  }

  function togglePendingRevision() {
    if (!state.pending || elements.pendingRevise.hidden) return;
    const willOpen = elements.pendingRevision.hidden;
    elements.pendingRevision.hidden = !willOpen;
    elements.continueButton.hidden = !willOpen;
    elements.pendingRevise.classList.toggle('is-active', willOpen);
    elements.pendingRevise.textContent = willOpen ? '收起修改' : '修改计划';
    if (willOpen) {
      elements.pendingAnswer.focus();
      scrollConversationToBottom(true);
    }
  }

  function runStatusLabel(status) {
    const labels = {
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      waiting_for_input: '等待输入',
      running: '执行中',
      pending: '等待执行',
      interrupted: '可恢复',
      recovery_required: '需要恢复',
      idle: '未执行',
    };
    return labels[status] ?? status;
  }

  function runStatusClass(status) {
    if (status === 'completed') return 'success';
    if (status === 'failed' || status === 'cancelled') return 'failed';
    if (status === 'running' || status === 'waiting_for_input' || status === 'pending') {
      return 'running';
    }
    return 'idle';
  }

  function formatRunDuration(runs) {
    if (!runs?.length) return '';
    const start = Date.parse(runs[0].startTime);
    const finalRun = runs.at(-1);
    const end = Date.parse(finalRun.endTime ?? new Date().toISOString());
    if (Number.isNaN(start) || Number.isNaN(end)) return '';
    const milliseconds = Math.max(0, end - start);
    if (milliseconds < 1000) return `${milliseconds}ms`;
    if (milliseconds < 60_000) {
      return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
    }
    return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1000)}s`;
  }

  function truncateLine(value, maxLength = 76) {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
    return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
  }

  function createEventTimeline(events) {
    const timeline = doc.createElement('ol');
    timeline.className = 'event-timeline';
    const visibleEvents = meaningfulTimelineEvents(events)
      .map((data) => ({
        data,
        view: eventDescription(data),
      }))
      .filter((item) => item.view)
      .slice(-36);

    for (const { data, view } of visibleEvents) {
      const item = doc.createElement('li');
      item.className = `event-row ${view.status}`;
      const evidence = view.evidence
        ? `<div class="subagent-evidence"><strong>Evidence Packet</strong><br>${escapeHtml(view.evidence.conclusion ?? '未返回结论')}</div>`
        : '';
      const modelInspector =
        data.type === 'model_call' ? renderModelCallInspector(data) : '';
      item.innerHTML = `
        <div class="event-row-header">
          <span class="event-title">${escapeHtml(view.title)}</span>
          <span class="event-type">${escapeHtml(view.type)}</span>
        </div>
        ${view.detail ? `<div class="event-detail">${escapeHtml(view.detail)}</div>` : ''}
        ${evidence}
        ${modelInspector}
      `;
      timeline.appendChild(item);
    }
    return timeline;
  }

  function subAgentStatus(item) {
    if (item.status === 'started') return { label: '执行中', className: 'running' };
    if (item.status === 'failed') {
      const labels = {
        timed_out: '已超时',
        cancelled: '已取消',
        budget_exhausted: '预算耗尽',
      };
      return {
        label: labels[item.executionStatus] ?? '失败',
        className: 'failed',
      };
    }
    return { label: '已完成', className: 'success' };
  }

  function renderSubAgentEvidence(item) {
    const packet = item.evidencePacket;
    if (!packet) return '';
    const evidence = (packet.evidence ?? [])
      .map((entry) => `
        <li>
          <strong>${escapeHtml(entry.toolName || '工具证据')}</strong>
          ${entry.source ? `<code>${escapeHtml(entry.source)}</code>` : ''}
          <p>${escapeHtml(entry.observation)}</p>
        </li>
      `)
      .join('');
    const limitations = [
      ...(packet.uncertainty ?? []),
      ...(packet.unresolvedQuestions ?? []),
    ];
    return `
      <section class="subagent-result-block">
        <span class="subagent-block-label">结论与证据</span>
        ${packet.conclusion ? `<div class="subagent-conclusion">${renderMarkdown(packet.conclusion)}</div>` : ''}
        ${evidence ? `<ul class="subagent-evidence-list">${evidence}</ul>` : ''}
        ${
          limitations.length
            ? `<div class="subagent-limitations"><strong>尚未确认</strong>${limitations
                .map((item) => `<span>${escapeHtml(item)}</span>`)
                .join('')}</div>`
            : ''
        }
      </section>
    `;
  }

  function appendSubAgentPanel() {
    const subAgents = buildSubAgentItems(state.events);
    if (subAgents.length === 0) return;
    const runningCount = subAgents.filter((item) => item.status === 'started').length;
    const panel = doc.createElement('article');
    panel.className = 'message subagent-message';
    const container = doc.createElement('section');
    container.className = 'subagent-panel';
    container.innerHTML = `
      <div class="subagent-panel-heading">
        <span class="subagent-panel-title">
          <span class="subagent-panel-symbol" aria-hidden="true">↗</span>
          <strong>子 Agent</strong>
        </span>
        <span class="subagent-panel-meta">
          ${subAgents.length} 个${runningCount ? ` · ${runningCount} 个执行中` : ' · 全部结束'}
        </span>
      </div>
      <div class="subagent-list"></div>
    `;
    const list = container.querySelector('.subagent-list');

    subAgents.forEach((item) => {
      const status = subAgentStatus(item);
      const details = doc.createElement('details');
      details.className = `subagent-row ${status.className}`;
      details.dataset.subAgentId = item.id;
      details.open = state.expandedSubAgents.has(item.id);
      const metrics = [
        item.durationMs ? `${(item.durationMs / 1000).toFixed(item.durationMs < 10_000 ? 1 : 0)}s` : '',
        item.toolCallCount ? `${item.toolCallCount} 次工具` : '',
        item.tokenUsage?.totalTokens ? `${item.tokenUsage.totalTokens} tokens` : '',
      ].filter(Boolean);
      const checklist = Array.isArray(item.checklist) && item.checklist.length
        ? `
          <section class="subagent-task-block">
            <span class="subagent-block-label">内部检查清单</span>
            <ul class="subagent-evidence-list">
              ${item.checklist.map((entry) => `
                <li><strong>${escapeHtml(entry.id || '')}</strong><p>${escapeHtml(entry.description || '')}</p></li>
              `).join('')}
            </ul>
          </section>
        `
        : '';
      details.innerHTML = `
        <summary>
          <span class="subagent-status-dot" aria-hidden="true"></span>
          <span class="subagent-row-copy">
            <span class="subagent-row-title">
              子 Agent ${item.order}${item.stepId ? ` · 步骤 ${escapeHtml(item.stepId)}` : ''}
            </span>
            <span class="subagent-row-task">${escapeHtml(truncateLine(item.task, 96))}</span>
          </span>
          <span class="subagent-row-state">${escapeHtml(status.label)}</span>
          <span class="subagent-row-chevron" aria-hidden="true">›</span>
        </summary>
        <div class="subagent-row-body">
          <section class="subagent-task-block">
            <span class="subagent-block-label">委派工作包</span>
            <p>${escapeHtml(item.task || '未记录任务说明')}</p>
            ${item.expectedOutcome ? `<p><strong>交付物：</strong>${escapeHtml(item.expectedOutcome)}</p>` : ''}
            ${item.delegationReason ? `<p><strong>委派原因：</strong>${escapeHtml(item.delegationReason)}</p>` : ''}
          </section>
          ${checklist}
          ${
            item.status === 'started'
              ? '<p class="subagent-running-copy">子 Agent 已启动，完成后这里会展示工具调用、结论和证据。</p>'
              : `
                ${metrics.length ? `<div class="subagent-metrics">${metrics.map((metric) => `<span>${escapeHtml(metric)}</span>`).join('')}</div>` : ''}
                ${item.reply ? `<section class="subagent-result-block"><span class="subagent-block-label">执行结果</span><div class="subagent-reply">${renderMarkdown(item.reply)}</div></section>` : ''}
                ${renderSubAgentEvidence(item)}
              `
          }
          <div class="subagent-event-stream"></div>
        </div>
      `;
      const stream = details.querySelector('.subagent-event-stream');
      if (stream && item.events?.length) {
        stream.appendChild(createEventTimeline(item.events));
      }
      details.addEventListener('toggle', () => {
        if (details.open) state.expandedSubAgents.add(item.id);
        else state.expandedSubAgents.delete(item.id);
      });
      list.appendChild(details);
    });

    const avatar = doc.createElement('div');
    avatar.className = 'message-avatar subagent-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = '↗';
    panel.append(avatar, container);
    elements.messageList.appendChild(panel);
  }

  function renderTurnFlow(turn, container) {
    container.replaceChildren();
    if (turn.runs.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'turn-flow-empty';
      empty.textContent = state.busy ? '正在建立本次执行流程…' : '这条对话没有关联的运行记录。';
      container.appendChild(empty);
      return;
    }

    if (turn.response?.content) {
      const result = doc.createElement('div');
      result.className = 'turn-result';
      result.innerHTML = `
        <strong>本次回答</strong>
        <span>${escapeHtml(truncateLine(turn.response.content, 96))}</span>
      `;
      container.appendChild(result);
    }

    turn.runs.forEach((run, index) => {
      const section = doc.createElement('section');
      section.className = 'turn-run-segment';
      if (turn.runs.length > 1) {
        const heading = doc.createElement('div');
        heading.className = 'turn-run-heading';
        heading.innerHTML = `
          <strong>${index === 0 ? '首次执行' : `继续执行 ${index + 1}`}</strong>
          <span>${escapeHtml(shortId(run.id))} · ${escapeHtml(runStatusLabel(run.status))}</span>
        `;
        section.appendChild(heading);
      }
      const traces = state.runTraces.get(run.id);
      if (!traces) {
        const loading = doc.createElement('p');
        loading.className = 'turn-flow-empty';
        loading.textContent = '正在加载执行过程…';
        section.appendChild(loading);
      } else {
        const timeline = createEventTimeline(traces);
        if (timeline.children.length === 0) {
          const empty = doc.createElement('p');
          empty.className = 'turn-flow-empty';
          empty.textContent = '这次运行没有可展示的流程记录。';
          section.appendChild(empty);
        } else {
          section.appendChild(timeline);
        }
      }
      container.appendChild(section);
    });
  }

  async function loadTurnFlow(turn, details) {
    const missingRuns = turn.runs.filter((run) => !state.runTraces.has(run.id));
    const body = details.querySelector('.turn-flow');
    if (!body) return;
    renderTurnFlow(turn, body);
    if (missingRuns.length === 0) return;
    try {
      const results = await Promise.all(
        missingRuns.map(async (run) => ({
          run,
          traces: await api(`/api/runs/${encodeURIComponent(run.id)}/traces`),
        })),
      );
      results.forEach(({ run, traces }) => state.runTraces.set(run.id, traces));
      if (details.open) renderTurnFlow(turn, body);
      const meta = details.querySelector('.dialogue-run-meta');
      if (meta) {
        const events = turn.runs.flatMap((run) => state.runTraces.get(run.id) ?? []);
        const summary = summarizeEvents(events);
        meta.textContent = [
          relativeTime(turn.message.createdAt),
          formatRunDuration(turn.runs),
          summary.tools ? `${summary.tools} 工具` : '',
          summary.subAgents ? `${summary.subAgents} 子 Agent` : '',
        ].filter(Boolean).join(' · ');
      }
    } catch (error) {
      body.innerHTML = `<p class="turn-flow-empty danger">${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</p>`;
    }
  }

  function renderExecutionList() {
    const turns = buildDialogueTurns(state.messages, state.runs);
    elements.dialogueRunList.replaceChildren();
    elements.executionEmpty.hidden = turns.length > 0;

    turns.forEach((turn, index) => {
      const latestRun = turn.runs.at(-1);
      const isOptimisticRunning =
        !latestRun && state.busy && index === turns.length - 1;
      const status = latestRun?.status ?? (isOptimisticRunning ? 'running' : 'idle');
      const cachedEvents = turn.runs.flatMap((run) => state.runTraces.get(run.id) ?? []);
      const eventSummary = summarizeEvents(cachedEvents);
      const details = doc.createElement('details');
      details.className = `dialogue-run ${runStatusClass(status)}`;
      details.dataset.turnId = turn.id;
      details.open = state.expandedTurnId === turn.id;
      const meta = [
        relativeTime(turn.message.createdAt),
        formatRunDuration(turn.runs),
        eventSummary.tools ? `${eventSummary.tools} 工具` : '',
        eventSummary.subAgents ? `${eventSummary.subAgents} 子 Agent` : '',
      ].filter(Boolean).join(' · ');
      details.innerHTML = `
        <summary>
          <span class="dialogue-status-dot" aria-hidden="true"></span>
          <span class="dialogue-run-copy">
            <span class="dialogue-run-prompt">
              <span>你</span>
              <strong>${escapeHtml(truncateLine(turn.message.content))}</strong>
            </span>
            <span class="dialogue-run-meta">${escapeHtml(meta || '尚未执行')}</span>
          </span>
          <span class="dialogue-run-state">${escapeHtml(runStatusLabel(status))}</span>
          <span class="dialogue-run-chevron" aria-hidden="true">›</span>
        </summary>
        <div class="turn-flow"></div>
      `;
      const body = details.querySelector('.turn-flow');
      if (details.open && body) renderTurnFlow(turn, body);
      details.addEventListener('toggle', () => {
        if (details.open) {
          elements.dialogueRunList.querySelectorAll('.dialogue-run').forEach((other) => {
            if (other !== details) other.open = false;
          });
          state.expandedTurnId = turn.id;
          loadTurnFlow(turn, details);
        } else if (state.expandedTurnId === turn.id) {
          state.expandedTurnId = null;
        }
      });
      elements.dialogueRunList.appendChild(details);
    });
  }

  function renderExecution(events, run = state.latestRun) {
    state.events = Array.isArray(events) ? events : [];
    state.latestRun = run ?? null;
    if (run?.id) {
      state.runTraces.set(run.id, state.events);
      const existingIndex = state.runs.findIndex((item) => item.id === run.id);
      const normalizedRun = {
        startTime: new Date().toISOString(),
        endTime: run.status === 'completed' || run.status === 'failed'
          ? new Date().toISOString()
          : null,
        ...state.runs[existingIndex],
        ...run,
      };
      if (existingIndex >= 0) state.runs.splice(existingIndex, 1, normalizedRun);
      else state.runs.push(normalizedRun);
    }
    elements.traceLink.href = `http://${browserWindow.location.hostname}:3001`;
    renderExecutionList();
    setBusy(state.busy);
  }

  async function loadLatestRun(threadId) {
    const runs = await api(`/api/threads/${encodeURIComponent(threadId)}/runs`);
    if (state.activeThreadId !== threadId) return;
    state.runs = [...runs].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    const sorted = [...runs].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
    const run = sorted[0];
    if (!run) {
      state.pending = null;
      renderPending();
      renderExecution([], null);
      return;
    }
    const traces = await api(`/api/runs/${encodeURIComponent(run.id)}/traces`);
    if (state.activeThreadId !== threadId) return;
    state.pending = pendingInputFromEvents(run, traces);
    renderPending();
    renderExecution(traces, run);
    if (isRunInProgress(run)) watchRun(threadId, run.id);
  }

  function stopRunWatchers() {
    for (const watcher of state.runWatchers.values()) watcher.cancelled = true;
    state.runWatchers.clear();
  }

  async function refreshWatchedRun(threadId, runId) {
    const [run, traces] = await Promise.all([
      api(`/api/runs/${encodeURIComponent(runId)}`),
      api(`/api/runs/${encodeURIComponent(runId)}/traces`),
    ]);
    state.runTraces.set(runId, traces);
    if (state.activeThreadId !== threadId) return run;

    state.pending = pendingInputFromEvents(run, traces);
    renderExecution(traces, run);
    if (!isRunInProgress(run)) {
      const messages = await api(
        `/api/threads/${encodeURIComponent(threadId)}/messages`,
      );
      if (state.activeThreadId !== threadId) return run;
      state.messages = messages;
    }
    renderMessages(state.messages);
    if (isRunInProgress(run)) appendThinking();
    renderPending();
    setBusy(state.busy);
    if (run.status === 'failed' && run.error) showError(new Error(run.error));
    return run;
  }

  function watchRun(threadId, runId) {
    if (!runId || state.runWatchers.has(runId)) return;
    const watcher = { threadId, cancelled: false, failures: 0 };
    state.runWatchers.set(runId, watcher);
    renderThreads();

    const poll = async () => {
      if (watcher.cancelled) return;
      try {
        const run = await refreshWatchedRun(threadId, runId);
        watcher.failures = 0;
        if (!isRunInProgress(run)) {
          state.runWatchers.delete(runId);
          await loadThreads();
          return;
        }
      } catch (error) {
        watcher.failures += 1;
        if (watcher.failures >= 3) {
          state.runWatchers.delete(runId);
          renderThreads();
          if (state.activeThreadId === threadId) {
            showError(error);
            setBusy(false);
          }
          return;
        }
      }
      browserWindow.setTimeout(() => {
        void poll();
      }, 900);
    };

    browserWindow.setTimeout(() => {
      void poll();
    }, 150);
  }

  async function loadThreads(selectInitial = false) {
    state.threads = await api('/api/threads');
    if (selectInitial && !state.activeThreadId && state.threads[0]) {
      state.activeThreadId = state.threads[0].id;
    }
    renderThreads();
  }

  async function selectThread(threadId) {
    state.activeThreadId = threadId;
    state.messages = [];
    state.runs = [];
    state.latestRun = null;
    state.events = [];
    state.runTraces.clear();
    state.expandedTurnId = null;
    state.expandedSubAgents.clear();
    const thread = state.threads.find((item) => item.id === threadId);
    elements.threadTitle.textContent = thread?.title || '未命名会话';
    renderThreads();
    state.pending = null;
    renderPending();
    try {
      const [messages] = await Promise.all([
        api(`/api/threads/${encodeURIComponent(threadId)}/messages`),
        loadLatestRun(threadId),
      ]);
      if (state.activeThreadId !== threadId) return;
      state.messages = messages;
      renderMessages(messages, { forceScroll: true });
      renderExecutionList();
    } catch (error) {
      showError(error);
    }
  }

  function resetNewThread() {
    state.activeThreadId = null;
    state.pending = null;
    state.latestRun = null;
    state.events = [];
    state.messages = [];
    state.runs = [];
    state.runTraces.clear();
    state.expandedTurnId = null;
    state.expandedSubAgents.clear();
    elements.threadTitle.textContent = '新会话';
    renderThreads();
    renderPending();
    renderExecution([], null);
    renderEmptyConversation();
    elements.input.disabled = false;
    elements.send.disabled = false;
    elements.input.focus();
  }

  function startNewThread() {
    openWorkspaceDialog();
  }

  async function sendMessage() {
    const message = elements.input.value.trim();
    if (!message || state.busy || state.pending) return;
    const originThreadId = state.activeThreadId;
    setBusy(true);
    state.messages = [
      ...visibleMessages(state.messages),
      { role: 'user', content: message, createdAt: new Date().toISOString() },
    ];
    renderMessages(state.messages, { forceScroll: true });
    renderExecutionList();
    appendThinking(true);
    elements.input.value = '';
    resizeComposerInput();

    try {
      const result = await api('/api/web/chat', {
        method: 'POST',
        body: JSON.stringify({
          message,
          ...(originThreadId ? { threadId: originThreadId } : {}),
        }),
      });
      const stillViewingOrigin = state.activeThreadId === originThreadId;
      if (stillViewingOrigin) {
        state.activeThreadId = result.threadId;
        state.pending = null;
      }
      await loadThreads();
      const run = {
        id: result.runId,
        threadId: result.threadId,
        status: 'running',
      };
      if (stillViewingOrigin) {
        renderExecution([], run);
        renderMessages(state.messages);
        appendThinking(true);
        renderPending();
        const thread = state.threads.find((item) => item.id === state.activeThreadId);
        elements.threadTitle.textContent = thread?.title || message.slice(0, 50);
      }
      watchRun(result.threadId, result.runId);
    } catch (error) {
      if (state.activeThreadId === originThreadId) {
        doc.querySelector('#thinking-message')?.remove();
        showError(error);
      }
    } finally {
      setBusy(false);
      if (state.activeThreadId === originThreadId) elements.input.focus();
    }
  }

  async function continueRun(answerOverride) {
    if (!state.pending || state.busy) return;
    const answer = String(answerOverride ?? elements.pendingAnswer.value).trim();
    if (!answer) {
      elements.pendingAnswer.focus();
      return;
    }
    const requestKind = state.pending.inputRequest?.kind;
    const originThreadId = state.activeThreadId;
    const progressLabel = approvalProgressLabel(answer, requestKind);
    setBusy(true);
    elements.pendingCard.classList.add('is-processing');
    elements.pendingStatus.textContent = '执行中';
    elements.pendingCard.querySelectorAll('button').forEach((button) => {
      button.disabled = true;
    });
    elements.pendingAnswer.disabled = true;
    const actionButton =
      answerOverride === undefined
        ? elements.continueButton
        : [...elements.pendingOptions.querySelectorAll('button')].find(
            (button) =>
              (answer === 'approve' && button.textContent === '批准执行') ||
              (answer === 'reject' && button.textContent === '拒绝'),
          );
    if (actionButton) actionButton.textContent = progressLabel;
    try {
      const pendingRunId = state.pending.runId;
      const threadId = state.latestRun?.threadId ?? state.activeThreadId;
      const result = await api(`/api/web/runs/${encodeURIComponent(pendingRunId)}/input`, {
        method: 'POST',
        body: JSON.stringify({ answer }),
      });
      if (state.activeThreadId === originThreadId) {
        state.pending = null;
        renderPending();
        renderExecution([], {
          id: result.runId,
          threadId: result.threadId,
          status: 'running',
        });
        renderMessages(state.messages);
        appendThinking(true);
      }
      watchRun(threadId ?? result.threadId, result.runId);
    } catch (error) {
      if (state.activeThreadId === originThreadId) {
        showError(error);
        renderPending();
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelWaitingRun() {
    if (!state.pending || state.busy) return;
    setBusy(true);
    try {
      await api(`/api/runs/${encodeURIComponent(state.pending.runId)}/cancel`, {
        method: 'POST',
      });
      state.pending = null;
      renderPending();
      await loadLatestRun(state.activeThreadId);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  function setupMobileNavigation() {
    const buttons = doc.querySelectorAll('[data-mobile-panel]');
    const basePanels = doc.querySelectorAll('[data-panel="threads"], [data-panel="chat"]');
    const show = (name) => {
      if (state.settingsOpen) setSettingsOpen(false);
      buttons.forEach((button) => {
        button.classList.toggle('is-active', button.dataset.mobilePanel === name);
      });
      if (name === 'execution') {
        basePanels.forEach((panel) => {
          panel.classList.toggle('is-mobile-visible', panel.dataset.panel === 'chat');
        });
        setExecutionOpen(true);
        return;
      }
      setExecutionOpen(false);
      basePanels.forEach((panel) => {
        panel.classList.toggle('is-mobile-visible', panel.dataset.panel === name);
      });
    };
    buttons.forEach((button) =>
      button.addEventListener('click', () => show(button.dataset.mobilePanel)),
    );
    show('chat');
  }

  async function init() {
    setupMobileNavigation();
    elements.settingsButton.addEventListener('click', () => setSettingsOpen(true));
    elements.mobileSettingsButton.addEventListener('click', () => setSettingsOpen(true));
    elements.settingsClose.addEventListener('click', () => setSettingsOpen(false));
    doc.querySelectorAll('[data-settings-tab]').forEach((button) => {
      button.addEventListener('click', () => showSettingsTab(button.dataset.settingsTab));
    });
    elements.settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      saveSettings();
    });
    elements.settingsForm.addEventListener('change', () => markSettingsChanged());
    elements.primaryConnection.addEventListener('change', () => {
      state.settings.agent.primaryConnectionId = elements.primaryConnection.value;
      state.settings.agent.primaryModel =
        connectionById(elements.primaryConnection.value)?.models[0] ?? '';
      renderModelSelectors();
      renderConnections();
    });
    elements.primaryModel.addEventListener('change', () => {
      state.settings.agent.primaryModel = elements.primaryModel.value;
    });
    elements.fallbackConnection.addEventListener('change', () => {
      state.settings.agent.fallbackConnectionId = elements.fallbackConnection.value;
      state.settings.agent.fallbackModel =
        connectionById(elements.fallbackConnection.value)?.models[0] ?? '';
      renderModelSelectors();
      renderConnections();
    });
    elements.fallbackModel.addEventListener('change', () => {
      state.settings.agent.fallbackModel = elements.fallbackModel.value;
    });
    elements.addConnection.addEventListener('click', () => openConnectionDialog());
    elements.connectionDialogClose.addEventListener('click', closeConnectionDialog);
    elements.connectionForm.addEventListener('submit', (event) => {
      event.preventDefault();
      saveConnectionDraft();
    });
    elements.deleteConnection.addEventListener('click', deleteConnectionDraft);
    elements.testConnection.addEventListener('click', () => testConnection());
    elements.connectionList.addEventListener('click', (event) => {
      const editButton = event.target.closest('[data-edit-connection]');
      if (editButton) {
        openConnectionDialog(editButton.dataset.editConnection);
        return;
      }
      const testButton = event.target.closest('[data-test-connection]');
      if (testButton) {
        const connection = connectionById(testButton.dataset.testConnection);
        if (connection) testConnection(connection, testButton);
      }
    });
    elements.executionToggle.addEventListener('click', () => {
      setExecutionOpen(!state.executionOpen);
    });
    elements.executionClose.addEventListener('click', () => setExecutionOpen(false));
    elements.executionBackdrop.addEventListener('click', () => setExecutionOpen(false));
    browserWindow.addEventListener('resize', syncExecutionLayout);
    elements.scrollLatest.addEventListener('click', () => scrollConversationToBottom(true));
    elements.conversation.addEventListener('scroll', () => {
      state.stickToBottom = isConversationNearBottom();
      if (state.stickToBottom) updateScrollLatestButton(false);
      else updateScrollLatestButton(true, '回到最新');
    });
    elements.conversation.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-copy-code]');
      if (!button) return;
      const code = button.closest('.code-block')?.querySelector('code');
      if (!code) return;
      try {
        await browserWindow.navigator.clipboard.writeText(code.textContent ?? '');
        button.textContent = '已复制';
        browserWindow.setTimeout(() => {
          button.textContent = '复制';
        }, 1400);
      } catch {
        button.textContent = '复制失败';
      }
    });
    elements.executionPanel.addEventListener('click', (event) => {
      const button = event.target.closest('[data-model-tab]');
      if (!button) return;
      const container = button.closest('.model-io-content');
      if (!container) return;
      const selected = button.dataset.modelTab;
      container.querySelectorAll('[data-model-tab]').forEach((tab) => {
        const active = tab.dataset.modelTab === selected;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      container.querySelectorAll('[data-model-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.modelPanel !== selected;
      });
    });
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.executionOpen) setExecutionOpen(false);
    });
    elements.send.addEventListener('click', sendMessage);
    elements.newThread.addEventListener('click', startNewThread);
    elements.continueButton.addEventListener('click', () => continueRun());
    elements.pendingRevise.addEventListener('click', togglePendingRevision);
    elements.cancelWaiting.addEventListener('click', cancelWaitingRun);
    elements.workspaceClose.addEventListener('click', closeWorkspaceDialog);
    elements.workspaceCancel.addEventListener('click', closeWorkspaceDialog);
    elements.workspaceBrowse.addEventListener('click', browseWorkspace);
    elements.workspaceForm.addEventListener('submit', (event) => {
      event.preventDefault();
      switchWorkspace();
    });
    elements.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    elements.input.addEventListener('input', resizeComposerInput);
    resizeComposerInput();
    setExecutionOpen(false);
    renderEmptyConversation();

    try {
      const [health, workspaceState] = await Promise.all([
        api('/api/health'),
        api('/api/workspaces'),
      ]);
      setConnection(true, '本地运行');
      elements.runtimeLabel.textContent = `${health.model} · ${health.loop ?? 'auto'} loop`;
      state.workspace = workspaceState.current ?? health.workspace;
      state.recentWorkspaces = workspaceState.recent ?? [];
      renderWorkspaceState();
      await loadThreads(true);
      if (state.activeThreadId) await selectThread(state.activeThreadId);
    } catch (error) {
      setConnection(false, '连接失败');
      elements.runtimeLabel.textContent = '无法连接 One Agent API';
      showError(error);
    }
  }

  return {
    init,
    state,
    selectThread,
    sendMessage,
    continueRun,
    switchWorkspace,
  };
}

export { createWebApp };

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  createWebApp().init();
}
