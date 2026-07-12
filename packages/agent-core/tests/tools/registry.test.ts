import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolDefinition } from '../../src/tools/types.js';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo the input message',
  parameters: z.object({ message: z.string() }),
  execute: (args: unknown) => {
    const { message } = args as { message: string };
    return { message };
  },
};

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    expect(registry.has('echo')).toBe(true);
    expect(registry.get('echo').name).toBe('echo');
    expect(registry.list()).toHaveLength(1);
  });

  it('throws when registering duplicate tools', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow('Tool already registered: echo');
  });

  it('throws when retrieving unknown tools', () => {
    const registry = new ToolRegistry();
    expect(() => registry.get('missing')).toThrow('Tool not found: missing');
  });

  it('generates OpenAI-compatible schemas', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const schemas = registry.getSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].type).toBe('function');
    expect(schemas[0].function.name).toBe('echo');
    expect(schemas[0].function.parameters).toHaveProperty('properties');
    expect(schemas[0].function.parameters).toHaveProperty('required');
  });

  it('registers multiple tools at once', () => {
    const registry = new ToolRegistry();
    const addTool: ToolDefinition = {
      name: 'add',
      description: 'Add two numbers',
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: (args: unknown) => {
        const { a, b } = args as { a: number; b: number };
        return { result: a + b };
      },
    };

    registry.registerMany([echoTool, addTool]);
    expect(registry.list()).toHaveLength(2);
  });
});
