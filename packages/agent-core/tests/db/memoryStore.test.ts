import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConnection } from '../../src/db/connection.js';
import { MemoryStore } from '../../src/db/memoryStore.js';

describe('MemoryStore', () => {
  let db: Database.Database;
  let store: MemoryStore;

  beforeEach(() => {
    db = createConnection({ path: ':memory:' });
    store = new MemoryStore(db);
  });

  it('creates and retrieves a memory', () => {
    const memory = store.create({ key: 'language', value: 'Chinese', source: 'test' });
    expect(memory.key).toBe('language');
    expect(memory.value).toBe('Chinese');
    expect(memory.source).toBe('test');
    expect(memory.scope).toBe('global');
    expect(memory.confidence).toBe(0.7);
    expect(memory.status).toBe('active');
    expect(memory.kind).toBe('fact');
    expect(memory.explicit).toBe(false);
    expect(memory.observedAt).toBeDefined();

    const found = store.getById(memory.id);
    expect(found).toEqual(memory);
  });

  it('lists all memories ordered by updated_at desc', () => {
    const first = store.create({ key: 'a', value: '1' });
    const second = store.create({ key: 'b', value: '2' });

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(second.id);
    expect(list[1].id).toBe(first.id);
  });

  it('retrieves relevant memories by keyword', () => {
    const m1 = store.create({ key: 'preferred language', value: 'Chinese' });
    store.create({ key: 'project stack', value: 'TypeScript' });
    const m3 = store.create({ key: 'timezone', value: 'Beijing' });

    const relevant = store.getRelevantMemories('What language do I prefer?');
    const ids = relevant.map((m) => m.id);
    expect(ids).toContain(m1.id);
    expect(ids).not.toContain(m3.id);
  });

  it('retrieves relevant memories from unsegmented Chinese queries via bigrams', () => {
    const m1 = store.create({ key: '最喜欢的编程语言', value: 'Rust' });
    store.create({ key: '时区', value: '北京' });

    // The F11 scenario: a full Chinese sentence with no spaces must still hit.
    const relevant = store.getRelevantMemories('我最喜欢的编程语言是什么？');
    const ids = relevant.map((m) => m.id);
    expect(ids).toContain(m1.id);
  });

  it('does not match irrelevant Chinese memories', () => {
    store.create({ key: '时区', value: '北京' });
    const relevant = store.getRelevantMemories('我最喜欢的编程语言是什么？');
    expect(relevant).toEqual([]);
  });

  it('returns empty array for irrelevant or short queries', () => {
    store.create({ key: 'language', value: 'Chinese' });
    expect(store.getRelevantMemories('is it')).toEqual([]);
    expect(store.getRelevantMemories('a', 0)).toEqual([]);
  });

  it('updates a memory', () => {
    const memory = store.create({ key: 'language', value: 'Chinese' });
    store.update(memory.id, { value: 'Mandarin' });

    const found = store.getById(memory.id)!;
    expect(found.value).toBe('Mandarin');
    expect(found.key).toBe('language');
  });

  it('reinforces the same fact instead of creating a duplicate', () => {
    const first = store.remember({ key: ' language ', value: 'Chinese', confidence: 0.6 });
    const second = store.remember({
      key: 'language',
      value: ' chinese ',
      confidence: 0.9,
      sourceRunId: 'run-2',
    });

    expect(second.action).toBe('reinforced');
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.confidence).toBe(0.9);
    expect(second.memory.sourceRunId).toBe('run-2');
    expect(store.list()).toHaveLength(1);
  });

  it('supersedes an active fact with an equally or more confident conflict', () => {
    const oldFact = store.remember({
      key: 'timezone', value: 'Shanghai', confidence: 0.7,
      observedAt: '2026-07-01T00:00:00.000Z',
    });
    const result = store.remember({
      key: 'timezone', value: 'Tokyo', confidence: 0.8,
      observedAt: '2026-07-10T00:00:00.000Z',
    });

    expect(result.action).toBe('superseded');
    expect(result.memory.status).toBe('active');
    expect(store.getById(oldFact.memory.id)).toMatchObject({
      status: 'superseded',
      supersededById: result.memory.id,
    });
    expect(store.list({ status: 'active' })).toHaveLength(1);
  });

  it('keeps the stronger active fact when a lower-confidence conflict arrives', () => {
    const strong = store.remember({
      key: 'timezone', value: 'Shanghai', confidence: 0.9,
      observedAt: '2026-07-10T00:00:00.000Z',
    });
    const weak = store.remember({
      key: 'timezone', value: 'Tokyo', confidence: 0.4,
      observedAt: '2026-07-01T00:00:00.000Z',
    });

    expect(weak.action).toBe('rejected');
    expect(weak.memory).toMatchObject({ status: 'superseded', supersededById: strong.memory.id });
    expect(store.list({ status: 'active' }).map((memory) => memory.id)).toEqual([strong.memory.id]);
  });

  it('expires due memories before conflict checks and retrieval', () => {
    const expired = store.create({
      key: 'timezone',
      value: 'Shanghai',
      confidence: 1,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const replacement = store.remember({ key: 'timezone', value: 'Tokyo', confidence: 0.2 });

    expect(replacement.action).toBe('created');
    expect(store.getById(expired.id)?.status).toBe('expired');
    expect(store.getRelevantMemories('timezone').map((memory) => memory.id)).toEqual([
      replacement.memory.id,
    ]);
  });

  it('isolates thread-scoped recall while keeping global recall cross-thread', () => {
    const global = store.create({ key: 'preferred language', value: 'Chinese' });
    const local = store.create({
      key: 'project language',
      value: 'Rust',
      scope: 'thread',
      threadId: 'thread-1',
    });

    const sameThread = store.getRelevantMemories('language', { threadId: 'thread-1' });
    expect(sameThread.map((memory) => memory.id)).toEqual(expect.arrayContaining([global.id, local.id]));
    expect(store.getRelevantMemories('language', { threadId: 'thread-2' }).map((memory) => memory.id))
      .toEqual([global.id]);
    expect(store.getRelevantMemories('language').map((memory) => memory.id)).toEqual([global.id]);
    expect(store.getById(global.id)?.lastUsedAt).not.toBeNull();
  });

  it('explains selected and filtered recall candidates without exposing values', () => {
    const selected = store.create({
      key: 'preferred language', value: 'Chinese', explicit: true, confidence: 0.95,
    });
    const limited = store.create({ key: 'project language', value: 'TypeScript', confidence: 0.5 });
    const scoped = store.create({
      key: 'local language', value: 'Rust', scope: 'thread', threadId: 'thread-other',
    });
    const inactive = store.create({
      key: 'old language', value: 'Go', status: 'superseded',
    });
    const expired = store.create({
      key: 'temporary language', value: 'Python', expiresAt: '2000-01-01T00:00:00.000Z',
    });

    const recall = store.recallRelevantMemories('preferred project local old temporary language', {
      threadId: 'thread-current',
      limit: 1,
    });

    expect(recall.memories.map((memory) => memory.id)).toEqual([selected.id]);
    expect(recall.report).toMatchObject({ candidateCount: 5, selectedCount: 1 });
    const outcomes = new Map(recall.report.candidates.map((candidate) => [candidate.memoryId, candidate]));
    expect(outcomes.get(selected.id)?.outcome).toBe('selected');
    expect(outcomes.get(limited.id)?.outcome).toBe('filtered_limit');
    expect(outcomes.get(scoped.id)?.outcome).toBe('filtered_scope');
    expect(outcomes.get(inactive.id)?.outcome).toBe('filtered_inactive');
    expect(outcomes.get(expired.id)?.outcome).toBe('filtered_expired');
    expect(outcomes.get(selected.id)?.matchedKeywords).toEqual(expect.arrayContaining(['preferred', 'language']));
    expect(JSON.stringify(recall.report)).not.toContain('Chinese');
  });

  it('explains why a query skipped recall', () => {
    expect(store.recallRelevantMemories('is it').report).toMatchObject({
      skipReason: 'no_keywords', candidateCount: 0, selectedCount: 0,
    });
    expect(store.recallRelevantMemories('language', 0).report).toMatchObject({
      skipReason: 'limit_zero', candidateCount: 0, selectedCount: 0,
    });
  });

  it('normalizes updates and rejects empty content', () => {
    const memory = store.create({ key: 'language', value: 'Chinese' });
    expect(store.update(memory.id, { value: '  Simplified   Chinese  ' }).value)
      .toBe('Simplified Chinese');
    expect(() => store.update(memory.id, { key: '   ' })).toThrow('cannot be empty');
  });

  it('deletes a memory by id', () => {
    const memory = store.create({ key: 'language', value: 'Chinese' });
    store.deleteById(memory.id);
    expect(store.getById(memory.id)).toBeUndefined();
  });

  it('optionally links a memory to a thread', () => {
    const memory = store.create({ key: 'language', value: 'Chinese', threadId: 'thread-1' });
    expect(memory.threadId).toBe('thread-1');
  });
});
