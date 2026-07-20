import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/config.js', () => ({
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

import { config } from '../src/config.js';
import { AgentLoop } from '../src/agents/AgentLoop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolDefinition } from '../src/tools/types.js';
import { createManageMemoryTool } from '../src/memory/manageMemoryTool.js';
import { MemoryDocumentStore } from '../src/memory/MemoryDocumentStore.js';
import { ContextManager } from '../src/context/ContextManager.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo the input',
  parameters: z.object({ message: z.string() }),
  execute: (args: unknown) => {
    const { message } = args as { message: string };
    return { success: true, data: { message } };
  },
};

describe('AgentLoop', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns assistant reply and keeps history', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello from assistant' } }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const { reply, events } = await agent.chat('Hi');

    expect(reply).toBe('Hello from assistant');
    expect(events[0]).toMatchObject({ type: 'run', phase: 'started' });
    expect(events.some((event) => event.type === 'model_call' && event.phase === 'started')).toBe(true);
    expect(events.some((event) => event.type === 'model_call' && event.phase === 'completed')).toBe(true);
    expect(events).toContainEqual({ type: 'message', content: 'Hello from assistant' });
    expect(events.at(-1)).toMatchObject({ type: 'run', phase: 'completed' });
    expect(events.map((event) => event.type)).not.toContain('verification');
    expect(agent.getHistory()).toHaveLength(3); // system + user + assistant
    expect(agent.getHistory()[1]).toEqual({ role: 'user', content: 'Hi' });
    expect(agent.getHistory()[2]).toEqual({
      role: 'assistant',
      content: 'Hello from assistant',
    });
  });

  it('keeps internal and tool-call messages out of user-facing history', () => {
    const contextManager = new ContextManager({ systemPrompt: 'test system prompt' });
    contextManager.addMessage({ role: 'user', content: 'Visible question' });
    contextManager.addMessage({
      role: 'assistant',
      content: 'Legacy internal tool thought',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      }],
    });
    contextManager.addMessage({ role: 'tool', content: 'tool output', tool_call_id: 'call-1' });
    contextManager.addMessage({ role: 'user', content: 'Execute the following step from the plan.' });
    contextManager.addMessage({ role: 'assistant', content: 'Visible answer' });

    const agent = new AgentLoop({ contextManager, enablePlanning: false });

    expect(agent.getUserFacingHistory()).toEqual([
      { role: 'user', content: 'Visible question' },
      { role: 'assistant', content: 'Visible answer' },
    ]);
  });

  it('falls back to reasoning_content when content is whitespace', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '\n\n', reasoning_content: 'Hello from fallback' } }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const { reply } = await agent.chat('Hi');

    expect(reply).toBe('Hello from fallback');
  });

  it('extracts text from compatible content parts', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: [{ type: 'text', text: 'Hello ' }, { text: 'from parts' }] } }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const { reply } = await agent.chat('Hi');

    expect(reply).toBe('Hello from parts');
  });

  it('does not run memory extraction inside the per-turn execution path', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Reply now' } }],
    } as never);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-memory-loop-'));
    const memoryDocumentStore = new MemoryDocumentStore({ workspaceRoot: root, globalRoot: root });
    const agent = new AgentLoop({
      enablePlanning: false,
      memoryDocumentStore,
    });

    const result = await agent.chat('Hi');

    expect(result.reply).toBe('Reply now');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('applies an explicit natural-language memory request through the tool loop', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-memory-tool-loop-'));
    const memoryDocumentStore = new MemoryDocumentStore({ workspaceRoot: root, globalRoot: root });
    const tools = new ToolRegistry();
    tools.register(createManageMemoryTool({ documentStore: memoryDocumentStore }));
    mockCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'memory-call-1',
              type: 'function',
              function: {
                name: 'manage_memory',
                arguments: JSON.stringify({
                  action: 'remember',
                  scope: 'workspace',
                  text: '这个项目使用 pnpm。',
                }),
              },
            }],
          },
        }],
      } as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: '我已经记住这个项目使用 pnpm。' } }],
      } as never);

    const agent = new AgentLoop({ tools, memoryDocumentStore, enablePlanning: false });
    const result = await agent.chat('记住这个项目使用 pnpm');

    expect(result.reply).toBe('我已经记住这个项目使用 pnpm。');
    expect(memoryDocumentStore.read('workspace').content).toContain('这个项目使用 pnpm。');
    expect(agent.getHistory()[0].content).toContain('explicitly asks you to remember');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses custom system prompt', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'OK' } }],
    } as never);

    const agent = new AgentLoop({ systemPrompt: 'You are a coder.', enablePlanning: false });
    await agent.chat('test');

    const history = agent.getHistory();
    expect(history[0]).toEqual({ role: 'system', content: 'You are a coder.' });
  });

  it('retries on failure and eventually throws', async () => {
    mockCreate.mockRejectedValue(new Error('Network error') as never);

    const agent = new AgentLoop({ maxRetries: 1, timeoutMs: 100, enablePlanning: false });
    await expect(agent.chat('test')).rejects.toThrow(
      'Model call failed after 2 attempt(s): Network error'
    );
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('returns empty string when model returns no content', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: {} }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const { reply } = await agent.chat('test');

    expect(reply).toBe('');
  });

  it('calls tools and returns final answer', async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);

    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
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
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Echo: hello' } }],
      } as never);

    const agent = new AgentLoop({ tools, enablePlanning: false });
    const { reply, events } = await agent.chat('Please echo hello');

    expect(reply).toBe('Echo: hello');
    expect(events.some((event) => event.type === 'tool_call')).toBe(true);
    expect(events.some((event) => event.type === 'tool_result')).toBe(true);
    expect(events).toContainEqual({ type: 'message', content: 'Echo: hello' });
    expect(events.at(-1)).toMatchObject({ type: 'run', phase: 'completed' });
    expect(events.map((event) => event.type)).not.toContain('verification');
  });
});
