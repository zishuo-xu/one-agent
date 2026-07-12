import { describe, it, expect, vi } from 'vitest';

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
import { TaskJudge } from '../../src/planning/TaskJudge.js';
import { Plan } from '../../src/planning/types.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

const samplePlan: Plan = {
  reasoning: 'Test plan',
  steps: [
    { id: '1', description: 'Read file', status: 'completed' },
    { id: '2', description: 'Write summary', status: 'pending' },
  ],
};

describe('TaskJudge', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns parsed judge result', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              complete: true,
              reasoning: 'All steps done',
              nextAction: 'finalize',
            }),
          },
        },
      ],
    } as never);

    const judge = new TaskJudge();
    const result = await judge.judge(samplePlan, []);

    expect(result.complete).toBe(true);
    expect(result.nextAction).toBe('finalize');
  });

  it('limits replan attempts', async () => {
    const judge = new TaskJudge();
    expect(judge.canReplan()).toBe(true);
    judge.recordReplan();
    judge.recordReplan();
    judge.recordReplan();
    expect(judge.canReplan()).toBe(false);
  });

  it('limits retry attempts', async () => {
    const judge = new TaskJudge({ maxRetryAttempts: 1 });
    expect(judge.canRetry()).toBe(true);
    judge.recordRetry();
    expect(judge.canRetry()).toBe(false);
  });

  it('falls back on model error', async () => {
    mockCreate.mockRejectedValue(new Error('Network error') as never);

    const judge = new TaskJudge();
    const result = await judge.judge(samplePlan, []);

    expect(result.complete).toBe(false);
    expect(result.nextAction).toBe('continue');
  });
});
