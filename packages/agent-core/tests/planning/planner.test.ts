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
import { Planner } from '../../src/planning/Planner.js';
import { ToolDefinition } from '../../src/tools/types.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

const dummyTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo',
  parameters: z.object({ message: z.string() }),
  execute: () => ({}),
};

describe('Planner', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('parses JSON plan from model response', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reasoning: 'Need to read then write',
              steps: [
                { id: '1', description: 'Read file', toolName: 'read_file', expectedOutcome: 'content' },
                { id: '2', description: 'Write summary', toolName: 'write_file', expectedOutcome: 'file created' },
              ],
            }),
          },
        },
      ],
    } as never);

    const planner = new Planner();
    const plan = await planner.createPlan('Summarize notes', [dummyTool]);

    expect(plan.reasoning).toBe('Need to read then write');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].description).toBe('Read file');
    expect(plan.steps[0].status).toBe('pending');
  });

  it('falls back to single-step plan when model returns invalid JSON', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    } as never);

    const planner = new Planner();
    const plan = await planner.createPlan('Say hi', [dummyTool]);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toContain('Say hi');
  });

  it('falls back when model call fails', async () => {
    mockCreate.mockRejectedValue(new Error('Network error') as never);

    const planner = new Planner();
    const plan = await planner.createPlan('Do something', [dummyTool]);

    expect(plan.steps).toHaveLength(1);
  });

  it('parses JSON wrapped in markdown fences', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: '```json\n' +
              JSON.stringify({
                reasoning: 'Read then write',
                steps: [{ id: '1', description: 'Read file', toolName: 'read_file' }],
              }) +
              '\n```',
          },
        },
      ],
    } as never);

    const planner = new Planner();
    const plan = await planner.createPlan('Summarize notes', [dummyTool]);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toBe('Read file');
  });

  it('extracts JSON object from explanatory prefix', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              'Here is the plan in JSON format:\n' +
              JSON.stringify({
                reasoning: 'Direct answer',
                steps: [{ id: '1', description: 'Reply to the user' }],
              }),
          },
        },
      ],
    } as never);

    const planner = new Planner();
    const plan = await planner.createPlan('Say hi', [dummyTool]);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toBe('Reply to the user');
  });

  it('falls back when response_format is unsupported and response is still invalid', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('Unsupported response_format') as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'not json' } }],
      } as never);

    const planner = new Planner();
    const plan = await planner.createPlan('Say hi', [dummyTool]);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toContain('Say hi');
  });

  it('parses hierarchical plan with nested children', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reasoning: 'Research topic and summarize',
              steps: [
                {
                  id: '1',
                  description: 'Research topic',
                  expectedOutcome: 'Gather information',
                  children: [
                    { id: '1.1', description: 'Search web', toolName: 'echo', expectedOutcome: 'Search results' },
                    { id: '1.2', description: 'Read results', toolName: 'echo', expectedOutcome: 'Key points' },
                  ],
                },
                { id: '2', description: 'Write summary', toolName: 'echo', expectedOutcome: 'Summary file' },
              ],
            }),
          },
        },
      ],
    } as never);

    const planner = new Planner();
    const plan = await planner.createPlan('Research and summarize AI', [dummyTool]);

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].children).toHaveLength(2);
    expect(plan.steps[0].children?.[0].parentId).toBe('1');
    expect(plan.steps[0].children?.[1].parentId).toBe('1');
    expect(plan.steps[0].children?.[0].status).toBe('pending');
    expect(plan.steps[1].parentId).toBeUndefined();
  });
});
