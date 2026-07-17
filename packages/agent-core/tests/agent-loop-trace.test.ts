import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../src/config.js', () => ({
  config: {
    port: 3000,
    host: '127.0.0.1',
    model: 'gpt-test',
    systemPrompt: 'You are a test assistant.',
    openai: {
      chat: { completions: { create: vi.fn() } },
    },
  },
}));

import { config } from '../src/config.js';
import { createConnection, resetSharedConnection } from '../src/db/connection.js';
import { AgentLoop } from '../src/agents/AgentLoop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Sandbox } from '../src/tools/sandbox.js';
import { createReadFileTool } from '../src/tools/built-in/readFile.js';
import { TraceEventStore } from '../src/db/traceEventStore.js';
import { ThreadStore } from '../src/db/threadStore.js';
import { RunStore } from '../src/db/runStore.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);


describe('AgentLoop trace persistence', () => {
  let db: Database.Database;
  let traceStore: TraceEventStore;
  let threadStore: ThreadStore;

  beforeEach(() => {
    resetSharedConnection();
    db = createConnection({ path: ':memory:' });
    traceStore = new TraceEventStore(db);
    threadStore = new ThreadStore(db);
    mockCreate.mockReset();
  });

  it('writes trace events for a run', async () => {
    const sandbox = new Sandbox('/tmp/agent-loop-trace-test');
    const tools = new ToolRegistry();
    tools.register(createReadFileTool(sandbox));

    const threadId = threadStore.create({ id: 'thread-trace' }).id;

    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: JSON.stringify({ path: 'notes.txt' }),
                  },
                },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Done reading.' } }],
      } as never);

    const agent = new AgentLoop({
      tools,
      threadId,
      db,
      taskId: 'task-trace-1',
      enablePlanning: false,
    });

    const { runId } = await agent.chat('Read notes.txt');
    expect(runId).toBeDefined();

    const traces = traceStore.getByRun(runId!);
    expect(traces.length).toBeGreaterThanOrEqual(2);
    expect(traces.some((t) => t.eventType === 'tool_call')).toBe(true);
    expect(traces.some((t) => t.eventType === 'tool_result')).toBe(true);
    expect(traces.some((t) => t.eventType === 'message')).toBe(true);
    expect(traces.every((t) => t.taskId === 'task-trace-1')).toBe(true);
    expect(traces.every((t) => t.threadId === threadId)).toBe(true);
  });

  it('persists streaming deltas as one aggregated row per stream instead of one row per token', async () => {
    const threadId = threadStore.create({ id: 'thread-delta' }).id;

    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'Hel' } }] };
        yield { choices: [{ delta: { content: 'lo' } }] };
        yield { choices: [{ delta: { content: ' world' } }] };
      },
    } as never);

    const agent = new AgentLoop({ threadId, db, enablePlanning: false });
    const { runId, reply } = await agent.chat('Hi');

    expect(reply).toBe('Hello world');
    const deltaTraces = traceStore
      .getByRun(runId!)
      .filter((t) => t.eventType === 'message_delta');
    expect(deltaTraces).toHaveLength(1);
    expect(JSON.stringify(deltaTraces[0].eventData)).toContain('Hello world');
    // Non-delta events still persist individually and in order.
    const traces = traceStore.getByRun(runId!);
    expect(traces.some((t) => t.eventType === 'message')).toBe(true);
  });
});
