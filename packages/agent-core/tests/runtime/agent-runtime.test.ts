import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../../src/model/AnthropicProvider.js';
import { AgentRuntime } from '../../src/runtime/AgentRuntime.js';
import { createConnection } from '../../src/db/connection.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ModelCapabilities, ModelProvider } from '../../src/model/types.js';

function provider(capabilities: ModelCapabilities): ModelProvider {
  return {
    name: 'runtime-test',
    model: 'runtime-test-model',
    capabilities,
    complete: async () => ({ content: 'ok' }),
    stream: async function* () { yield { content: 'ok' }; },
  };
}

const FULL_CAPABILITIES: ModelCapabilities = {
  streaming: 'native',
  toolCalling: 'native',
  structuredOutput: 'native',
  reasoning: 'native',
};

describe('AgentRuntime', () => {
  it('provides one composition root for stores, memory and agent creation', () => {
    const db = createConnection({ path: ':memory:' });
    const runtime = new AgentRuntime({
      workspaceRoot: '/tmp/one-agent-runtime-test',
      db,
      tools: new ToolRegistry(),
    });
    const thread = runtime.stores.threads.create({ title: 'runtime test' });
    const agent = runtime.createAgent({ threadId: thread.id, planning: false });

    expect(runtime.stores.threads.getById(thread.id)?.title).toBe('runtime test');
    expect(agent.getHistory()[0]).toMatchObject({ role: 'system' });
    expect((agent as unknown as { toolRegistry: ToolRegistry }).toolRegistry.has('manage_memory'))
      .toBe(true);
    expect((agent as unknown as { toolRegistry: ToolRegistry }).toolRegistry.has('request_user_input'))
      .toBe(true);
    expect(runtime.tools.has('manage_memory')).toBe(false);
    expect(runtime.memory).toBeDefined();
    db.close();
  });

  it('fails before creating an agent when registered tools are not supported', () => {
    const db = createConnection({ path: ':memory:' });
    const runtime = new AgentRuntime({
      workspaceRoot: '/tmp/one-agent-runtime-capability-test',
      db,
      tools: new ToolRegistry(),
      modelProvider: provider({ ...FULL_CAPABILITIES, toolCalling: 'unsupported' }),
    });

    expect(() => runtime.createAgent({ planning: false })).toThrowError(
      /required capabilities not guaranteed: toolCalling/,
    );
    db.close();
  });

  it('rejects best-effort support for a hard runtime requirement', () => {
    const db = createConnection({ path: ':memory:' });
    const runtime = new AgentRuntime({
      workspaceRoot: '/tmp/one-agent-runtime-stream-test',
      db,
      tools: new ToolRegistry(),
      modelProvider: provider({ ...FULL_CAPABILITIES, streaming: 'best_effort' }),
    });

    expect(() => runtime.createAgent({ planning: false })).toThrowError(
      /required capabilities not guaranteed: streaming/,
    );
    db.close();
  });

  it('passes a capability-compatible pinned Provider into the AgentLoop', () => {
    const db = createConnection({ path: ':memory:' });
    const pinned = provider(FULL_CAPABILITIES);
    const runtime = new AgentRuntime({
      workspaceRoot: '/tmp/one-agent-runtime-provider-test',
      db,
      tools: new ToolRegistry(),
      modelProvider: pinned,
    });

    const agent = runtime.createAgent({ planning: false });

    expect((agent as unknown as { modelProvider: ModelProvider }).modelProvider).toBe(pinned);
    db.close();
  });

  it('accepts the native Anthropic adapter without Runtime-specific logic', () => {
    const db = createConnection({ path: ':memory:' });
    const anthropic = new AnthropicProvider(
      { messages: { create: async () => ({}) } } as unknown as Anthropic,
      'claude-runtime-test',
    );
    const runtime = new AgentRuntime({
      workspaceRoot: '/tmp/one-agent-runtime-anthropic-test',
      db,
      tools: new ToolRegistry(),
      modelProvider: anthropic,
    });

    const agent = runtime.createAgent({ planning: false });

    expect((agent as unknown as { modelProvider: ModelProvider }).modelProvider).toBe(anthropic);
    db.close();
  });
});
