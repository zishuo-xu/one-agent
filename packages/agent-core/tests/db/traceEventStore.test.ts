import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { RunStore } from '../../src/db/runStore.js';
import { TraceEventStore } from '../../src/db/traceEventStore.js';
import type { AgentLoopEvent } from '../../src/agents/AgentLoop.js';

describe('TraceEventStore', () => {
  let db: Database.Database;
  let threadStore: ThreadStore;
  let runStore: RunStore;
  let store: TraceEventStore;
  let threadId: string;
  let runId: string;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    threadStore = new ThreadStore(db);
    runStore = new RunStore(db);
    store = new TraceEventStore(db);

    threadId = threadStore.create({ id: 'thread-1' }).id;
    runId = runStore.create({ threadId, model: 'gpt-test' }).id;
  });

  it('creates and retrieves a trace event', () => {
    const event: AgentLoopEvent = { type: 'thought', content: 'I need to read a file.' };

    const created = store.create({
      runId,
      taskId: 'task-1',
      threadId,
      eventType: event.type,
      eventData: event,
      model: 'gpt-test',
    });

    expect(created.id).toBeDefined();
    expect(created.runId).toBe(runId);
    expect(created.taskId).toBe('task-1');
    expect(created.threadId).toBe(threadId);
    expect(created.eventType).toBe('thought');
    expect(created.eventData).toEqual(event);
    expect(created.model).toBe('gpt-test');

    const retrieved = store.getById(created.id);
    expect(retrieved).toEqual(created);
  });

  it('lists events by run, task, and thread', () => {
    const runA = runStore.create({ threadId, model: 'gpt-test' }).id;
    const runB = runStore.create({ threadId, model: 'gpt-test' }).id;

    store.create({ runId: runA, threadId, eventType: 'thought', eventData: { type: 'thought', content: 'a' } });
    store.create({ runId: runA, threadId, eventType: 'tool_call', eventData: { type: 'tool_call', toolCall: { id: 'c1', name: 'read_file', arguments: {} } } });
    store.create({ runId: runB, threadId, eventType: 'thought', eventData: { type: 'thought', content: 'b' } });

    expect(store.getByRun(runA)).toHaveLength(2);
    expect(store.getByRun(runB)).toHaveLength(1);
    expect(store.getByThread(threadId)).toHaveLength(3);
  });

  it('deletes events by run', () => {
    store.create({ runId, threadId, eventType: 'thought', eventData: { type: 'thought', content: 'x' } });
    store.deleteByRun(runId);
    expect(store.getByRun(runId)).toHaveLength(0);
  });

  it('keeps an exact recovery fact internally while sanitizing public Trace reads', () => {
    store.create({
      runId,
      threadId,
      eventType: 'recovery_point',
      eventData: {
        type: 'recovery_point',
        checkpoint: {
          version: 1,
          updatedAt: new Date().toISOString(),
          originalMessage: 'Deploy',
          loopMode: 'simple',
          recoveryCount: 0,
          pendingInput: {
            id: 'approval-1',
            kind: 'tool_approval',
            question: 'Approve?',
            createdAt: new Date().toISOString(),
            approval: {
              toolCall: { id: 'call-1', name: 'run_command', arguments: { api_key: 'secret-value' } },
              fingerprint: 'fingerprint',
            },
          },
        },
      },
    });

    expect(JSON.stringify(store.getByRun(runId))).not.toContain('secret-value');
    const raw = db.prepare(
      `SELECT event_data FROM trace_events
       WHERE run_id = ? AND event_type = 'recovery_point'`
    ).get(runId) as { event_data: string };
    expect(raw.event_data).toContain('secret-value');
    expect(store.getLatestRecoveryPoint(runId)).toMatchObject({
      pendingInput: { approval: { toolCall: { arguments: { api_key: 'secret-value' } } } },
    });
  });
});
