import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRunner } from '../../src/agents/ToolRunner.js';
import { RunRecorder } from '../../src/agents/RunRecorder.js';
import { ContextManager } from '../../src/context/ContextManager.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { DefaultToolPolicy, ToolApprovalRequiredError } from '../../src/tools/policy.js';

describe('ToolRunner', () => {
  it('owns the complete call, execution, context and persistence protocol', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'Echo input',
      parameters: z.object({ text: z.string() }),
      execute: ({ text }) => ({ text }),
    });
    const context = new ContextManager({ systemPrompt: 'test' });
    const recorder = new RunRecorder();
    const persist = vi.fn();
    const phases: string[] = [];
    const call = { id: 'call-1', name: 'echo', arguments: { text: 'hello' } };
    const runner = new ToolRunner({
      executor: new ToolExecutor(registry),
      contextManager: context,
      recorder,
      checkSignal: () => undefined,
      persist,
    });

    runner.recordCalls([call], { stepId: 'step-1' });
    const result = await runner.execute(call, {
      runId: 'run-1',
      stepId: 'step-1',
      onPhase: (phase) => phases.push(phase),
    });

    expect(result).toEqual({ success: true, data: { text: 'hello' } });
    expect(phases).toEqual(['prepared', 'running']);
    expect(recorder.getEvents().map((event) => event.type)).toEqual(['tool_call', 'tool_result']);
    expect(context.getHistory().at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      internal: true,
    });
    expect(persist).toHaveBeenCalledWith('run-1', call, result);
  });

  it('pairs rejected calls in context without persisting them as executions', () => {
    const context = new ContextManager({ systemPrompt: 'test' });
    const recorder = new RunRecorder();
    const persist = vi.fn();
    const runner = new ToolRunner({
      contextManager: context,
      recorder,
      checkSignal: () => undefined,
      persist,
    });
    const call = { id: 'call-2', name: 'write_file', arguments: {} };
    const result = { success: false, error: 'Rejected by plan constraint' };

    runner.recordResult(call, result, { status: 'rejected', stepId: 'step-2' });

    expect(recorder.getEvents()[0]).toMatchObject({ type: 'tool_result', status: 'rejected' });
    expect(context.getHistory().at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-2' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('runs an explicitly read-only batch concurrently and commits results in call order', async () => {
    const registry = new ToolRegistry();
    const started: string[] = [];
    let releaseFirst = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    registry.register({
      name: 'first',
      readOnly: true,
      description: 'First read',
      parameters: z.object({}),
      execute: async () => {
        started.push('first');
        await firstGate;
        return 'first result';
      },
    });
    registry.register({
      name: 'second',
      readOnly: true,
      description: 'Second read',
      parameters: z.object({}),
      execute: async () => {
        started.push('second');
        return 'second result';
      },
    });
    const context = new ContextManager({ systemPrompt: 'test' });
    const recorder = new RunRecorder();
    const persist = vi.fn();
    const calls = [
      { id: 'call-first', name: 'first', arguments: {} },
      { id: 'call-second', name: 'second', arguments: {} },
    ];
    const runner = new ToolRunner({
      executor: new ToolExecutor(registry),
      contextManager: context,
      recorder,
      checkSignal: () => undefined,
      persist,
    });

    const batch = runner.executeBatch(calls, { runId: 'run-batch' });
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    releaseFirst();
    const results = await batch;

    expect(results).toEqual([
      { success: true, data: 'first result' },
      { success: true, data: 'second result' },
    ]);
    const resultEvents = recorder.getEvents().filter((event) => event.type === 'tool_result');
    expect(resultEvents.map((event) => event.type === 'tool_result' && event.toolCallId))
      .toEqual(['call-first', 'call-second']);
    expect(context.getHistory().filter((message) => message.role === 'tool').map((message) => message.tool_call_id))
      .toEqual(['call-first', 'call-second']);
    expect(persist.mock.calls.map((call) => call[1].id))
      .toEqual(['call-first', 'call-second']);
  });

  it('isolates a read-only tool failure without cancelling the rest of the batch', async () => {
    const registry = new ToolRegistry();
    const executed: string[] = [];
    registry.register({
      name: 'fail_read',
      readOnly: true,
      description: 'Failing read',
      parameters: z.object({}),
      execute: () => {
        executed.push('fail');
        throw new Error('read failed');
      },
    });
    registry.register({
      name: 'good_read',
      readOnly: true,
      description: 'Successful read',
      parameters: z.object({}),
      execute: () => {
        executed.push('good');
        return 'ok';
      },
    });
    const context = new ContextManager({ systemPrompt: 'test' });
    const runner = new ToolRunner({
      executor: new ToolExecutor(registry),
      contextManager: context,
      recorder: new RunRecorder(),
      checkSignal: () => undefined,
    });

    const results = await runner.executeBatch([
      { id: 'failed', name: 'fail_read', arguments: {} },
      { id: 'succeeded', name: 'good_read', arguments: {} },
    ]);

    expect(executed).toEqual(['fail', 'good']);
    expect(results[0]).toMatchObject({ success: false });
    expect(results[1]).toEqual({ success: true, data: 'ok' });
    expect(context.getHistory().filter((message) => message.role === 'tool').map((message) => message.tool_call_id))
      .toEqual(['failed', 'succeeded']);
  });

  it('keeps mixed read/write batches sequential', async () => {
    const registry = new ToolRegistry();
    const order: string[] = [];
    const makeTool = (name: string, readOnly?: boolean) => ({
      name,
      readOnly,
      description: name,
      parameters: z.object({}),
      execute: async () => {
        order.push(`${name}:start`);
        await Promise.resolve();
        order.push(`${name}:end`);
        return name;
      },
    });
    registry.register(makeTool('read', true));
    registry.register(makeTool('write'));
    const runner = new ToolRunner({
      executor: new ToolExecutor(registry),
      contextManager: new ContextManager({ systemPrompt: 'test' }),
      recorder: new RunRecorder(),
      checkSignal: () => undefined,
    });

    await runner.executeBatch([
      { id: 'read', name: 'read', arguments: {} },
      { id: 'write', name: 'write', arguments: {} },
    ]);

    expect(order).toEqual(['read:start', 'read:end', 'write:start', 'write:end']);
  });

  it('preflights an entire batch before starting a confirmation-required tool', async () => {
    const registry = new ToolRegistry();
    const executed: string[] = [];
    for (const name of ['safe_read', 'dangerous_read']) {
      registry.register({
        name,
        readOnly: true,
        description: name,
        parameters: z.object({}),
        execute: () => executed.push(name),
      });
    }
    const runner = new ToolRunner({
      executor: new ToolExecutor(registry),
      contextManager: new ContextManager({ systemPrompt: 'test' }),
      recorder: new RunRecorder(),
      checkSignal: () => undefined,
      policy: new DefaultToolPolicy({ confirmTools: ['dangerous_read'] }),
    });

    await expect(runner.executeBatch([
      { id: 'safe', name: 'safe_read', arguments: {} },
      { id: 'danger', name: 'dangerous_read', arguments: {} },
    ])).rejects.toBeInstanceOf(ToolApprovalRequiredError);
    expect(executed).toEqual([]);
  });
});
