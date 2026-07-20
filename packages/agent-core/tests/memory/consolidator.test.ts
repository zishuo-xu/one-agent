import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from '../../src/db/connection.js';
import { MessageStore } from '../../src/db/messageStore.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { MemoryConsolidator } from '../../src/memory/MemoryConsolidator.js';
import { MemoryDocumentStore } from '../../src/memory/MemoryDocumentStore.js';
import type { MemoryExtractor } from '../../src/memory/MemoryExtractor.js';

describe('MemoryConsolidator', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-consolidator-'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('passes the complete visible conversation and writes both document scopes', async () => {
    const db = createConnection({ path: ':memory:' });
    const threads = new ThreadStore(db);
    const messages = new MessageStore(db);
    const thread = threads.create({ id: 'thread-1' });
    messages.save(thread.id, { role: 'assistant', content: 'Use pnpm?' });
    messages.save(thread.id, { role: 'user', content: '可以，我认同。' });
    const extract = vi.fn(async () => ({
      global: '# Global Memory\n\n- User prefers Chinese.\n',
      workspace: '# Workspace Memory\n\n- Use pnpm.\n',
    }));
    const documents = new MemoryDocumentStore({ workspaceRoot: root, globalRoot: root });
    const consolidator = new MemoryConsolidator(db, {
      documentStore: documents,
      extractor: { model: 'test', extract } as unknown as MemoryExtractor,
    });

    const result = await consolidator.consolidateThread(thread.id);

    expect(extract.mock.calls[0][0].map((message: { role: string }) => message.role))
      .toEqual(['assistant', 'user']);
    expect(result.changedScopes).toEqual(['global', 'workspace']);
    expect(documents.read('workspace').content).toContain('Use pnpm');
    expect(threads.getById(thread.id)?.memoryExtracted).toBe(true);
    db.close();
  });

  it('leaves failed work unextracted for startup recovery', async () => {
    const db = createConnection({ path: ':memory:' });
    const threads = new ThreadStore(db);
    const messages = new MessageStore(db);
    const thread = threads.create({ id: 'thread-retry' });
    messages.save(thread.id, { role: 'user', content: 'Remember this.' });
    const documents = new MemoryDocumentStore({ workspaceRoot: root, globalRoot: root });
    const failed = new MemoryConsolidator(db, {
      documentStore: documents,
      extractor: { model: 'test', extract: vi.fn(async () => { throw new Error('timeout'); }) } as unknown as MemoryExtractor,
    });
    expect((await failed.consolidateThread(thread.id)).status).toBe('failed');
    expect(threads.getById(thread.id)?.memoryExtracted).toBe(false);

    const recovered = new MemoryConsolidator(db, {
      documentStore: documents,
      extractor: { model: 'test', extract: vi.fn(async (_m, current) => current) } as unknown as MemoryExtractor,
    });
    expect((await recovered.recoverUnextracted())[0].status).toBe('completed');
    expect(threads.getById(thread.id)?.memoryExtracted).toBe(true);
    db.close();
  });
});
