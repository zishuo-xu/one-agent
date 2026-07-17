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
import { SubAgentRunner } from '../../src/agents/SubAgentRunner.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolDefinition } from '../../src/tools/types.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

const readTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: z.object({ path: z.string() }),
  execute: () => ({ content: 'file-data' }),
};

const writeTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write a file',
  parameters: z.object({ path: z.string(), content: z.string() }),
  execute: () => ({ ok: true }),
};

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany([readTool, writeTool]);
  return registry;
}

function textResponse(content: string, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return { choices: [{ message: { content } }], usage };
}

describe('SubAgentRunner', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('runs a subtask and returns the reply with usage', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('subtask done') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    const result = await runner.run({ task: 'do the thing' });

    expect(result.success).toBe(true);
    expect(result.reply).toBe('subtask done');
    expect(result.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('restricts the sub-agent to allowedTools', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('read only') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    await runner.run({ task: 'read stuff', allowedTools: ['read_file'] });

    const params = mockCreate.mock.calls[0][0] as { tools?: Array<{ function: { name: string } }> };
    const names = params.tools?.map((t) => t.function.name) ?? [];
    expect(names).toEqual(['read_file']);
    expect(names).not.toContain('write_file');
  });

  it('gives all inherited tools when allowedTools is not set', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('full set') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    await runner.run({ task: 'anything' });

    const params = mockCreate.mock.calls[0][0] as { tools?: Array<{ function: { name: string } }> };
    const names = params.tools?.map((t) => t.function.name) ?? [];
    expect(names.sort()).toEqual(['read_file', 'write_file']);
  });

  it('builds an isolated context from task parts (no parent history)', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('ok') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry(), memoryText: 'likes tea' });
    await runner.run({
      task: 'brew',
      context: 'host a guest',
      expectedOutcome: 'tea is ready',
    });

    const params = mockCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    // Exactly two messages: the sub-agent system prompt and the crafted task.
    expect(params.messages).toHaveLength(2);
    expect(params.messages[0].content).toContain('sub-task execution agent');
    expect(params.messages[1].content).toContain('Overall goal: host a guest');
    expect(params.messages[1].content).toContain('Your sub-task: brew');
    expect(params.messages[1].content).toContain('Expected outcome: tea is ready');
    expect(params.messages[1].content).toContain('likes tea');
  });

  it('collects the tool calls the sub-agent made', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
        }],
      } as never)
      .mockResolvedValueOnce(textResponse('found it') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    const result = await runner.run({ task: 'find something' });

    expect(result.success).toBe(true);
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }]);
  });

  it('wraps sub-agent failure into a failed result instead of throwing', async () => {
    mockCreate.mockRejectedValue(new Error('model exploded'));

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    const result = await runner.run({ task: 'doomed' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('model exploded');
    expect(result.reply).toBe('');
  });

  it('returns the condensed internal event stream (tool calls, message; no deltas)', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
        }],
      } as never)
      .mockResolvedValueOnce(textResponse('found it') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    const result = await runner.run({ task: 'find something' });

    const types = result.events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('message');
    expect(types).not.toContain('message_delta');
    expect(types).not.toContain('reasoning_delta');
  });

  it('still returns the partial event stream when the sub-agent fails mid-run', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
        }],
      } as never);
    // Persistent: exhausts the sub-agent's retries (maxRetries=2 → 3 attempts).
    mockCreate.mockRejectedValue(new Error('model exploded'));

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    const result = await runner.run({ task: 'doomed' });

    expect(result.success).toBe(false);
    const types = result.events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
  });

  it('returns partial findings via a wrap-up call when the tool budget is exhausted', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
        }],
      } as never)
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } }],
          },
        }],
      } as never)
      // The tool-free wrap-up call converts the partial work into a summary.
      .mockResolvedValueOnce(textResponse('partial findings so far') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry(), maxToolIterations: 1 });
    const result = await runner.run({ task: 'long investigation' });

    expect(result.success).toBe(true);
    expect(result.reply).toBe('partial findings so far');
    expect(result.toolCalls).toHaveLength(2);
  });
});
