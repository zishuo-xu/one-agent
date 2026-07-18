import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Memory, CreateMemoryInput } from './types.js';

interface MemoryRow {
  id: string;
  key: string;
  value: string;
  source: string | null;
  thread_id: string | null;
  scope: Memory['scope'];
  source_run_id: string | null;
  confidence: number;
  status: Memory['status'];
  expires_at: string | null;
  last_used_at: string | null;
  superseded_by_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    source: row.source,
    threadId: row.thread_id,
    scope: row.scope,
    sourceRunId: row.source_run_id,
    confidence: row.confidence,
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    supersededById: row.superseded_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MemoryListOptions {
  status?: Memory['status'];
  scope?: Memory['scope'];
  threadId?: string;
}

export interface RelevantMemoryOptions {
  limit?: number;
  threadId?: string;
}

export interface RememberResult {
  memory: Memory;
  action: 'created' | 'reinforced' | 'superseded' | 'rejected';
  previousMemoryId?: string;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeConfidence(value = 0.7): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('memory confidence must be between 0 and 1');
  }
  return value;
}

function normalizeOptionalDate(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError('expiresAt must be a valid date');
  return new Date(time).toISOString();
}

// Basic English/Chinese stop words to reduce noisy LIKE queries.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'about',
  'as', 'by', 'from', 'that', 'this', 'it', 'its', 'i', 'you', 'he',
  'she', 'we', 'they', 'my', 'your', 'his', 'her', 'our', 'their',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'can', 'could',
  '的', '了', '在', '是', '我', '你', '他', '她', '我们', '你们', '他们',
  '和', '或', '与', '对', '为', '有', '没有', '不', '也', '就', '都',
]);

/** Single CJK characters that carry no retrieval signal on their own. */
const CJK_STOP_CHARS = new Set([
  '的', '了', '在', '是', '我', '你', '他', '她', '和', '或',
  '与', '对', '为', '有', '不', '也', '就', '都',
]);

const CJK_RUN_PATTERN = /[一-龥]+/g;

function extractKeywords(query: string): string[] {
  const cleaned = query.toLowerCase().replace(/[^一-龥a-z0-9\s]/g, ' ');
  const keywords = new Set<string>();
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    // Latin/digit fragments keep the original whole-word behavior.
    for (const word of token.split(/[一-龥]+/)) {
      if (word.length >= 2 && !STOP_WORDS.has(word)) {
        keywords.add(word);
      }
    }
    // Unsegmented Chinese has no spaces: index CJK runs as sliding bigrams
    // so LIKE substring matching can hit Chinese memory keys (a whole
    // sentence as one keyword would never match).
    for (const run of token.match(CJK_RUN_PATTERN) ?? []) {
      for (let i = 0; i < run.length - 1; i++) {
        const bigram = run.slice(i, i + 2);
        if (STOP_WORDS.has(bigram)) continue;
        if (CJK_STOP_CHARS.has(bigram[0]) && CJK_STOP_CHARS.has(bigram[1])) continue;
        keywords.add(bigram);
      }
    }
  }
  return Array.from(keywords);
}

export class MemoryStore {
  constructor(private db: Database.Database) {}

