import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('../../src/config.js', async () => {
  const { OpenAICompatibleProvider } = await import('../../src/model/OpenAICompatibleProvider.js');
  const create = vi.fn();
  const openai = { chat: { completions: { create } } };
  return {
    config: {
      port: 3000,
      host: '127.0.0.1',
      model: 'default-model',
      systemPrompt: 'You are a test assistant.',
      openai,
      modelProvider: new OpenAICompatibleProvider(openai as never, 'default-model'),
      planningModelProvider: new OpenAICompatibleProvider(openai as never, 'planning-model'),
      utilityModelProvider: new OpenAICompatibleProvider(openai as never, 'utility-model'),
    },
  };
});

import { config } from '../../src/config.js';
import { Planner } from '../../src/planning/Planner.js';
import { TaskJudge } from '../../src/planning/TaskJudge.js';
import { MemoryExtractor } from '../../src/memory/MemoryExtractor.js';
import { ContextManager } from '../../src/context/ContextManager.js';
import { AgentLoop } from '../../src/agents/AgentLoop.js';
import { ToolRegistry } from '../../src/tools/registry.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

function lastCallModel(): string {
  const calls = mockCreate.mock.calls;
  return (calls[calls.length - 1][0] as { model: string }).model;
}

function callModel(index: number): string {
  return (mockCreate.mock.calls[index][0] as { model: string }).model;
}

function spawnAgentResponse() {
  return {
    choices: [{
      message: {
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'spawn_agent', arguments: '{"task":"sub job"}' } }],
      },
    }],
  };
}

function makeAgentTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo',
    parameters: z.object({ message: z.string() }),
    execute: (args: unknown) => args,
  });
  return registry;
}

describe('per-purpose model selection', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('Planner uses the planning model', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"reasoning":"r","steps":[]}' } }],
    } as never);

    await new Planner().createPlan('do something', []);

    expect(lastCallModel()).toBe('planning-model');
  });

  it('TaskJudge uses the planning model', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"complete":true,"reasoning":"r","nextAction":"finalize"}' } }],
    } as never);

    await new TaskJudge().judge({ reasoning: 'r', steps: [] }, []);

    expect(lastCallModel()).toBe('planning-model');
  });

  it('MemoryExtractor uses the utility model', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"memories":[]}' } }],
    } as never);

    await new MemoryExtractor().extract([{ id: 'm1', content: 'hi', createdAt: new Date().toISOString() }]);

    expect(lastCallModel()).toBe('utility-model');
  });

  it('ContextManager.summarize uses the utility model', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'summary' } }],
    } as never);

    const cm = new ContextManager({ systemPrompt: 'sys', maxContextTokens: 10, recentTokenBudget: 5 });
    // Three messages so the summarizable range [1, recentStart) is non-empty:
    // the last message forms the recent window, the first two get summarized.
    cm.addMessage({ role: 'user', content: 'a'.repeat(200) });
    cm.addMessage({ role: 'assistant', content: 'b'.repeat(200) });
    cm.addMessage({ role: 'user', content: 'c'.repeat(200) });

    await cm.buildContext();

    expect(lastCallModel()).toBe('utility-model');
  });

  it('an explicit modelProvider option always wins over purpose providers', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"memories":[]}' } }],
    } as never);

    const { OpenAICompatibleProvider } = await import('../../src/model/OpenAICompatibleProvider.js');
    const pinned = new OpenAICompatibleProvider(config.openai as never, 'pinned-model');
    await new MemoryExtractor({ modelProvider: pinned }).extract([
      { id: 'm1', content: 'hi', createdAt: new Date().toISOString() },
    ]);

    expect(lastCallModel()).toBe('pinned-model');
  });

  it('sub-agents default to the utility model while the parent stays on the main model', async () => {
    mockCreate
      // Parent decides to delegate.
      .mockResolvedValueOnce(spawnAgentResponse() as never)
      // Sub-agent answers.
      .mockResolvedValueOnce({ choices: [{ message: { content: 'sub done' } }] } as never)
      // Parent wraps up.
      .mockResolvedValueOnce({ choices: [{ message: { content: 'wrapped' } }] } as never);

    const agent = new AgentLoop({ tools: makeAgentTools() });
    await agent.chat('delegate something');

    expect(callModel(0)).toBe('default-model');
    expect(callModel(1)).toBe('utility-model');
    expect(callModel(2)).toBe('default-model');
  });

  it('an explicitly pinned provider propagates to sub-agents', async () => {
    mockCreate
      .mockResolvedValueOnce(spawnAgentResponse() as never)
      .mockResolvedValueOnce({ choices: [{ message: { content: 'sub done' } }] } as never)
      .mockResolvedValueOnce({ choices: [{ message: { content: 'wrapped' } }] } as never);

    const { OpenAICompatibleProvider } = await import('../../src/model/OpenAICompatibleProvider.js');
    const pinned = new OpenAICompatibleProvider(config.openai as never, 'pinned-model');
    const agent = new AgentLoop({ tools: makeAgentTools(), modelProvider: pinned });
    await agent.chat('delegate something');

    expect(callModel(0)).toBe('pinned-model');
    expect(callModel(1)).toBe('pinned-model');
  });
});
