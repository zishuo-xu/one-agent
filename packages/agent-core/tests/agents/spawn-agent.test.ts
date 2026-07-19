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
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolDefinition } from '../../src/tools/types.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

const echoTool: ToolDefinition = {
  name: 'echo',
  readOnly: true,
  description: 'Echo',
  parameters: z.object({ message: z.string() }),
  execute: (args: unknown) => args,
};

function makeTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return registry;
}

function toolCallResponse(name: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

function textResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return { choices: [{ message: { content } }], ...(usage ? { usage } : {}) };
}

describe('AgentLoop spawn_agent', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('registers spawn_agent into the agent tool schemas by default', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('hi') as never);

    const agent = new AgentLoop({ tools: makeTools() });
    await agent.chat('hello');

    const params = mockCreate.mock.calls[0][0] as { tools?: Array<{ function: { name: string } }> };
    const names = params.tools?.map((t) => t.function.name) ?? [];
    expect(names).toContain('spawn_agent');
    expect(names).toContain('echo');
  });

  it('omits spawn_agent when subAgents is false', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('hi') as never);

    const agent = new AgentLoop({ tools: makeTools(), subAgents: false });
    await agent.chat('hello');

    const params = mockCreate.mock.calls[0][0] as { tools?: Array<{ function: { name: string } }> };
    const names = params.tools?.map((t) => t.function.name) ?? [];
    expect(names).not.toContain('spawn_agent');
  });

  it('delegates a subtask, returns its result, and emits sub_agent events', async () => {
    mockCreate
      // Parent decides to delegate.
      .mockResolvedValueOnce(toolCallResponse('spawn_agent', { task: 'research cats' }) as never)
      // Sub-agent answers.
      .mockResolvedValueOnce(textResponse('cats are great', { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }) as never)
      // Parent wraps up.
      .mockResolvedValueOnce(textResponse('The sub-agent found: cats are great') as never);

    const agent = new AgentLoop({ tools: makeTools() });
    const events: AgentLoopEvent[] = [];
    agent.on('event', (e) => events.push(e));

    const { reply, tokenUsage } = await agent.chat('find out about cats');

    expect(reply).toContain('cats are great');

    const subEvents = events.filter((e) => e.type === 'sub_agent');
    expect(subEvents.map((e) => e.type === 'sub_agent' && e.status)).toEqual(['started', 'completed']);
    const completed = subEvents[1];
    expect(completed.type === 'sub_agent' && completed.reply).toBe('cats are great');
    expect(completed.type === 'sub_agent' && completed.outcomeStatus).toBe('unverified');

    // Sub-agent usage rolled up into the parent's accounting.
    expect(tokenUsage?.totalTokens).toBe(30);
  });

  it('attaches the sub-agent internal event stream to the completed event', async () => {
    mockCreate
      // Parent decides to delegate.
      .mockResolvedValueOnce(toolCallResponse('spawn_agent', { task: 'echo something' }) as never)
      // Sub-agent makes a tool call, then answers.
      .mockResolvedValueOnce(toolCallResponse('echo', { message: 'hi' }) as never)
      .mockResolvedValueOnce(textResponse('echoed hi') as never)
      // Parent wraps up.
      .mockResolvedValueOnce(textResponse('done') as never);

    const agent = new AgentLoop({ tools: makeTools() });
    const events: AgentLoopEvent[] = [];
    agent.on('event', (e) => events.push(e));

    await agent.chat('go');

    const completed = events.find((e) => e.type === 'sub_agent' && e.status === 'completed');
    expect(completed).toBeDefined();
    if (completed?.type !== 'sub_agent') return;

    const childTypes = (completed.events ?? []).map((e) => e.type);
    expect(childTypes).toContain('tool_call');
    expect(childTypes).toContain('tool_result');
    expect(childTypes).toContain('message');
    expect(childTypes).not.toContain('message_delta');
    expect(childTypes).not.toContain('reasoning_delta');

    const childToolCall = (completed.events ?? []).find((e) => e.type === 'tool_call');
    expect(childToolCall?.type === 'tool_call' && childToolCall.toolCall.name).toBe('echo');

    // The started marker stays lightweight.
    const started = events.find((e) => e.type === 'sub_agent' && e.status === 'started');
    expect(started?.type === 'sub_agent' && started.events).toBeUndefined();
  });

  it('sub-agent cannot spawn further agents (recursion blocked by construction)', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallResponse('spawn_agent', { task: 'try to recurse' }) as never)
      // Sub-agent's model call: its schema list must NOT contain spawn_agent.
      .mockResolvedValueOnce(textResponse('done') as never)
      .mockResolvedValueOnce(textResponse('wrapped') as never);

    const agent = new AgentLoop({ tools: makeTools() });
    await agent.chat('recurse');

    const subCallParams = mockCreate.mock.calls[1][0] as { tools?: Array<{ function: { name: string } }> };
    const subToolNames = subCallParams.tools?.map((t) => t.function.name) ?? [];
    expect(subToolNames).not.toContain('spawn_agent');
    expect(subToolNames).toContain('echo');
  });

  it('does not mutate the registry passed in by the caller', async () => {
    const tools = makeTools();
    new AgentLoop({ tools });
    expect(tools.has('spawn_agent')).toBe(false);
  });

  it('reports sub-agent failure as a tool error the parent can see', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallResponse('spawn_agent', { task: 'doomed task' }) as never)
      // Sub-agent exhausts its retries (maxRetries=2 → 3 attempts).
      .mockRejectedValueOnce(new Error('sub model down'))
      .mockRejectedValueOnce(new Error('sub model down'))
      .mockRejectedValueOnce(new Error('sub model down'))
      .mockResolvedValueOnce(textResponse('The sub-agent failed, sorry') as never);

    const agent = new AgentLoop({ tools: makeTools() });
    const events: AgentLoopEvent[] = [];
    agent.on('event', (e) => events.push(e));

    const { reply } = await agent.chat('try anyway');

    expect(reply).toContain('failed');
    const subEvents = events.filter((e) => e.type === 'sub_agent');
    expect(subEvents.map((e) => e.type === 'sub_agent' && e.status)).toEqual(['started', 'failed']);
  });
});
