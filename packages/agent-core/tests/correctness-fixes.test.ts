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
      memory_extracted INTEGER NOT NULL DEFAULT 1,
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
      internal INTEGER NOT NULL DEFAULT 0,
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

describe('Fix 1: default final answer streams from a single streaming completion', () => {
  it('streams a normal (content-bearing) answer token-by-token in one request', async () => {
    // A single streaming completion emits two content deltas and no tool calls.
    mockCreate.mockResolvedValueOnce({
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
    // The answer reached the client as two separate deltas, not one burst.
    expect(deltas).toEqual(['Hel', 'lo']);
    // Exactly one model request - no probe-then-stream double round-trip.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArg = mockCreate.mock.calls[0][0] as { stream?: boolean };
    expect(callArg.stream).toBe(true);
  });

  it('falls back to a single message_delta when the endpoint ignores stream:true', async () => {
    // Endpoint returns a plain object instead of an async iterator.
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'cached answer' } }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const deltas: string[] = [];
    agent.on('event', (e: AgentLoopEvent) => {
      if (e.type === 'message_delta') deltas.push(e.content);
    });
    const { reply } = await agent.chat('Hi');
    expect(reply).toBe('cached answer');
    expect(deltas).toEqual(['cached answer']);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('uses reasoning_content when content is empty in the non-streaming fallback', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '', reasoning_content: 'actual answer' } }],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const { reply } = await agent.chat('Hi');
    expect(reply).toBe('actual answer');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('does not replay the reasoning buffer as a message_delta (no double print)', async () => {
    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { reasoning_content: 'think-' } }] };
        yield { choices: [{ delta: { reasoning_content: 'ing' } }] };
      },
    } as never);

    const agent = new AgentLoop({ enablePlanning: false });
    const messageDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    agent.on('event', (e: AgentLoopEvent) => {
      if (e.type === 'message_delta') messageDeltas.push(e.content);
      if (e.type === 'reasoning_delta') reasoningDeltas.push(e.content);
    });

    const { reply } = await agent.chat('Hi');
    expect(reply).toBe('think-ing');
    // The reasoning streamed once via reasoning_delta; no full-buffer
    // message_delta replay may follow (that was the double-print bug).
    expect(reasoningDeltas).toEqual(['think-', 'ing']);
    expect(messageDeltas).toEqual([]);
  });

  it('ends a tool-loop at the iteration cap with a graceful wrap-up call instead of throwing', async () => {
    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'Echo',
      parameters: z.object({ message: z.string() }),
      execute: (args: unknown) => ({ success: true, data: args }),
    };
    const tools = new ToolRegistry();
    tools.register(echoTool);

    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"message":"one"}' } }] } }],
      } as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'echo', arguments: '{"message":"two"}' } }] } }],
      } as never)
      // The wrap-up call (no tools offered) produces the final summary.
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'partial summary of findings' } }],
      } as never);

    const agent = new AgentLoop({ tools, enablePlanning: false, maxToolIterations: 1 });
    const { reply } = await agent.chat('keep using tools');

    expect(reply).toBe('partial summary of findings');
    // The wrap-up call must offer no tools and instruct the model to stop.
    const wrapUpParams = mockCreate.mock.calls[2][0] as {
      tools?: unknown[];
      messages: unknown;
    };
    expect(wrapUpParams.tools).toBeUndefined();
    expect(JSON.stringify(wrapUpParams.messages)).toContain('tool-call budget');
  });

  it('accumulates fragmented tool-call deltas and executes the tool, then streams a final answer', async () => {
    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'Echo',
      parameters: z.object({ message: z.string() }),
      execute: (args: unknown) => {
        const { message } = args as { message: string };
        return { success: true, data: { message } };
      },
    };
    const tools = new ToolRegistry();
    tools.register(echoTool);

    // Turn 1: stream interleaves a content fragment and a tool call whose
    // arguments arrive split across two deltas (real OpenAI behavior).
    // Turn 2: after the tool result, the model streams the final answer.
    mockCreate
      .mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'Let me echo that.' } }] };
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"message":"hi' } },
                  ],
                },
              },
            ],
          };
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"}' } }],
                },
              },
            ],
          };
        },
      } as never)
      .mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'Done: ' } }] };
          yield { choices: [{ delta: { content: 'hi' } }] };
        },
      } as never);

    const agent = new AgentLoop({ tools, enablePlanning: false });
    const deltas: string[] = [];
    const toolCalls: string[] = [];
    agent.on('event', (e: AgentLoopEvent) => {
      if (e.type === 'message_delta') deltas.push(e.content);
      if (e.type === 'tool_call') toolCalls.push(e.toolCall.name);
    });

    const { reply } = await agent.chat('echo hi');
    expect(toolCalls).toEqual(['echo']);
    // First turn streamed the thinking text, second turn streamed the answer.
    expect(deltas).toEqual(['Let me echo that.', 'Done: ', 'hi']);
    expect(reply).toBe('Done: hi');
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

