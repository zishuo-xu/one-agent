import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { model: 'test-model' },
}));

import { RunRecorder } from '../../src/agents/RunRecorder.js';
import type { TraceEventStore } from '../../src/db/traceEventStore.js';

describe('RunRecorder recovery points', () => {
  it('stops the state transition when a recovery point cannot be persisted', () => {
    const traceEventStore = {
      create: vi.fn(() => {
        throw new Error('recovery journal unavailable');
      }),
    } as unknown as TraceEventStore;
    const recorder = new RunRecorder({ traceEventStore });
    recorder.setRun({ runId: 'run-1', threadId: 'thread-1' });

    expect(() => recorder.recordRecoveryPoint({
      version: 1,
      updatedAt: new Date().toISOString(),
      originalMessage: 'Deploy',
      loopMode: 'simple',
      recoveryCount: 0,
      pendingInput: {
        id: 'request-1',
        question: 'Which environment?',
        createdAt: new Date().toISOString(),
      },
    })).toThrow('recovery journal unavailable');

    expect(recorder.getTraceHealth()).toMatchObject({
      status: 'failed',
      droppedEventCount: 1,
      error: 'recovery journal unavailable',
    });
  });
});
