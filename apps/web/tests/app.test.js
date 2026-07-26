import { describe, expect, it } from 'vitest';
import {
  approvalProgressLabel,
  buildDialogueTurns,
  buildSubAgentItems,
  conversationMessages,
  escapeHtml,
  extractReasoningItems,
  isRunInProgress,
  meaningfulTimelineEvents,
  mergeModelCallEvents,
  pendingImpactSummary,
  pendingInputFromEvents,
  renderMarkdown,
  renderModelCallInspector,
  runStatePresentation,
  summarizeEvents,
  visibleMessages,
} from '../src/app.js';

describe('One Agent Web helpers', () => {
  it('describes approval progress immediately after submission', () => {
    expect(approvalProgressLabel('approve', 'plan_approval')).toBe('已批准，正在执行…');
    expect(approvalProgressLabel('reject', 'plan_approval')).toBe('正在拒绝…');
    expect(approvalProgressLabel('revise this', 'plan_approval')).toBe('正在提交修改…');
    expect(approvalProgressLabel('details', 'clarification')).toBe('正在提交回答…');
  });

  it('summarizes approval impact and the unified run state', () => {
    const request = {
      kind: 'plan_approval',
      question: [
        '请确认计划：',
        '1. 检查架构 [read_file] [并行子 Agent]',
        '2. 检查安全 [read_file] [并行子 Agent]',
      ].join('\n'),
    };
    expect(pendingImpactSummary(request)).toEqual({
      copy: '2 个步骤 · 2 个子 Agent · 未发现写入工具',
      risk: '低风险',
      tone: 'low',
    });
    expect(runStatePresentation({
      busy: false,
      pending: { inputRequest: request },
      run: { status: 'waiting_for_input' },
      events: [],
    })).toMatchObject({
      hidden: false,
      tone: 'waiting',
      title: '等待你确认计划',
    });
  });

  it('recognizes background Run progress and pending input from Trace', () => {
    expect(isRunInProgress({ status: 'running' })).toBe(true);
    expect(isRunInProgress({ status: 'completed' })).toBe(false);
    expect(
      pendingInputFromEvents(
        { id: 'run-1', status: 'waiting_for_input' },
        [
          {
            eventData: {
              type: 'input_required',
              request: { kind: 'clarification', question: 'Which target?' },
            },
          },
        ],
      ),
    ).toEqual({
      runId: 'run-1',
      inputRequest: { kind: 'clarification', question: 'Which target?' },
    });
  });

  it('merges sub-agent lifecycle events into one visible row per agent', () => {
    expect(
      buildSubAgentItems([
        {
          createdAt: '2026-07-26T01:00:00.000Z',
          eventData: {
            type: 'sub_agent',
            status: 'started',
            stepId: '2.1',
            task: 'Inspect architecture',
          },
        },
        {
          createdAt: '2026-07-26T01:00:00.010Z',
          eventData: {
            type: 'sub_agent',
            status: 'started',
            stepId: '2.2',
            task: 'Inspect security',
          },
        },
        {
          createdAt: '2026-07-26T01:00:01.000Z',
          eventData: {
            type: 'sub_agent',
            status: 'completed',
            stepId: '2.1',
            task: 'Inspect architecture',
            reply: 'Architecture looks sound.',
            toolCallCount: 2,
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 'step-2.1',
        order: 1,
        status: 'completed',
        task: 'Inspect architecture',
        reply: 'Architecture looks sound.',
        toolCallCount: 2,
      }),
      expect.objectContaining({
        id: 'step-2.2',
        order: 2,
        status: 'started',
        task: 'Inspect security',
      }),
    ]);
  });

  it('escapes model-authored HTML before rendering Markdown', () => {
    const rendered = renderMarkdown('<img src=x onerror=alert(1)> **safe**');
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('&lt;img');
    expect(rendered).toContain('<strong>safe</strong>');
  });

  it('renders fenced code without executing embedded markup', () => {
    const rendered = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    expect(rendered).toContain('<pre><code');
    expect(rendered).toContain('data-copy-code');
    expect(rendered).toContain('<span>html</span>');
    expect(rendered).toContain('&lt;script&gt;');
    expect(rendered).not.toContain('<script>');
  });

  it('renders pipe tables as scrollable semantic tables', () => {
    const rendered = renderMarkdown([
      '| 功能 | 状态 |',
      '| --- | --- |',
      '| 执行抽屉 | **完成** |',
    ].join('\n'));
    expect(rendered).toContain('<div class="table-scroll">');
    expect(rendered).toContain('<table>');
    expect(rendered).toContain('<th>功能</th>');
    expect(rendered).toContain('<td><strong>完成</strong></td>');
  });

  it('escapes quotes and ampersands', () => {
    expect(escapeHtml(`Tom & "<Jerry>"`)).toBe('Tom &amp; &quot;&lt;Jerry&gt;&quot;');
  });

  it('keeps only user-visible conversation messages', () => {
    expect(visibleMessages([
      { role: 'user', content: 'Hi', internal: false },
      { role: 'assistant', content: 'Hello', internal: false },
      { role: 'assistant', content: 'internal', internal: true },
      { role: 'tool', content: 'result', internal: false },
    ])).toEqual([
      { role: 'user', content: 'Hi', internal: false },
      { role: 'assistant', content: 'Hello', internal: false },
    ]);
  });

  it('hides only the latest assistant message duplicated by a pending request', () => {
    const messages = [
      { role: 'user', content: 'Earlier' },
      { role: 'assistant', content: 'Earlier reply' },
      { role: 'user', content: 'Review it' },
      { role: 'assistant', content: 'Review the proposed plan:\n1. Inspect' },
    ];

    expect(
      conversationMessages(messages, 'Review the proposed plan: 1. Inspect'),
    ).toEqual(messages.slice(0, 3));
    expect(conversationMessages(messages, 'Different question')).toEqual(messages);
  });

  it('groups runs under the user dialogue that started them', () => {
    const turns = buildDialogueTurns([
      {
        id: 'message-1',
        role: 'user',
        content: '检查目录',
        createdAt: '2026-07-26T01:00:00.000Z',
      },
      {
        role: 'assistant',
        content: '目录正常',
        createdAt: '2026-07-26T01:00:02.000Z',
      },
      {
        id: 'message-2',
        role: 'user',
        content: '运行测试',
        createdAt: '2026-07-26T01:01:00.000Z',
      },
      {
        role: 'assistant',
        content: '测试通过',
        createdAt: '2026-07-26T01:01:05.000Z',
      },
    ], [
      { id: 'run-2', startTime: '2026-07-26T01:01:00.100Z' },
      { id: 'run-1', startTime: '2026-07-26T01:00:00.100Z' },
      { id: 'run-1-continued', startTime: '2026-07-26T01:00:03.000Z' },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].id).toBe('message-1');
    expect(turns[0].response.content).toBe('目录正常');
    expect(turns[0].runs.map((run) => run.id)).toEqual(['run-1', 'run-1-continued']);
    expect(turns[1].runs.map((run) => run.id)).toEqual(['run-2']);
  });

  it('counts tool calls and accepted sub-agent tasks', () => {
    expect(summarizeEvents([
      { type: 'tool_call' },
      { type: 'tool_result' },
      { type: 'sub_agent', status: 'started' },
      { type: 'sub_agent', status: 'completed' },
      { type: 'thought', content: 'direct' },
    ])).toEqual({ tools: 1, subAgents: 1, reasoning: 1 });
  });

  it('collects, merges, translates, and deduplicates reasoning trace events', () => {
    expect(extractReasoningItems([
      { eventData: { type: 'reasoning_delta', content: '先检查' } },
      { eventData: { type: 'reasoning_delta', content: '当前目录。' } },
      { type: 'thought', content: 'Auto planning decision: direct' },
      { type: 'thought', content: 'Auto planning decision: direct' },
      { type: 'plan', plan: { reasoning: '需要读取环境信息。' } },
      { type: 'reflection', content: '已得到工作目录。' },
    ])).toEqual([
      { kind: 'reasoning', label: '模型推理', content: '先检查当前目录。' },
      {
        kind: 'thought',
        label: '思考判断',
        content: '判定为直接执行：当前请求不需要先生成多步骤计划。',
      },
      { kind: 'plan', label: '规划依据', content: '需要读取环境信息。' },
      { kind: 'reflection', label: '执行复盘', content: '已得到工作目录。' },
    ]);
  });

  it('merges model-call start and completion snapshots into one timeline item', () => {
    expect(mergeModelCallEvents([
      {
        eventData: {
          type: 'model_call',
          phase: 'started',
          modelCallId: 'call-1',
          input: { messages: [{ role: 'user', content: 'hello' }] },
        },
      },
      { eventData: { type: 'thought', content: 'working' } },
      {
        eventData: {
          type: 'model_call',
          phase: 'completed',
          modelCallId: 'call-1',
          output: { content: 'world' },
        },
      },
    ])).toEqual([
      {
        eventData: {
          type: 'model_call',
          phase: 'completed',
          modelCallId: 'call-1',
          input: { messages: [{ role: 'user', content: 'hello' }] },
          output: { content: 'world' },
        },
      },
      { eventData: { type: 'thought', content: 'working' } },
    ]);
  });

  it('removes pending plan placeholders and keeps only meaningful latest progress', () => {
    const events = meaningfulTimelineEvents([
      {
        type: 'plan',
        plan: {
          steps: [
            { id: '1', description: '读取配置' },
            { id: '2', description: '检查安全' },
            { id: '3', description: '汇总结论' },
          ],
        },
      },
      { type: 'plan_step', stepId: '1', status: 'pending' },
      { type: 'plan_step', stepId: '2', status: 'pending' },
      { type: 'plan_step', stepId: '1', status: 'running' },
      { type: 'plan_step', stepId: '1', status: 'completed' },
      { type: 'plan_step', stepId: '2', status: 'running' },
      { type: 'sub_agent', stepId: '2', task: '检查安全', status: 'started' },
      {
        type: 'sub_agent',
        stepId: '2',
        task: '检查安全',
        status: 'completed',
        reply: '未发现高风险问题',
      },
      { type: 'plan_step', stepId: '3', status: 'pending' },
    ]);

    expect(events.filter((event) => event.type === 'plan_step')).toEqual([
      expect.objectContaining({
        stepId: '1',
        status: 'completed',
        description: '读取配置',
      }),
    ]);
    expect(events.filter((event) => event.type === 'sub_agent')).toEqual([
      expect.objectContaining({
        stepId: '2',
        status: 'completed',
        reply: '未发现高风险问题',
      }),
    ]);
  });

  it('escapes model-call input and output in the expandable inspector', () => {
    const rendered = renderModelCallInspector({
      input: { messages: [{ role: 'user', content: '<script>bad()</script>' }] },
      output: { content: '<img src=x>', toolCalls: [] },
    });
    expect(rendered).toContain('查看输入输出');
    expect(rendered).toContain('data-model-tab="input"');
    expect(rendered).toContain('data-model-panel="output" hidden');
    expect(rendered).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(rendered).toContain('&lt;img src=x&gt;');
    expect(rendered).not.toContain('<script>');
  });
});
