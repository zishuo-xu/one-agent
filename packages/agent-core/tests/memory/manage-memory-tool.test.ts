import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManageMemoryTool } from '../../src/memory/manageMemoryTool.js';
import { MemoryDocumentStore } from '../../src/memory/MemoryDocumentStore.js';

describe('manage_memory tool', () => {
  let root: string;
  let store: MemoryDocumentStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-manage-memory-'));
    store = new MemoryDocumentStore({ workspaceRoot: root, globalRoot: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('remembers, corrects, forgets and inspects user-visible text', async () => {
    const tool = createManageMemoryTool({ documentStore: store });
    await tool.execute({ action: 'remember', scope: 'global', text: 'User prefers tea.' });
    expect(store.read('global').content).toContain('User prefers tea.');

    await tool.execute({
      action: 'correct', scope: 'global', oldText: 'User prefers tea.', text: 'User prefers coffee.',
    });
    expect(store.read('global').content).toContain('User prefers coffee.');

    await tool.execute({ action: 'forget', scope: 'global', oldText: '- User prefers coffee.\n' });
    expect(store.read('global').content).not.toContain('User prefers coffee.');

    const inspected = await tool.execute({ action: 'inspect' }) as { documents: unknown[] };
    expect(inspected.documents).toHaveLength(2);
  });

  it('rejects credentials', async () => {
    const tool = createManageMemoryTool({ documentStore: store });
    await expect(tool.execute({ action: 'remember', text: 'sk-abcdefghijklmnop' }))
      .rejects.toThrow('Credentials and secrets');
  });
});
