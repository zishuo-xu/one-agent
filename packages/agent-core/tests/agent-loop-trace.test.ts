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
import { MemoryStore } from '../src/db/memoryStore.js';

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
    expect(traces[0].eventType).toBe('run');
    expect(traces[0].eventData).toMatchObject({ phase: 'started' });
    expect(traces.at(-1)?.eventType).toBe('run');
    expect(traces.at(-1)?.eventData).toMatchObject({ phase: 'completed' });
    expect(traces.map((trace) => trace.sequence)).toEqual(
      traces.map((_, index) => index)
    );
    expect(traces.some((t) => t.eventType === 'model_call')).toBe(true);
    expect(traces.some((t) => t.eventType === 'tool_call')).toBe(true);
    expect(traces.some((t) => t.eventType === 'tool_result')).toBe(true);
    expect(traces.some((t) => t.eventType === 'message')).toBe(true);
    expect(traces.some((t) => t.eventType === 'verification')).toBe(false);
    expect(traces.every((t) => t.taskId === 'task-trace-1')).toBe(true);
    expect(traces.every((t) => t.threadId === threadId)).toBe(true);

    const run = new RunStore(db).getById(runId!);
    expect(run).toMatchObject({ traceStatus: 'complete', droppedTraceEvents: 0 });
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

  it('records why memories were selected and how much context was injected', async () => {
    const threadId = threadStore.create({ id: 'thread-memory-trace' }).id;
    const memoryStore = new MemoryStore(db);
    const memory = memoryStore.create({
      key: 'preferred language', value: 'Chinese', explicit: true, confidence: 0.95,
    });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'You prefer Chinese.' } }],
    } as never);

    const agent = new AgentLoop({ threadId, db, memoryStore, enablePlanning: false });
    const { runId } = await agent.chat('What language do I prefer?');

    const trace = traceStore.getByRun(runId!).find((event) => event.eventType === 'memory_recall');
    expect(trace?.eventData).toMatchObject({
      type: 'memory_recall',
      candidateCount: 1,
      selectedCount: 1,
      injectedMemoryIds: [memory.id],
    });
    expect((trace?.eventData as { estimatedTokens?: number }).estimatedTokens).toBeGreaterThan(0);
    expect(JSON.stringify(trace?.eventData)).not.toContain('Chinese');
  });

  it('continues the main run and traces the error when memory recall fails', async () => {
    const threadId = threadStore.create({ id: 'thread-memory-recall-failure' }).id;
    const failingMemoryStore = {
      recallRelevantMemories: vi.fn(() => { throw new Error('memory database unavailable'); }),
    } as unknown as MemoryStore;
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Reply without memory.' } }],
    } as never);

    const agent = new AgentLoop({ threadId, db, memoryStore: failingMemoryStore, enablePlanning: false });
    const result = await agent.chat('Hi');

    expect(result.reply).toBe('Reply without memory.');
    const trace = traceStore.getByRun(result.runId!).find((event) => event.eventType === 'memory_recall');
    expect(trace?.eventData).toMatchObject({
      type: 'memory_recall',
      selectedCount: 0,
      error: 'memory database unavailable',
    });
  });

  it('returns the reply and marks trace health failed when trace persistence is unavailable', async () => {
    const threadId = threadStore.create({ id: 'thread-trace-failure' }).id;
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Reply survives.' } }],
    } as never);
    const unavailableTraceStore = {
      create: vi.fn(() => {
        throw new Error('trace database unavailable');
      }),
    } as unknown as TraceEventStore;

    const agent = new AgentLoop({
      threadId,
      db,
      traceEventStore: unavailableTraceStore,
      enablePlanning: false,
    });
    const result = await agent.chat('Hi');

    expect(result.reply).toBe('Reply survives.');
    const run = new RunStore(db).getById(result.runId!);
    expect(run?.traceStatus).toBe('failed');
    expect(run?.droppedTraceEvents).toBeGreaterThan(0);
    expect(run?.traceError).toContain('trace database unavailable');
  });
});