describe('Fix: streaming retry must not duplicate emitted deltas', () => {
  it('does not retry after partial content has been streamed to the client', async () => {
    // First attempt streams one delta then throws mid-stream. Without the
    // fix, the retry would replay 'Hel' and the client would see 'HelHel...'.
    let attempt = 0;
    mockCreate.mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        return Promise.resolve({
          [Symbol.asyncIterator]: async function* () {
            yield { choices: [{ delta: { content: 'Hel' } }] };
            throw new Error('stream interrupted');
          },
        } as never);
      }
      // Second attempt (retry) should never happen.
      return Promise.resolve({
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'Hel' } }] };
          yield { choices: [{ delta: { content: 'lo' } }] };
        },
      } as never);
    });

    const agent = new AgentLoop({ enablePlanning: false, maxRetries: 2 });
    const deltas: string[] = [];
    agent.on('event', (e: AgentLoopEvent) => {
      if (e.type === 'message_delta') deltas.push(e.content);
    });

    // The turn should fail (partial stream then error), not silently retry.
    await expect(agent.chat('Hi')).rejects.toThrow('stream interrupted');
    // Only the first attempt's single delta reached the client - no replay.
    expect(deltas).toEqual(['Hel']);
    expect(attempt).toBe(1);
  });

  it('retries when the failure happens before any delta is emitted', async () => {
    let attempt = 0;
    mockCreate.mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        // Connection-level failure before streaming starts.
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve({
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'Hello' } }] };
        },
      } as never);
    });

    const agent = new AgentLoop({ enablePlanning: false, maxRetries: 2 });
    const deltas: string[] = [];
    agent.on('event', (e: AgentLoopEvent) => {
      if (e.type === 'message_delta') deltas.push(e.content);
    });

    const { reply } = await agent.chat('Hi');
    expect(reply).toBe('Hello');
    expect(deltas).toEqual(['Hello']);
    expect(attempt).toBe(2);
  });
});

describe('Fix: executeStep without toolExecutor surfaces failure', () => {
  it('emits a failed tool_result when no tool executor is available', async () => {
    // No tools registered -> toolExecutor is undefined. runSimpleLoop is used
    // (no toolRegistry => simple loop). The model returns a tool_call; the loop
    // must emit a tool_result with success=false rather than silently skipping.
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
          },
        },
      ],
    } as never);

    const agent = new AgentLoop({ enablePlanning: false, maxToolIterations: 1 });
    const events: AgentLoopEvent[] = [];
    agent.on('event', (e) => events.push(e));

    // The loop exhausts its tool budget and ends with a graceful wrap-up
    // call (no more throwing). What matters is that a failed tool_result
    // was emitted along the way.
    await agent.chat('read something');

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.length).toBeGreaterThan(0);
    const tr = toolResults[0];
    if (tr.type === 'tool_result') {
      expect(tr.toolResult.success).toBe(false);
      expect(tr.toolResult.error).toContain('No tool executor');
    }
  });
});
