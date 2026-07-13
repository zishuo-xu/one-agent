import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import Database from 'better-sqlite3';

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
import { PersistenceContextManager } from '../src/context/PersistenceContextManager.js';
import { MessageStore } from '../src/db/messageStore.js';
import { ThreadStore } from '../src/db/threadStore.js';
import { TaskJudge } from '../src/planning/TaskJudge.js';
import { Planner } from '../src/planning/Planner.js';
import type { AgentLoopEvent } from '../src/agents/AgentLoop.js';
import type { ToolDefinition } from '../src/tools/types.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

beforeEach(() => mockCreate.mockReset());

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      sequence INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_messages_thread_id ON messages(thread_id);
  `);
  return db;
}

describe('Fix 3: messages resume in save order via sequence', () => {
  it('preserves insertion order across same-second writes', () => {
    const db = createDb();
    const threadStore = new ThreadStore(db);
    const messageStore = new MessageStore(db);
    threadStore.create({ id: 't1' });

    messageStore.save('t1', { role: 'user', content: 'q1' });
    messageStore.save('t1', { role: 'assistant', content: 'a1', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] });
    messageStore.save('t1', { role: 'tool', content: 'r1', tool_call_id: 'c1' });
    messageStore.save('t1', { role: 'assistant', content: 'final' });

    const rows = messageStore.getByThread('t1');
    expect(rows.map((r) => r.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(rows[3].content).toBe('final');
  });
});

describe('Fix 2: PersistenceContextManager injects system prompt exactly once', () => {
  it('resume produces exactly one system message at index 0', () => {
    const db = createDb();
    const threadStore = new ThreadStore(db);
    const messageStore = new MessageStore(db);
    threadStore.create({ id: 't1' });

    messageStore.save('t1', { role: 'user', content: 'hi' });
    messageStore.save('t1', { role: 'assistant', content: 'hi back' });

    const pcm = new PersistenceContextManager({
      systemPrompt: 'YOU ARE X',
      threadId: 't1',
      db,
      threadStore,
      messageStore,
    });

    const history = pcm.getHistory();
    const systemCount = history.filter((m) => m.role === 'system').length;
    expect(systemCount).toBe(1);
    expect(history[0].role).toBe('system');
    expect(history[0].content).toBe('YOU ARE X');
  });
});

describe('Fix 1: default final answer streams when probe returns no content', () => {
  it('falls through to a streaming completion when the probe has empty content', async () => {
    mockCreate
      // First call: the non-streaming probe sees no tool_calls and no content.
      .mockResolvedValueOnce({
        choices: [{ message: { content: '' } }],
      } as never)
      // Second call: real streaming completion with two deltas.
      .mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'Hel' } }] };
          yield { choices: [{ delta: { content: 'lo' } }] };
        },
      } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const deltas: string[] = [];
    agent.on('event', (e: AgentLoopEvent) => {
      if (e.type === 'message_delta') deltas.push(e.content);
    });

    const { reply } = await agent.chat('Hi');
    expect(reply).toBe('Hello');
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Second call must be the streaming one.
    const secondCallArg = mockCreate.mock.calls[1][0] as { stream?: boolean };
    expect(secondCallArg.stream).toBe(true);
  });

  it('reuses the probed content without a second round-trip when present', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'cached answer' } }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const { reply } = await agent.chat('Hi');
    expect(reply).toBe('cached answer');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('uses reasoning_content as the probed content when content is empty', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '', reasoning_content: 'actual answer' } }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const { reply } = await agent.chat('Hi');
    expect(reply).toBe('actual answer');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe('Fix 4: tool failure in executeStep never marks the step completed', () => {
  it('treats a failed tool step as a retry, not a continue', async () => {
    const plan = {
      steps: [
        {
          id: '1',
          description: 'do thing',
          toolName: 'boom',
          status: 'pending' as const,
          strict: true,
          requiredTool: 'boom',
        },
      ],
      reasoning: 'plan',
    };

    const planner = new Planner();
    vi.spyOn(planner, 'createPlan').mockResolvedValue(plan as never);

    const taskJudge = new TaskJudge();
    // Judge says "continue" even though the tool failed — the loop must NOT
    // honor that and instead force a retry decision from executeStep.
    vi.spyOn(taskJudge, 'judge').mockResolvedValue({
      complete: false,
      reasoning: 'judge says continue',
      nextAction: 'continue',
    } as never);

    const boomToolCall = {
  choices: [
    {
      message: {
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'boom', arguments: '{}' } }],
      },
    },
  ],
};
// First executeStep probe sees the tool call; the tool fails and executeStep
// returns 'retry'. The outer loop re-runs the step once (maxRetryAttempts=1)
// and boom fails again; retries exhaust and the loop falls through to finalize.
mockCreate
  .mockResolvedValueOnce(boomToolCall as never)
  .mockResolvedValueOnce(boomToolCall as never)
  // finalizeAnswer() calls streamModel(); return a plain object so it falls
  // back to the non-streaming branch without requiring async iterator mock.
  .mockResolvedValueOnce({ choices: [{ message: { content: 'task failed' } }] } as never)
  .mockResolvedValueOnce({ choices: [{ message: { content: 'task failed' } }] } as never);

    const boomTool: ToolDefinition = {
      name: 'boom',
      description: 'always throws so the executor surfaces a failure',
      parameters: z.object({}),
      execute: () => {
        throw new Error('kaboom');
      },
    };
    const tools = new ToolRegistry();
    tools.register(boomTool);

    const agent = new AgentLoop({
      tools,
      planner,
      taskJudge,
      enablePlanning: true,
      maxRetryAttempts: 1,
    });
    const events: AgentLoopEvent[] = [];
    agent.on('event', (e) => events.push(e));

    // Without the fix, a failed tool would let executeStep return 'continue',
    // the outer loop sets step.status='completed' and the plan ends with a
    // finalize answer that falsely claims success. With the fix, executeStep
    // returns 'retry', bounded retries exhaust, and we still finalize — but
    // the step stays 'failed'.
    await agent.chat('do the thing');

    // The plan's step must remain 'failed', not 'completed'.
    expect(plan.steps[0].status).toBe('failed');

    // We must have emitted a tool_result event with success=false.
    const resultEvents = events.filter((e) => e.type === 'tool_result');
    expect(resultEvents.length).toBeGreaterThan(0);
    const bad = resultEvents[0];
    if (bad.type === 'tool_result') {
      expect(bad.toolResult.success).toBe(false);
    }
  });
});