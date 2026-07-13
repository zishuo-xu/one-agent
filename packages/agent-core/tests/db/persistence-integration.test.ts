import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { MessageStore } from '../../src/db/messageStore.js';
import { RunStore } from '../../src/db/runStore.js';
import { ToolCallStore } from '../../src/db/toolCallStore.js';
import { AgentLoop } from '../../src/agents/AgentLoop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolDefinition } from '../../src/tools/types.js';

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

describe('AgentLoop persistence integration', () => {
  let db: Database.Database;
  let threadStore: ThreadStore;
  let messageStore: MessageStore;
  let runStore: RunStore;
  let toolCallStore: ToolCallStore;
  let threadId: string;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    threadStore = new ThreadStore(db);
    messageStore = new MessageStore(db);
    runStore = new RunStore(db);
    toolCallStore = new ToolCallStore(db);
    threadId = threadStore.create({ id: 'thread-1' }).id;
    mockCreate.mockReset();
  });

  it('saves messages, run and tool calls to SQLite', async () => {
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

    const agent = new AgentLoop({
      tools,
      enablePlanning: false,
      threadId,
      db,
      runStore,
      toolCallStore,
    });

    const { reply, runId } = await agent.chat('Please echo hello');
    expect(reply).toBe('Echo: hello');
    expect(runId).toBeDefined();

    // Messages persisted
    const messages = messageStore.getByThread(threadId);
    expect(messages.some((m) => m.role === 'user' && m.content === 'Please echo hello')).toBe(true);
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'Echo: hello')).toBe(true);
    expect(messages.some((m) => m.role === 'tool')).toBe(true);

    // Run persisted
    const run = runStore.getById(runId!);
    expect(run).toBeDefined();
    expect(run?.status).toBe('completed');
    expect(run?.threadId).toBe(threadId);

    // Tool call persisted
    const calls = toolCallStore.getByRun(runId!);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('echo');
  });

  it('loads history from SQLite on new AgentLoop instance', async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);

    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'First reply' } }],
      } as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Second reply' } }],
      } as never);

    const firstAgent = new AgentLoop({
      tools,
      enablePlanning: false,
      threadId,
      db,
      runStore,
      toolCallStore,
    });
    await firstAgent.chat('First message');

    const secondAgent = new AgentLoop({
      tools,
      enablePlanning: false,
      threadId,
      db,
      runStore,
      toolCallStore,
    });
    const history = secondAgent.getHistory();
    expect(history.some((m) => m.role === 'user' && m.content === 'First message')).toBe(true);
    expect(history.some((m) => m.role === 'assistant' && m.content === 'First reply')).toBe(true);

    const { reply } = await secondAgent.chat('Second message');
    expect(reply).toBe('Second reply');
  });
});
