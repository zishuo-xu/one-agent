import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRunner } from '../../src/agents/ToolRunner.js';
import { RunRecorder } from '../../src/agents/RunRecorder.js';
import { ContextManager } from '../../src/context/ContextManager.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';

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
});
