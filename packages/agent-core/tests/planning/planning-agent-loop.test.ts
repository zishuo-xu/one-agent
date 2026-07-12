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
});
