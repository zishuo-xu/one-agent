import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/runtime/AgentRuntime.js';
import { createConnection } from '../../src/db/connection.js';
import { ToolRegistry } from '../../src/tools/registry.js';

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
    expect(runtime.tools.has('manage_memory')).toBe(false);
    expect(runtime.memory).toBeDefined();
    db.close();
  });
});
