import { describe, expect, it } from 'vitest';
import { StrategyController } from '../../src/agents/StrategyController.js';

describe('StrategyController', () => {
  it('escalates a multi-tool first batch before execution', () => {
    const controller = new StrategyController();
    expect(controller.evaluate({
      phase: 'before_tool_execution',
      loop: 'simple',
      toolIteration: 0,
      toolCallNames: ['read_file', 'write_file'],
      switchCount: 0,
    })).toMatchObject({ action: 'switch_to_planning' });
  });

  it('keeps a single-tool direct path simple', () => {
    const controller = new StrategyController();
    expect(controller.evaluate({
      phase: 'before_tool_execution',
      loop: 'simple',
      toolIteration: 0,
      toolCallNames: ['read_file'],
      switchCount: 0,
    })).toEqual({ action: 'continue' });
  });

  it('never switches after execution began or after the switch budget is spent', () => {
    const controller = new StrategyController();
    const base = {
      phase: 'before_tool_execution' as const,
      loop: 'simple' as const,
      toolCallNames: ['read_file', 'write_file'],
    };
    expect(controller.evaluate({ ...base, toolIteration: 1, switchCount: 0 }))
      .toEqual({ action: 'continue' });
    expect(controller.evaluate({ ...base, toolIteration: 0, switchCount: 1 }))
      .toEqual({ action: 'continue' });
  });
});
