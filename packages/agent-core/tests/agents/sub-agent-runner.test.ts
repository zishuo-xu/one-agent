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
  readOnly: true,
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

    expect(result.executionStatus).toBe('completed');
    expect(result.outcomeStatus).toBe('unverified');
    expect(result.summary).toBe('subtask done');
    expect(result.evidencePacket).toMatchObject({
      conclusion: 'subtask done',
      evidence: [],
      unresolvedQuestions: [],
    });
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

  it('only inherits explicitly read-only tools when allowedTools is not set', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('read-only set') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    await runner.run({ task: 'anything' });

    const params = mockCreate.mock.calls[0][0] as { tools?: Array<{ function: { name: string } }> };
    const names = params.tools?.map((t) => t.function.name) ?? [];
    expect(names).toEqual(['read_file']);
    expect(names).not.toContain('write_file');
  });

  it('cannot opt a side-effecting tool in through allowedTools', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('no write access') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    await runner.run({ task: 'try to write', allowedTools: ['write_file'] });

    const params = mockCreate.mock.calls[0][0] as { tools?: Array<{ function: { name: string } }> };
    const names = params.tools?.map((t) => t.function.name) ?? [];
    expect(names).not.toContain('write_file');
  });

  it('builds an isolated context from task parts (no parent history)', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('ok') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry(), memoryText: 'likes tea' });
    await runner.run({
      task: 'brew',
      context: 'host a guest',
      constraints: ['do not add sugar'],
      expectedOutcome: 'tea is ready',
      expectedEvidence: ['tea temperature'],
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
    expect(params.messages[1].content).toContain('Constraints:\n- do not add sugar');
    expect(params.messages[1].content).toContain('Requested evidence:\n- tea temperature');
    expect(params.messages[1].content).toContain('likes tea');
  });

  it('uses the parent-selected memory snapshot for the current Run', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('ok') as never);

    const runner = new SubAgentRunner({ tools: makeRegistry(), memoryText: 'default memory' });
    runner.resetBudget();
    runner.setRunMemoryText('selected memory');
    await runner.run({ task: 'inspect context' });

    const params = mockCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(params.messages[1].content).toContain('selected memory');
    expect(params.messages[1].content).not.toContain('default memory');
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

    expect(result.executionStatus).toBe('completed');
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }]);
    expect(result.evidencePacket.evidence).toEqual([{
      toolCallId: 'c1',
      toolName: 'read_file',
      source: 'a.txt',
      observation: '{"content":"file-data"}',
    }]);
  });

  it('wraps sub-agent failure into a failed result instead of throwing', async () => {
    mockCreate.mockRejectedValue(new Error('model exploded'));

    const runner = new SubAgentRunner({ tools: makeRegistry() });
    const result = await runner.run({ task: 'doomed' });

    expect(result.executionStatus).toBe('failed');
    expect(result.outcomeStatus).toBe('unavailable');
    expect(result.error).toContain('model exploded');
    expect(result.summary).toBe('');
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

    expect(result.executionStatus).toBe('failed');
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

    expect(result.executionStatus).toBe('completed');
    expect(result.outcomeStatus).toBe('unverified');
    expect(result.summary).toBe('partial findings so far');
    expect(result.toolCalls).toHaveLength(2);
  });

  it('rejects further delegation after the per-Run task budget is exhausted', async () => {
    mockCreate.mockResolvedValue(textResponse('done') as never);
    const runner = new SubAgentRunner({
      tools: makeRegistry(),
      budget: { maxTasksPerRun: 1 },
    });

    const first = await runner.run({ task: 'first' });
    const second = await runner.run({ task: 'second' });

    expect(first.executionStatus).toBe('completed');
    expect(second.executionStatus).toBe('budget_exhausted');
    expect(second.error).toContain('maximum 1 tasks per Run');
    expect(mockCreate).toHaveBeenCalledTimes(1);

    runner.resetBudget();
    const nextRun = await runner.run({ task: 'new parent run' });
    expect(nextRun.executionStatus).toBe('completed');
  });

  it('stops accepting new work after observed token usage reaches the Run budget', async () => {
    mockCreate.mockResolvedValue(textResponse('done', {
      prompt_tokens: 6,
      completion_tokens: 4,
      total_tokens: 10,
    }) as never);
    const runner = new SubAgentRunner({
      tools: makeRegistry(),
      budget: { maxTotalTokens: 10 },
    });

    const first = await runner.run({ task: 'consume budget' });
    const second = await runner.run({ task: 'over budget' });

    expect(first.tokenUsage?.totalTokens).toBe(10);
    expect(second.executionStatus).toBe('budget_exhausted');
    expect(second.error).toContain('observed 10 tokens');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('queues excess work at the configured concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    mockCreate.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return textResponse('done') as never;
    });
    const runner = new SubAgentRunner({
      tools: makeRegistry(),
      budget: { maxConcurrency: 2 },
    });

    const pending = [
      runner.run({ task: 'one' }),
      runner.run({ task: 'two' }),
      runner.run({ task: 'three' }),
    ];
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    releases[0]();
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(3));
    releases[1]();
    releases[2]();

    const results = await Promise.all(pending);
    expect(results.every((result) => result.executionStatus === 'completed')).toBe(true);
    expect(maxActive).toBe(2);
  });

  it('aborts a sub-agent that exceeds its wall-clock execution timeout', async () => {
    mockCreate.mockImplementation((_params, options) => new Promise((_resolve, reject) => {
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) as never);
    const runner = new SubAgentRunner({
      tools: makeRegistry(),
      budget: { taskTimeoutMs: 20 },
    });

    const result = await runner.run({ task: 'never finishes' });

    expect(result.executionStatus).toBe('timed_out');
    expect(result.outcomeStatus).toBe('unavailable');
    expect(result.error).toContain('20ms execution timeout');
  });

  it('propagates parent Run cancellation into an active sub-agent', async () => {
    const controller = new AbortController();
    mockCreate.mockImplementation((_params, options) => new Promise((_resolve, reject) => {
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) as never);
    const runner = new SubAgentRunner({
      tools: makeRegistry(),
      signal: () => controller.signal,
    });

    const pending = runner.run({ task: 'cancel me' });
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    controller.abort(new Error('parent cancelled'));
    const result = await pending;

    expect(result.executionStatus).toBe('cancelled');
    expect(result.outcomeStatus).toBe('unavailable');
  });
});
