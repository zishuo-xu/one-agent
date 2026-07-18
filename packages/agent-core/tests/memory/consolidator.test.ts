import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { MemoryStore } from '../../src/db/memoryStore.js';
import { MessageStore } from '../../src/db/messageStore.js';
import { ThreadStore } from '../../src/db/threadStore.js';
import { TraceEventStore } from '../../src/db/traceEventStore.js';
import { MemoryConsolidator } from '../../src/memory/MemoryConsolidator.js';
import type {
  ExtractedMemoryCandidate,
  MemoryExtractor,
  MemorySourceMessage,
} from '../../src/memory/MemoryExtractor.js';

describe('MemoryConsolidator', () => {
  let db: Database.Database;
  let threadStore: ThreadStore;
  let messageStore: MessageStore;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    threadStore = new ThreadStore(db);
    messageStore = new MessageStore(db);
    memoryStore = new MemoryStore(db);
  });

  function extractor(
    implementation: (messages: MemorySourceMessage[]) => Promise<unknown[]>,
  ): MemoryExtractor {
    return {
      model: 'memory-test',
      extract: vi.fn(implementation),
    } as unknown as MemoryExtractor;
  }

  it('processes the complete user side of one thread and marks it extracted', async () => {
    const thread = threadStore.create({ id: 'thread-1' });
    const first = messageStore.save(thread.id, { role: 'user', content: '我偏好中文回答' });
    messageStore.save(thread.id, { role: 'assistant', content: '好的' });
    const second = messageStore.save(thread.id, { role: 'user', content: '项目使用 pnpm' });
    threadStore.updateTimestamp(thread.id);
    const memoryExtractor = extractor(async (messages) => [{
      key: '回答语言偏好', value: '用户偏好中文回答', kind: 'user_preference',
      scope: 'global', confidence: 0.95, explicit: true, sourceMessageId: messages[0].id,
    }]);

    const result = await new MemoryConsolidator(db, {
      extractor: memoryExtractor,
      threadStore,
      messageStore,
      memoryStore,
    }).consolidateThread(thread.id);

    expect(result).toMatchObject({ status: 'completed', messageCount: 2, markedExtracted: true });
    expect(memoryExtractor.extract).toHaveBeenCalledWith([
      expect.objectContaining({ id: first.id, content: '我偏好中文回答' }),
      expect.objectContaining({ id: second.id, content: '项目使用 pnpm' }),
    ], []);
    expect(threadStore.getById(thread.id)?.memoryExtracted).toBe(true);
    expect(memoryStore.list()).toEqual([
      expect.objectContaining({
        sourceMessageId: first.id,
        observedAt: first.createdAt,
        source: 'memory_agent',
        explicit: true,
      }),
    ]);
    expect(new TraceEventStore(db).getByThread(thread.id).map((event) => event.eventType)).toEqual([
      'memory_consolidation_started',
      'memory_consolidation_completed',
    ]);
  });

  it('does not mark a thread extracted when a new user message arrives during extraction', async () => {
    const thread = threadStore.create({ id: 'thread-changing' });
    messageStore.save(thread.id, { role: 'user', content: '第一条消息' });
    let finishExtraction!: (value: ExtractedMemoryCandidate[]) => void;
    const pendingExtraction = new Promise<ExtractedMemoryCandidate[]>((resolve) => {
      finishExtraction = resolve;
    });
    const consolidator = new MemoryConsolidator(db, {
      extractor: extractor(async () => pendingExtraction),
    });

    const consolidation = consolidator.consolidateThread(thread.id);
    await vi.waitFor(() => {
      expect(new TraceEventStore(db).getByThread(thread.id)).toHaveLength(1);
    });
    messageStore.save(thread.id, { role: 'user', content: '提取过程中新增的消息' });
    finishExtraction([]);

    const result = await consolidation;
    expect(result).toMatchObject({ status: 'completed', markedExtracted: false });
    expect(threadStore.getById(thread.id)?.memoryExtracted).toBe(false);
  });

  it('treats a valid empty result as successful extraction', async () => {
    const thread = threadStore.create({ id: 'thread-empty' });
    messageStore.save(thread.id, { role: 'user', content: '1+1等于几？' });
    threadStore.updateTimestamp(thread.id);

    const result = await new MemoryConsolidator(db, {
      extractor: extractor(async () => []),
    }).consolidateThread(thread.id);

    expect(result).toMatchObject({ status: 'completed', candidateCount: 0, markedExtracted: true });
    expect(memoryStore.list()).toEqual([]);
  });

  it('keeps a thread unextracted after failure so startup recovery can retry', async () => {
    const thread = threadStore.create({ id: 'thread-retry' });
    messageStore.save(thread.id, { role: 'user', content: '记住我使用 TypeScript' });
    threadStore.updateTimestamp(thread.id);
    const failing = extractor(async () => { throw new Error('model unavailable'); });

    const first = await new MemoryConsolidator(db, { extractor: failing }).consolidateThread(thread.id);
    expect(first.status).toBe('failed');
    expect(threadStore.getById(thread.id)?.memoryExtracted).toBe(false);

    const succeeding = extractor(async (messages) => [{
      key: '主要语言', value: 'TypeScript', kind: 'user_profile', scope: 'global',
      confidence: 0.9, explicit: true, sourceMessageId: messages[0].id,
    }]);
    const recovered = await new MemoryConsolidator(db, { extractor: succeeding }).recoverUnextracted();
    expect(recovered).toHaveLength(1);
    expect(threadStore.getById(thread.id)?.memoryExtracted).toBe(true);
  });

  it('does not let a late-processed old thread overwrite a newer fact', async () => {
    const oldThread = threadStore.create({ id: 'old-thread' });
    const oldMessage = messageStore.save(oldThread.id, { role: 'user', content: '我使用 npm' });
    threadStore.updateTimestamp(oldThread.id);
    const newThread = threadStore.create({ id: 'new-thread' });
    const newMessage = messageStore.save(newThread.id, { role: 'user', content: '我现在使用 pnpm' });
    threadStore.updateTimestamp(newThread.id);
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2026-07-01T00:00:00.000Z', oldMessage.id);
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2026-07-10T00:00:00.000Z', newMessage.id);

    const memoryExtractor = extractor(async (messages) => [{
      key: '包管理器',
      value: messages[0].content.includes('pnpm') ? 'pnpm' : 'npm',
      kind: 'user_preference', scope: 'global', confidence: 0.95, explicit: true,
      sourceMessageId: messages[0].id,
    }]);
    const consolidator = new MemoryConsolidator(db, { extractor: memoryExtractor });
    await consolidator.consolidateThread(newThread.id);
    await consolidator.consolidateThread(oldThread.id);

    expect(memoryStore.list({ status: 'active' })).toEqual([
      expect.objectContaining({ key: '包管理器', value: 'pnpm', observedAt: '2026-07-10T00:00:00.000Z' }),
    ]);
    expect(memoryStore.list({ status: 'superseded' })).toEqual([
      expect.objectContaining({ value: 'npm' }),
    ]);
  });

  it('rejects sensitive candidates while still completing the thread', async () => {
    const thread = threadStore.create({ id: 'thread-sensitive' });
    messageStore.save(thread.id, { role: 'user', content: '记住我的密码' });
    threadStore.updateTimestamp(thread.id);
    const result = await new MemoryConsolidator(db, {
      extractor: extractor(async (messages) => [{
        key: '用户密码', value: 'secret-value', kind: 'user_profile', scope: 'global',
        confidence: 1, explicit: true, sourceMessageId: messages[0].id,
      }]),
    }).consolidateThread(thread.id);

    expect(result).toMatchObject({ status: 'completed', rejectedCount: 1, writtenCount: 0 });
    expect(memoryStore.list()).toEqual([]);
  });

  it('does not duplicate an existing explicit memory with a shorter equivalent value', async () => {
    const thread = threadStore.create({ id: 'thread-explicit-dedup' });
    const source = messageStore.save(thread.id, {
      role: 'user',
      content: '请记住：我偏好使用中文交流。',
    });
    threadStore.updateTimestamp(thread.id);
    memoryStore.remember({
      key: 'language_preference',
      value: '用户偏好使用中文交流',
      kind: 'user_preference',
      scope: 'global',
      confidence: 1,
      explicit: true,
      source: 'explicit_user',
    });
    const memoryExtractor = extractor(async () => [{
      key: 'communication_language',
      value: '中文',
      evidence: '我偏好使用中文交流',
      kind: 'user_preference',
      scope: 'global',
      confidence: 0.95,
      explicit: true,
      sourceMessageId: source.id,
    }]);

    const result = await new MemoryConsolidator(db, {
      extractor: memoryExtractor,
    }).consolidateThread(thread.id);

    expect(result).toMatchObject({ writtenCount: 0, rejectedCount: 1, markedExtracted: true });
    expect(memoryStore.list({ status: 'active' })).toHaveLength(1);
    expect(memoryExtractor.extract).toHaveBeenCalledWith(
      expect.any(Array),
      [expect.objectContaining({ key: 'language_preference', explicit: true })],
    );
  });
});
