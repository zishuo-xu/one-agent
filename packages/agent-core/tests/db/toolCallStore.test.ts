import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { ToolCallStore } from '../../src/db/toolCallStore.js';
import { RunStore } from '../../src/db/runStore.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { ToolCall, ToolResult } from '../../src/tools/types.js';

describe('ToolCallStore', () => {
  let db: Database.Database;
  let threadStore: ThreadStore;
  let runStore: RunStore;
  let store: ToolCallStore;
  let runId: string;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    threadStore = new ThreadStore(db);
    runStore = new RunStore(db);
    store = new ToolCallStore(db);
    const threadId = threadStore.create({ id: 'thread-1' }).id;
    runId = runStore.create({ threadId, model: 'gpt-test' }).id;
  });

  it('saves a successful tool call', () => {
    const toolCall: ToolCall = { id: 'call-1', name: 'read_file', arguments: { path: 'test.txt' } };
    const result: ToolResult = { success: true, data: 'content' };
    const saved = store.create({ runId, toolCall, result });

    expect(saved.runId).toBe(runId);
    expect(saved.name).toBe('read_file');
    expect(saved.success).toBe(true);
    expect(saved.arguments).toContain('test.txt');
    expect(saved.result).toContain('content');
  });

  it('saves a failed tool call', () => {
    const toolCall: ToolCall = { id: 'call-2', name: 'write_file', arguments: {} };
    const result: ToolResult = { success: false, error: 'Access denied' };
    const saved = store.create({ runId, toolCall, result });

    expect(saved.success).toBe(false);
    expect(saved.result).toContain('Access denied');
  });

  it('lists tool calls by run', () => {
    const first: ToolCall = { id: 'call-1', name: 'list_files', arguments: {} };
    const second: ToolCall = { id: 'call-2', name: 'get_time', arguments: {} };
    store.create({ runId, toolCall: first, result: { success: true } });
    store.create({ runId, toolCall: second, result: { success: true } });

    const calls = store.getByRun(runId);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('list_files');
    expect(calls[1].name).toBe('get_time');
  });

  it('deletes tool calls by run', () => {
    const toolCall: ToolCall = { id: 'call-1', name: 'read_file', arguments: {} };
    const saved = store.create({ runId, toolCall, result: { success: true } });
    store.deleteByRun(runId);
    expect(store.getById(saved.id)).toBeUndefined();
  });
});
