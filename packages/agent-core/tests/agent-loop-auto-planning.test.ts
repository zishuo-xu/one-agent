import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../src/agents/AgentLoop.js';
import { AgentLoopEvent } from '../src/agents/AgentLoop.js';
import { TaskJudge } from '../src/planning/TaskJudge.js';
import { Planner } from '../src/planning/Planner.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolDefinition } from '../src/tools/types.js';
import { createConnection } from '../src/db/connection.js';
import { ThreadStore } from '../src/db/threadStore.js';
import { TraceEventStore } from '../src/db/traceEventStore.js';
import { z } from 'zod';

vi.mock('../src/config.js', () => ({
  config: {
    port: 3000,
    host: '127.0.0.1',
    model: 'gpt-test',
    systemPrompt: 'You are a test assistant.',
    openai: {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    },
  },
}));

import { config } from '../src/config.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo',
  parameters: z.object({ message: z.string() }),
  execute: (args: unknown) => args,
};

function makeTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(echoTool);
  return tools;
}

describe('AgentLoop auto planning', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('auto mode with a "direct" verdict skips planning and answers via the simple loop', async () => {
    mockCreate
      // 1st call: the planning classifier
      .mockResolvedValueOnce({ choices: [{ message: { content: 'direct' } }] } as never)
      // 2nd call: the actual answer
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Just a chat answer.' } }] } as never);

    const agent = new AgentLoop({ tools: makeTools(), enablePlanning: 'auto' });
    const events: AgentLoopEvent[] = [];
    agent.on('event', (event) => events.push(event));

    const { reply } = await agent.chat('hello, how are you?');

    expect(reply).toBe('Just a chat answer.');
    expect(events.some((e) => e.type === 'plan')).toBe(false);
    expect(events.some((e) => e.type === 'model_call' && e.purpose === 'classifier' && e.phase === 'started')).toBe(true);
    expect(events.some((e) => e.type === 'model_call' && e.purpose === 'classifier' && e.phase === 'completed')).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // The first call is the classifier with the plan/direct prompt.
    const classifierParams = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(classifierParams.messages[0].content).toContain('"plan" or "direct"');
  });

  it('auto mode with a "plan" verdict runs the planning loop', async () => {
    const planner = new Planner();
    const createPlan = vi.spyOn(planner, 'createPlan').mockResolvedValue({
      steps: [],
      reasoning: 'noop',
    } as never);
    const taskJudge = new TaskJudge();
    vi.spyOn(taskJudge, 'judge').mockResolvedValue({
      complete: true,
      reasoning: 'done',
      nextAction: 'finalize',
    } as never);

    mockCreate
      // 1st call: classifier says plan
      .mockResolvedValueOnce({ choices: [{ message: { content: 'plan' } }] } as never)
      // 2nd call: finalize answer
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Planned answer.' } }] } as never);

    const agent = new AgentLoop({ tools: makeTools(), enablePlanning: 'auto', planner, taskJudge });
    const events: AgentLoopEvent[] = [];
    agent.on('event', (event) => events.push(event));

    const { reply } = await agent.chat('do something complex');

    expect(reply).toBe('Planned answer.');
    expect(createPlan).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'plan')).toBe(true);
  });

  it('upgrades a direct verdict to planning before a multi-tool batch executes', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'adaptive-strategy-thread' }).id;
    const execute = vi.fn((args: unknown) => args);
    const tools = new ToolRegistry();
    tools.register({ ...echoTool, execute });
    const planner = new Planner();
    const createPlan = vi.spyOn(planner, 'createPlan').mockResolvedValue({
      steps: [],
      reasoning: 'The runtime detected multi-tool coordination.',
    } as never);

    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: 'direct' } }] } as never)
      .mockResolvedValueOnce({ choices: [{ message: {
        content: '',
        tool_calls: [
          { id: 'call-1', function: { name: 'echo', arguments: '{"message":"one"}' } },
          { id: 'call-2', function: { name: 'echo', arguments: '{"message":"two"}' } },
        ],
      } }] } as never)
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Planned after runtime escalation.' } }] } as never);

    const agent = new AgentLoop({ threadId, db, tools, enablePlanning: 'auto', planner });
    const result = await agent.chat('Handle both operations');

    expect(result.reply).toBe('Planned after runtime escalation.');
    expect(execute).not.toHaveBeenCalled();
    expect(createPlan).toHaveBeenCalledTimes(1);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'strategy_switch',
        from: 'simple',
        to: 'planning',
        trigger: expect.objectContaining({
          phase: 'before_tool_execution',
          toolCallNames: ['echo', 'echo'],
          switchCount: 1,
        }),
      }),
    ]));
    const persistedSwitch = new TraceEventStore(db)
      .getByRun(result.runId!)
      .find((event) => event.eventType === 'strategy_switch');
    expect(persistedSwitch?.eventData).toMatchObject({
      type: 'strategy_switch',
      from: 'simple',
      to: 'planning',
    });
    db.close();
  });

  it('auto mode defaults to planning when the classifier call fails', async () => {
    const planner = new Planner();
    const createPlan = vi.spyOn(planner, 'createPlan').mockResolvedValue({
      steps: [],
      reasoning: 'noop',
    } as never);
    const taskJudge = new TaskJudge();
    vi.spyOn(taskJudge, 'judge').mockResolvedValue({
      complete: true,
      reasoning: 'done',
      nextAction: 'finalize',
    } as never);

    mockCreate
      .mockRejectedValueOnce(new Error('classifier endpoint down'))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Fallback planned answer.' } }] } as never);

    const agent = new AgentLoop({ tools: makeTools(), enablePlanning: 'auto', planner, taskJudge });

    const { reply, events } = await agent.chat('anything');

    expect(reply).toBe('Fallback planned answer.');
    expect(createPlan).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'model_call' && e.purpose === 'classifier' && e.phase === 'failed')).toBe(true);
  });

  it('enablePlanning=true never calls the classifier', async () => {
    const planner = new Planner();
    const createPlan = vi.spyOn(planner, 'createPlan').mockResolvedValue({
      steps: [],
      reasoning: 'noop',
    } as never);
    const taskJudge = new TaskJudge();
    vi.spyOn(taskJudge, 'judge').mockResolvedValue({
      complete: true,
      reasoning: 'done',
      nextAction: 'finalize',
    } as never);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Always planning.' } }] } as never);

    const agent = new AgentLoop({ tools: makeTools(), enablePlanning: true, planner, taskJudge });

    const { reply } = await agent.chat('hi');

    expect(reply).toBe('Always planning.');
    expect(createPlan).toHaveBeenCalledTimes(1);
    // Only ONE model call (the final answer): no classifier round-trip.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
