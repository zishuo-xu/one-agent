import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../src/agents/AgentLoop.js';
import { AgentLoopEvent } from '../../src/agents/AgentLoop.js';
import { TaskJudge } from '../../src/planning/TaskJudge.js';
import { Planner } from '../../src/planning/Planner.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolDefinition } from '../../src/tools/types.js';
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

const mockCreate = vi.mocked(config.openai.chat.completions.create);

describe('AgentLoop streaming', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('emits events via EventEmitter', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello' } }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const events: AgentLoopEvent[] = [];
    agent.on('event', (event) => events.push(event));

    const { reply } = await agent.chat('Hi');
    expect(reply).toBe('Hello');
    expect(events.some((e) => e.type === 'message_delta')).toBe(true);
    expect(events.some((e) => e.type === 'message')).toBe(true);
  });

  it('streams message deltas in finalize answer', async () => {
    const planner = new Planner();
    vi.spyOn(planner, 'createPlan').mockResolvedValue({
      steps: [],
      reasoning: 'noop',
    } as never);

    const taskJudge = new TaskJudge();
    vi.spyOn(taskJudge, 'judge').mockResolvedValue({
      complete: true,
      reasoning: 'done',
      nextAction: 'finalize',
    } as never);

    mockCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'Hel' } }] };
        yield { choices: [{ delta: { content: 'lo' } }] };
      },
    } as never);

    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'Echo',
      parameters: z.object({ message: z.string() }),
      execute: (args: unknown) => args,
    };
    const tools = new ToolRegistry();
    tools.register(echoTool);

    const agent = new AgentLoop({ tools, planner, taskJudge, enablePlanning: true });
    const deltas: string[] = [];
    agent.on('event', (event) => {
      if (event.type === 'message_delta') {
        deltas.push(event.content);
      }
    });

    await agent.chat('Hi');
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('respects AbortSignal', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello' } }],
    } as never);

    const controller = new AbortController();
    const agent = new AgentLoop({ enablePlanning: false, signal: controller.signal });
    controller.abort();

    await expect(agent.chat('Hi')).rejects.toThrow('cancelled');
  });
});