  create(input: CreateMemoryInput): Memory {
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const key = normalizeText(input.key);
    const value = normalizeText(input.value);
    const scope = input.scope ?? 'global';
    if (!key || !value) throw new TypeError('memory key and value cannot be empty');
    if (scope === 'thread' && !input.threadId) {
      throw new TypeError('thread-scoped memory requires threadId');
    }
    const confidence = normalizeConfidence(input.confidence);
    const expiresAt = normalizeOptionalDate(input.expiresAt);

    this.db
      .prepare(
        `INSERT INTO memories (
           id, key, value, source, thread_id, scope, source_run_id, confidence,
           status, expires_at, last_used_at, superseded_by_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        id,
        key,
        value,
        input.source ?? null,
        input.threadId ?? null,
        scope,
        input.sourceRunId ?? null,
        confidence,
        input.status ?? 'active',
        expiresAt ?? null,
        input.supersededById ?? null,
        now,
        now
      );

    return this.getById(id)!;
  }

  /** Store a fact under a deterministic conflict policy. */
  remember(input: CreateMemoryInput): RememberResult {
    const transaction = this.db.transaction((): RememberResult => {
      this.expireDue();
      const key = normalizeText(input.key);
      const value = normalizeText(input.value);
      if (!key || !value) throw new TypeError('memory key and value cannot be empty');
      const scope = input.scope ?? 'global';
      const confidence = normalizeConfidence(input.confidence);
      const existing = this.findActiveByKey(key, scope, input.threadId);

      if (!existing) {
        return { memory: this.create({ ...input, key, value, scope, confidence }), action: 'created' };
      }

      if (normalizeText(existing.value).toLocaleLowerCase() === value.toLocaleLowerCase()) {
        const memory = this.update(existing.id, {
          source: input.source ?? existing.source,
          threadId: input.threadId ?? existing.threadId,
          sourceRunId: input.sourceRunId ?? existing.sourceRunId,
          confidence: Math.max(existing.confidence, confidence),
          expiresAt: input.expiresAt ?? existing.expiresAt,
          status: 'active',
        });
        return { memory, action: 'reinforced', previousMemoryId: existing.id };
      }

      if (confidence < existing.confidence) {
        const memory = this.create({
          ...input,
          key,
          value,
          scope,
          confidence,
          status: 'superseded',
          supersededById: existing.id,
        });
        return { memory, action: 'rejected', previousMemoryId: existing.id };
      }

      const memory = this.create({ ...input, key, value, scope, confidence });
      this.update(existing.id, { status: 'superseded', supersededById: memory.id });
      return { memory, action: 'superseded', previousMemoryId: existing.id };
    });
    return transaction();
  }

  getById(id: string): Memory | undefined {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  list(options: MemoryListOptions = {}): Memory[] {
    this.expireDue();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (options.status) {
      conditions.push('status = ?');
      values.push(options.status);
    }
    if (options.scope) {
      conditions.push('scope = ?');
      values.push(options.scope);
    }
    if (options.threadId) {
      conditions.push('thread_id = ?');
      values.push(options.threadId);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM memories${where} ORDER BY updated_at DESC`)
      .all(...values) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  getRelevantMemories(query: string, limitOrOptions: number | RelevantMemoryOptions = 5): Memory[] {
    const options = typeof limitOrOptions === 'number'
      ? { limit: limitOrOptions }
      : limitOrOptions;
    const limit = options.limit ?? 5;
    const keywords = extractKeywords(query);
    if (keywords.length === 0 || limit <= 0) {
      return [];
    }

    this.expireDue();
    const keywordConditions: string[] = [];
    const values: unknown[] = [new Date().toISOString()];
    for (const word of keywords) {
      keywordConditions.push('(key LIKE ? OR value LIKE ?)');
      values.push(`%${word}%`, `%${word}%`);
    }
    const scopeCondition = options.threadId
      ? `(scope = 'global' OR (scope = 'thread' AND thread_id = ?))`
      : `scope = 'global'`;
    if (options.threadId) values.push(options.threadId);
    values.push(limit);

    const sql = `SELECT * FROM memories
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
        AND (${keywordConditions.join(' OR ')})
        AND ${scopeCondition}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?`;
    const rows = this.db.prepare(sql).all(...values) as MemoryRow[];
    if (rows.length === 0) return [];
    const usedAt = new Date().toISOString();
    const placeholders = rows.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE memories SET last_used_at = ? WHERE id IN (${placeholders})`)
      .run(usedAt, ...rows.map((row) => row.id));
    return rows.map((row) => ({ ...rowToMemory(row), lastUsedAt: usedAt }));
  }

  update(id: string, updates: Partial<Omit<Memory, 'id' | 'createdAt'>>): Memory {
    const existing = this.getById(id);
    if (!existing) throw new Error(`memory not found: ${id}`);
    const resultingScope = updates.scope ?? existing.scope;
    const resultingThreadId = updates.threadId !== undefined ? updates.threadId : existing.threadId;
    if (resultingScope === 'thread' && !resultingThreadId) {
      throw new TypeError('thread-scoped memory requires threadId');
    }
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.key !== undefined) {
      const key = normalizeText(updates.key);
      if (!key) throw new TypeError('memory key and value cannot be empty');
      sets.push('key = ?');
      values.push(key);
    }
    if (updates.value !== undefined) {
      const value = normalizeText(updates.value);
      if (!value) throw new TypeError('memory key and value cannot be empty');
      sets.push('value = ?');
      values.push(value);
    }
    if (updates.source !== undefined) {
      sets.push('source = ?');
      values.push(updates.source);
    }
    if (updates.threadId !== undefined) {
      sets.push('thread_id = ?');
      values.push(updates.threadId);
    }
    if (updates.scope !== undefined) {
      sets.push('scope = ?');
      values.push(updates.scope);
    }
    if (updates.sourceRunId !== undefined) {
      sets.push('source_run_id = ?');
      values.push(updates.sourceRunId);
    }
    if (updates.confidence !== undefined) {
      sets.push('confidence = ?');
      values.push(normalizeConfidence(updates.confidence));
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.expiresAt !== undefined) {
      sets.push('expires_at = ?');
      values.push(normalizeOptionalDate(updates.expiresAt));
    }
    if (updates.lastUsedAt !== undefined) {
      sets.push('last_used_at = ?');
      values.push(updates.lastUsedAt);
    }
    if (updates.supersededById !== undefined) {
      sets.push('superseded_by_id = ?');
      values.push(updates.supersededById);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id)!;
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM memories WHERE thread_id = ?').run(threadId);
  }

  private findActiveByKey(
    key: string,
    scope: Memory['scope'],
    threadId?: string,
  ): Memory | undefined {
    if (scope === 'thread' && !threadId) {
      throw new TypeError('thread-scoped memory requires threadId');
    }
    const row = scope === 'global'
      ? this.db.prepare(
          `SELECT * FROM memories
           WHERE status = 'active' AND scope = 'global' AND lower(trim(key)) = lower(?)
           ORDER BY updated_at DESC LIMIT 1`,
        ).get(key)
      : this.db.prepare(
          `SELECT * FROM memories
           WHERE status = 'active' AND scope = 'thread' AND thread_id = ? AND lower(trim(key)) = lower(?)
           ORDER BY updated_at DESC LIMIT 1`,
        ).get(threadId, key);
    return row ? rowToMemory(row as MemoryRow) : undefined;
  }

  private expireDue(): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE memories
       SET status = 'expired', updated_at = ?
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).run(now, now);
  }
}
