import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('../../src/config.js', () => ({
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

import { config } from '../../src/config.js';
import { AgentLoop, AgentLoopEvent } from '../../src/agents/AgentLoop.js';
import { ContextManager } from '../../src/context/ContextManager.js';
import { Planner } from '../../src/planning/Planner.js';
import { TaskJudge } from '../../src/planning/TaskJudge.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolDefinition } from '../../src/tools/types.js';
import type { Plan } from '../../src/planning/types.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

const READ_ONLY_NAMES = ['read_file', 'list_files', 'search_files', 'web_search', 'get_time'];

function makeTools(): ToolRegistry {
  const registry = new ToolRegistry();
  const defs: ToolDefinition[] = [
    ...READ_ONLY_NAMES.map((name) => ({
      name,
      description: `${name} tool`,
      parameters: z.object({}),
      execute: () => ({ ok: true }),
    })),
    {
      name: 'write_file',
      description: 'write tool',
      parameters: z.object({}),
      execute: () => ({ ok: true }),
    },
  ];
  registry.registerMany(defs);
  return registry;
}

function textResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

function toolNamesOf(call: unknown): string[] {
  const params = (call as unknown[])[0] as { tools?: Array<{ function: { name: string } }> };
  return params.tools?.map((t) => t.function.name) ?? [];
}

function promptOf(call: unknown): string {
  const params = (call as unknown[])[0] as { messages: unknown };
  return JSON.stringify(params.messages);
}

function makeAgent(plan: Plan) {
  const planner = new Planner();
  vi.spyOn(planner, 'createPlan').mockResolvedValue(plan);
  const taskJudge = new TaskJudge();
  // executeStep consults the judge after EVERY step, so only finalize once
  // every step has reached a terminal state; otherwise keep going.
  const judge = vi.spyOn(taskJudge, 'judge').mockImplementation(async (planArg: Plan) => {
    const allDone = planArg.steps.every((s) => s.status === 'completed' || s.status === 'failed');
    return allDone
      ? { complete: true, reasoning: 'done', nextAction: 'finalize' }
      : { complete: false, reasoning: 'keep going', nextAction: 'continue' };
  });
  const agent = new AgentLoop({ tools: makeTools(), enablePlanning: true, planner, taskJudge });
  const events: AgentLoopEvent[] = [];
  agent.on('event', (e) => events.push(e));
  return { agent, events, judge };
}

describe('delegated plan steps', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('runs consecutive delegate+parallel steps as a read-only wave, serial delegate with full tools', async () => {
    const plan: Plan = {
      reasoning: 'mixed plan',
      steps: [
        { id: '1', description: 'normal step one', status: 'pending' },
        { id: '2', description: 'parallel research alpha', status: 'pending', delegate: true, parallel: true },
        { id: '3', description: 'parallel research beta', status: 'pending', delegate: true, parallel: true },
        { id: '4', description: 'serial delegated write step', status: 'pending', delegate: true },
        { id: '5', description: 'normal step five', status: 'pending' },
      ],
    };
    const { agent, events } = makeAgent(plan);

    mockCreate.mockImplementation(async (params: unknown) => {
      const text = JSON.stringify((params as { messages: unknown }).messages);
      // Route on the sub-agent prompt marker ("Your sub-task: ...") so the
      // parent's later calls (which quote task descriptions in their context)
      // are not misrouted.
      if (text.includes('Your sub-task: parallel research alpha')) return textResponse('alpha result');
      if (text.includes('Your sub-task: parallel research beta')) return textResponse('beta result');
      if (text.includes('Your sub-task: serial delegated write step')) return textResponse('write result');
      return textResponse('step output');
    });

    const { reply } = await agent.chat('run the mixed plan');

    expect(reply).toBeTruthy();
    expect(plan.steps.every((s) => s.status === 'completed')).toBe(true);

    // 3 delegated executions total: wave of 2 + 1 serial.
    const started = events.filter((e) => e.type === 'sub_agent' && e.status === 'started');
    expect(started).toHaveLength(3);

    // Parallel sub-agents received read-only schemas; serial received full set.
    const subCalls = mockCreate.mock.calls.filter((call) => {
      const prompt = promptOf(call);
      return (
        prompt.includes('Your sub-task: parallel research') ||
        prompt.includes('Your sub-task: serial delegated write step')
      );
    });
    expect(subCalls).toHaveLength(3);
    for (const call of subCalls) {
      const prompt = promptOf(call);
      const names = toolNamesOf(call);
      if (prompt.includes('Your sub-task: parallel research')) {
        expect(names.length).toBeGreaterThan(0);
        expect(names.every((n) => READ_ONLY_NAMES.includes(n))).toBe(true);
      } else {
        expect(names).toContain('write_file');
      }
    }
  });

  it('marks a failed wave step, consults the judge once, and still finalizes', async () => {
    const plan: Plan = {
      reasoning: 'wave with failure',
      steps: [
        { id: '1', description: 'parallel good task', status: 'pending', delegate: true, parallel: true },
        { id: '2', description: 'parallel doomed task', status: 'pending', delegate: true, parallel: true },
      ],
    };
    const { agent, events, judge } = makeAgent(plan);

    mockCreate.mockImplementation(async (params: unknown) => {
      const text = JSON.stringify((params as { messages: unknown }).messages);
      if (text.includes('Your sub-task: parallel doomed task')) {
        throw new Error('sub model exploded');
      }
      if (text.includes('Your sub-task: parallel good task')) return textResponse('good result');
      return textResponse('final answer');
    });

    const { reply } = await agent.chat('run the wave');

    expect(reply).toBe('final answer');
    expect(plan.steps[0].status).toBe('completed');
    expect(plan.steps[1].status).toBe('failed');
    // The wave consulted the judge exactly once for the failure.
    expect(judge).toHaveBeenCalledTimes(1);
    const failedEvents = events.filter((e) => e.type === 'sub_agent' && e.status === 'failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('wave retry re-executes only the failed step, never the completed ones', async () => {
    const plan: Plan = {
      reasoning: 'wave retry',
      steps: [
        { id: '1', description: 'parallel good task', status: 'pending', delegate: true, parallel: true },
        { id: '2', description: 'parallel flaky task', status: 'pending', delegate: true, parallel: true },
      ],
    };

    const planner = new Planner();
    vi.spyOn(planner, 'createPlan').mockResolvedValue(plan);
    const taskJudge = new TaskJudge();
    let judgeCalls = 0;
    vi.spyOn(taskJudge, 'judge').mockImplementation(async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? { complete: false, reasoning: 'retry the failed one', nextAction: 'retry' }
        : { complete: true, reasoning: 'all done', nextAction: 'finalize' };
    });
    const agent = new AgentLoop({ tools: makeTools(), enablePlanning: true, planner, taskJudge });

    let goodCalls = 0;
    let flakyCalls = 0;
    mockCreate.mockImplementation(async (params: unknown) => {
      const text = JSON.stringify((params as { messages: unknown }).messages);
      if (text.includes('Your sub-task: parallel good task')) {
        goodCalls++;
        return textResponse('good result');
      }
      if (text.includes('Your sub-task: parallel flaky task')) {
        flakyCalls++;
        // Exhaust the sub-agent's model retries (maxRetries=2 → 3 attempts)
        // so wave 1 marks the step failed; wave 2's retry succeeds.
        if (flakyCalls <= 3) throw new Error('flaky down');
        return textResponse('flaky recovered');
      }
      return textResponse('final answer');
    });

    const { reply } = await agent.chat('run the wave');

    expect(reply).toBe('final answer');
    expect(plan.steps[0].status).toBe('completed');
    expect(plan.steps[1].status).toBe('completed');
    // The completed step must NOT re-run on wave retry...
    expect(goodCalls).toBe(1);
    // ...while the flaky step ran in wave 1 (3 failed attempts) and wave 2 (1 success).
    expect(flakyCalls).toBe(4);
  });

  it('sub-agent usage rolls into totals without anchoring the parent context size', async () => {
    const plan: Plan = {
      reasoning: 'delegated usage',
      steps: [
        { id: '1', description: 'parallel research task', status: 'pending', delegate: true, parallel: true },
      ],
    };

    const planner = new Planner();
    vi.spyOn(planner, 'createPlan').mockResolvedValue(plan);
    const taskJudge = new TaskJudge();
    vi.spyOn(taskJudge, 'judge').mockResolvedValue({
      complete: true,
      reasoning: 'done',
      nextAction: 'finalize',
    });

    const contextManager = new ContextManager({ systemPrompt: 'test' });
    const tokenSpy = vi.spyOn(contextManager, 'updateLastKnownTokens');
    const agent = new AgentLoop({ tools: makeTools(), enablePlanning: true, planner, taskJudge, contextManager });

    mockCreate.mockImplementation(async (params: unknown) => {
      const text = JSON.stringify((params as { messages: unknown }).messages);
      if (text.includes('Your sub-task: parallel research task')) {
        return {
          choices: [{ message: { content: 'sub result' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        };
      }
      return {
        choices: [{ message: { content: 'final answer' } }],
        usage: { prompt_tokens: 5000, completion_tokens: 20, total_tokens: 5020 },
      };
    });

    const { reply } = await agent.chat('run the delegated plan');

    expect(reply).toBe('final answer');
    // The parent's own calls still anchor the context-size estimate...
    expect(tokenSpy).toHaveBeenCalledWith(5000);
    // ...but the sub-agent's much smaller prompt must never become the anchor.
    for (const call of tokenSpy.mock.calls) {
      expect(call[0]).not.toBe(50);
    }
  });
});
