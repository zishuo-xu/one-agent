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
});
