import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatTraceEvent, printTraces } from '../src/commands/traces.js';
import type { TraceEvent } from '@one-agent/agent-core';

describe('trace command helpers', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('formats a trace event with timestamp, type and data preview', () => {
    const event: TraceEvent = {
      id: 't1',
      runId: 'r1',
      taskId: null,
      threadId: 'th1',
      eventType: 'message',
      eventData: { type: 'message', content: 'Hello' },
      model: 'test',
      createdAt: '2026-07-13T10:00:00.000Z',
    };

    const formatted = formatTraceEvent(event);
    expect(formatted).toContain('2026-07-13T10:00:00.000Z');
    expect(formatted).toContain('[message]');
    expect(formatted).toContain('Hello');
  });

  it('truncates long event data to 200 chars', () => {
    const event: TraceEvent = {
      id: 't1',
      runId: 'r1',
      taskId: null,
      threadId: 'th1',
      eventType: 'message',
      eventData: { type: 'message', content: 'a'.repeat(500) },
      model: 'test',
      createdAt: '2026-07-13T10:00:00.000Z',
    };

    const formatted = formatTraceEvent(event);
    const dataPreview = formatted.slice(formatted.indexOf('[') + 'message'.length + 2);
    expect(dataPreview.length).toBeLessThanOrEqual(204); // 1 (space) + 200 + '...'
    expect(dataPreview).toContain('...');
    expect(dataPreview).toContain('aaaa');
  });

  it('prints all trace events', () => {
    const events: TraceEvent[] = [
      {
        id: 't1',
        runId: 'r1',
        taskId: null,
        threadId: 'th1',
        eventType: 'plan',
        eventData: { type: 'plan', plan: { steps: [] } },
        model: 'test',
        createdAt: '2026-07-13T10:00:00.000Z',
      },
      {
        id: 't2',
        runId: 'r1',
        taskId: null,
        threadId: 'th1',
        eventType: 'message',
        eventData: { type: 'message', content: 'Done' },
        model: 'test',
        createdAt: '2026-07-13T10:00:01.000Z',
      },
    ];

    printTraces(events);

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0][0]).toContain('[plan]');
    expect(logSpy.mock.calls[1][0]).toContain('[message]');
  });

  it('prints a message when no traces are found', () => {
    printTraces([]);
    expect(logSpy).toHaveBeenCalledWith('No traces found.');
  });

  it('groups consecutive per-token delta events into one summary line', () => {
    const delta = (id: string, content: string, at: string): TraceEvent => ({
      id,
      runId: 'r1',
      taskId: null,
      threadId: 'th1',
      eventType: 'message_delta',
      eventData: { type: 'message_delta', content },
      model: 'test',
      createdAt: at,
    });
    const events: TraceEvent[] = [
      delta('t1', 'Hel', '2026-07-13T10:00:00.000Z'),
      delta('t2', 'lo', '2026-07-13T10:00:00.100Z'),
      delta('t3', ' world', '2026-07-13T10:00:00.200Z'),
      {
        id: 't4',
        runId: 'r1',
        taskId: null,
        threadId: 'th1',
        eventType: 'message',
        eventData: { type: 'message', content: 'Hello world' },
        model: 'test',
        createdAt: '2026-07-13T10:00:01.000Z',
      },
    ];

    printTraces(events);

    // 3 token rows collapse into 1 grouped line + 1 message line.
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0][0]).toContain('[message_delta]');
    expect(logSpy.mock.calls[0][0]).toContain('× 3');
    expect(logSpy.mock.calls[0][0]).toContain('Hello world');
    expect(logSpy.mock.calls[1][0]).toContain('[message]');
  });

  it('verbose mode lifts the default trace limit', () => {
    const events: TraceEvent[] = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      runId: 'r1',
      taskId: null,
      threadId: 'th1',
      eventType: 'message',
      eventData: { type: 'message', content: `m${i}` },
      model: 'test',
      createdAt: '2026-07-13T10:00:00.000Z',
    }));

    printTraces(events, { verbose: true });

    expect(logSpy).toHaveBeenCalledTimes(30);
  });
});
