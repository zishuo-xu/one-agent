import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolDefinition } from '../../src/tools/types.js';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo the input',
  parameters: z.object({ message: z.string() }),
  execute: (args: unknown) => {
    const { message } = args as { message: string };
    return { message };
  },
};

describe('ToolExecutor', () => {
  it('only treats explicitly read-only registered tools as safe for parallel execution', () => {
    const registry = new ToolRegistry();
    registry.register({ ...echoTool, readOnly: true });
    registry.register({ ...echoTool, name: 'mutable' });
    const executor = new ToolExecutor(registry);

    expect(executor.isReadOnly('echo')).toBe(true);
    expect(executor.isReadOnly('mutable')).toBe(false);
    expect(executor.isReadOnly('missing')).toBe(false);
  });

  it('executes a valid tool call', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute({
      id: 'call_1',
      name: 'echo',
      arguments: { message: 'hello' },
    });

    expect(result).toEqual({ success: true, data: { message: 'hello' } });
  });

  it('returns error for invalid parameters', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute({
      id: 'call_1',
      name: 'echo',
      arguments: { message: 123 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid parameters');
  });

  it('returns error for unknown tool', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    const result = await executor.execute({
      id: 'call_1',
      name: 'missing',
      arguments: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Tool not found');
  });

  it('returns error when tool throws', async () => {
    const errorTool: ToolDefinition = {
      name: 'fail',
      description: 'Always fails',
      parameters: z.object({}),
      execute: () => {
        throw new Error('boom');
      },
    };

    const registry = new ToolRegistry();
    registry.register(errorTool);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute({ id: 'call_1', name: 'fail', arguments: {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('boom');
  });
});
