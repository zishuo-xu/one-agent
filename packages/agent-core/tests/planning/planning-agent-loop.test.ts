import { describe, it, expect, vi } from 'vitest';
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
import { AgentLoop } from '../../src/agents/AgentLoop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolDefinition } from '../../src/tools/types.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo the input',
  parameters: z.object({ message: z.string() }),
  execute: (args: unknown) => {
    const { message } = args as { message: string };
    return { message };
  },
};

function createPlanResponse(steps: { id: string; description: string; toolName?: string }[]) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            reasoning: 'Plan to test',
            steps: steps.map((s) => ({
              id: s.id,
              description: s.description,
              toolName: s.toolName,
              expectedOutcome: 'done',
            })),
          }),
        },
      },
    ],
  };
}

function createJudgeResult(complete: boolean, nextAction: string) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            complete,
            reasoning: 'Judge reasoning',
            nextAction,
          }),
        },
      },
    ],
  };
}

describe('AgentLoop with planning', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('generates plan and executes single step', async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);

    mockCreate
      .mockResolvedValueOnce(createPlanResponse([{ id: '1', description: 'Echo hello', toolName: 'echo' }]) as never)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I will call echo.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'echo',
                    arguments: JSON.stringify({ message: 'hello' }),
                  },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(true, 'finalize') as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Done: hello' } }],
      } as never);

    const agent = new AgentLoop({ tools });
    const { reply, events } = await agent.chat('Please echo hello');

    expect(reply).toBe('Done: hello');
    expect(events.some((e) => e.type === 'plan')).toBe(true);
    expect(events.some((e) => e.type === 'thought')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('falls back to single-step plan when planner returns invalid JSON', async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);

    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'not valid json' } }],
      } as never)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'echo',
                    arguments: JSON.stringify({ message: 'fallback' }),
                  },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(true, 'finalize') as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Fallback done' } }],
      } as never);

    const agent = new AgentLoop({ tools });
    const { reply } = await agent.chat('Fallback test');

    expect(reply).toBe('Fallback done');
  });

  it('retries failed step and then completes', async () => {
    const failOnceTool: ToolDefinition = {
      name: 'fail_once',
      description: 'Fails first time, succeeds second',
      parameters: z.object({}),
      execute: (() => {
        let called = false;
        return () => {
          if (!called) {
            called = true;
            throw new Error('First failure');
          }
          return { success: true };
        };
      })(),
    };

    const tools = new ToolRegistry();
    tools.register(failOnceTool);

    mockCreate
      .mockResolvedValueOnce(createPlanResponse([{ id: '1', description: 'Call fail_once', toolName: 'fail_once' }]) as never)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I will call fail_once.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'fail_once', arguments: '{}' },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(false, 'retry') as never)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'Retrying.',
              tool_calls: [
                {
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'fail_once', arguments: '{}' },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(true, 'finalize') as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Retry succeeded' } }],
      } as never);

    const agent = new AgentLoop({ tools, maxRetryAttempts: 2 });
    const { reply } = await agent.chat('Retry test');

    expect(reply).toBe('Retry succeeded');
  });

  it('executes multi-step plan successfully', async () => {
    const fetchTool: ToolDefinition = {
      name: 'fetch_data',
      description: 'Fetch data',
      parameters: z.object({ source: z.string() }),
      execute: (args: unknown) => {
        const { source } = args as { source: string };
        return { source, data: `data from ${source}` };
      },
    };

    const tools = new ToolRegistry();
    tools.register(fetchTool);

    mockCreate
      .mockResolvedValueOnce(
        createPlanResponse([
          { id: '1', description: 'Fetch data from A', toolName: 'fetch_data' },
          { id: '2', description: 'Fetch data from B', toolName: 'fetch_data' },
          { id: '3', description: 'Combine results', toolName: 'fetch_data' },
        ]) as never
      )
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'Fetching A.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'fetch_data', arguments: JSON.stringify({ source: 'A' }) },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(false, 'continue') as never)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'Fetching B.',
              tool_calls: [
                {
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'fetch_data', arguments: JSON.stringify({ source: 'B' }) },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(false, 'continue') as never)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'Combining.',
              tool_calls: [
                {
                  id: 'call_3',
                  type: 'function',
                  function: { name: 'fetch_data', arguments: JSON.stringify({ source: 'combined' }) },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(true, 'finalize') as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Combined A and B' } }],
      } as never);

    const agent = new AgentLoop({ tools });
    const { reply, events } = await agent.chat('Fetch and combine data');

    expect(reply).toBe('Combined A and B');
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'thought')).toHaveLength(3);
  });

  it('replans when a step fails and cannot be retried', async () => {
    const alwaysFailTool: ToolDefinition = {
      name: 'always_fail',
      description: 'Always fails',
      parameters: z.object({}),
      execute: () => {
        throw new Error('Always fails');
      },
    };

    const tools = new ToolRegistry();
    tools.register(alwaysFailTool);

    mockCreate
      .mockResolvedValueOnce(
        createPlanResponse([{ id: '1', description: 'Call always_fail', toolName: 'always_fail' }]) as never
      )
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I will call always_fail.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'always_fail', arguments: '{}' },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(false, 'replan') as never)
      .mockResolvedValueOnce(
        createPlanResponse([{ id: '1', description: 'Skip failing step and finalize' }]) as never
      )
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'I will skip and finalize.' } }],
      } as never)
      .mockResolvedValueOnce(createJudgeResult(true, 'finalize') as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Skipped failing step' } }],
      } as never);

    const agent = new AgentLoop({ tools, maxReplanAttempts: 2 });
    const { reply, events } = await agent.chat('Replan test');

    expect(reply).toBe('Skipped failing step');
    expect(events.filter((e) => e.type === 'plan')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'reflection')).toHaveLength(1);
  });
});
