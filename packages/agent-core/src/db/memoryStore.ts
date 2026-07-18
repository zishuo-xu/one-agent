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
  kind: Memory['kind'];
  explicit: number;
  source_message_id: string | null;
  observed_at: string | null;
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
    kind: row.kind,
    explicit: row.explicit === 1,
    sourceMessageId: row.source_message_id,
    observedAt: row.observed_at ?? row.created_at,
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

export type MemoryRecallOutcome =
  | 'selected'
  | 'filtered_inactive'
  | 'filtered_expired'
  | 'filtered_scope'
  | 'filtered_limit';

export interface MemoryRecallCandidate {
  memoryId: string;
  key: string;
  kind: Memory['kind'];
  scope: Memory['scope'];
  status: Memory['status'];
  matchedKeywords: string[];
  explicit: boolean;
  confidence: number;
  observedAt: string;
  outcome: MemoryRecallOutcome;
}

export interface MemoryRecallReport {
  keywords: string[];
  skipReason?: 'no_keywords' | 'limit_zero';
  candidateCount: number;
  selectedCount: number;
  candidates: MemoryRecallCandidate[];
}

export interface MemoryRecallResult {
  memories: Memory[];
  report: MemoryRecallReport;
}

export interface RememberResult {
  memory: Memory;
  action: 'created' | 'reinforced' | 'superseded' | 'rejected';
  previousMemoryId?: string;
}

export interface ForgetMemoryInput {
  key: string;
  scope?: Memory['scope'];
  threadId?: string;
  source?: string;
  sourceRunId?: string;
  observedAt?: string;
}

export interface ForgetMemoryResult {
  action: 'forgotten' | 'already_forgotten' | 'not_found';
  memory?: Memory;
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

function normalizeObservedAt(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError('observedAt must be a valid date');
  return new Date(time).toISOString();
}

function comparePrecedence(candidate: CreateMemoryInput, existing: Memory): number {
  const observedDifference = Date.parse(normalizeObservedAt(candidate.observedAt)) - Date.parse(existing.observedAt);
  if (observedDifference !== 0) return observedDifference;
  const explicitDifference = Number(candidate.explicit ?? false) - Number(existing.explicit);
  if (explicitDifference !== 0) return explicitDifference;
  const confidenceDifference = normalizeConfidence(candidate.confidence) - existing.confidence;
  if (confidenceDifference !== 0) return confidenceDifference;
  return (candidate.sourceMessageId ?? '').localeCompare(existing.sourceMessageId ?? '');
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
    const observedAt = normalizeObservedAt(input.observedAt);

    this.db
      .prepare(
        `INSERT INTO memories (
           id, key, value, source, thread_id, scope, source_run_id, confidence,
           status, expires_at, last_used_at, superseded_by_id, kind, explicit,
           source_message_id, observed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
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
        input.kind ?? 'fact',
        input.explicit ? 1 : 0,
        input.sourceMessageId ?? null,
        observedAt,
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
      const observedAt = normalizeObservedAt(input.observedAt);
      const governedInput = { ...input, key, value, scope, confidence, observedAt };
      const existing = this.findGoverningByKey(key, scope, input.threadId);

      if (!existing) {
        return { memory: this.create(governedInput), action: 'created' };
      }

      if (
        existing.status === 'active' &&
        normalizeText(existing.value).toLocaleLowerCase() === value.toLocaleLowerCase()
      ) {
        const newer = comparePrecedence(governedInput, existing) >= 0;
        const memory = newer
          ? this.update(existing.id, {
              source: input.source ?? existing.source,
              threadId: input.threadId ?? existing.threadId,
              sourceRunId: input.sourceRunId ?? existing.sourceRunId,
              confidence: Math.max(existing.confidence, confidence),
              expiresAt: input.expiresAt ?? existing.expiresAt,
              status: 'active',
              kind: input.kind ?? existing.kind,
              explicit: input.explicit ?? existing.explicit,
              sourceMessageId: input.sourceMessageId ?? existing.sourceMessageId,
              observedAt,
            })
          : existing;
        return { memory, action: 'reinforced', previousMemoryId: existing.id };
      }

      if (comparePrecedence(governedInput, existing) < 0) {
        const memory = this.create({
          ...governedInput,
          status: 'superseded',
          supersededById: existing.id,
        });
        return { memory, action: 'rejected', previousMemoryId: existing.id };
      }

      const memory = this.create(governedInput);
      this.update(existing.id, {
        status: existing.status === 'forgotten' ? 'forgotten' : 'superseded',
        supersededById: memory.id,
      });
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
    return this.recallRelevantMemories(query, limitOrOptions).memories;
  }

  /** Retrieve memories together with a value-free explanation suitable for Trace. */
  recallRelevantMemories(
    query: string,
    limitOrOptions: number | RelevantMemoryOptions = 5,
  ): MemoryRecallResult {
    const options = typeof limitOrOptions === 'number'
      ? { limit: limitOrOptions }
      : limitOrOptions;
    const limit = options.limit ?? 5;
    const keywords = extractKeywords(query);
    if (keywords.length === 0 || limit <= 0) {
      return {
        memories: [],
        report: {
          keywords,
          skipReason: limit <= 0 ? 'limit_zero' : 'no_keywords',
          candidateCount: 0,
          selectedCount: 0,
          candidates: [],
        },
      };
    }

    this.expireDue();
    const keywordConditions: string[] = [];
    const values: unknown[] = [];
    for (const word of keywords) {
      keywordConditions.push('(key LIKE ? OR value LIKE ?)');
      values.push(`%${word}%`, `%${word}%`);
    }

    const sql = `SELECT * FROM memories
      WHERE ${keywordConditions.join(' OR ')}
      ORDER BY explicit DESC, confidence DESC, observed_at DESC, updated_at DESC`;
    const rows = this.db.prepare(sql).all(...values) as MemoryRow[];
    const nowMs = Date.now();
    const selected: Memory[] = [];
    const candidates = rows.map((row): MemoryRecallCandidate => {
      const memory = rowToMemory(row);
      let outcome: MemoryRecallOutcome;
      if (memory.status === 'expired' || (memory.expiresAt && Date.parse(memory.expiresAt) <= nowMs)) {
        outcome = 'filtered_expired';
      } else if (memory.status !== 'active') {
        outcome = 'filtered_inactive';
      } else if (memory.scope === 'thread' && memory.threadId !== options.threadId) {
        outcome = 'filtered_scope';
      } else if (selected.length >= limit) {
        outcome = 'filtered_limit';
      } else {
        outcome = 'selected';
        selected.push(memory);
      }
      const searchable = `${memory.key}\n${memory.value}`.toLocaleLowerCase();
      return {
        memoryId: memory.id,
        key: memory.key,
        kind: memory.kind,
        scope: memory.scope,
        status: memory.status,
        matchedKeywords: keywords.filter((keyword) => searchable.includes(keyword.toLocaleLowerCase())),
        explicit: memory.explicit,
        confidence: memory.confidence,
        observedAt: memory.observedAt,
        outcome,
      };
    });
    if (selected.length === 0) {
      return {
        memories: [],
        report: {
          keywords,
          candidateCount: candidates.length,
          selectedCount: 0,
          candidates,
        },
      };
    }
    const usedAt = new Date().toISOString();
    const placeholders = selected.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE memories SET last_used_at = ? WHERE id IN (${placeholders})`)
      .run(usedAt, ...selected.map((memory) => memory.id));
    return {
      memories: selected.map((memory) => ({ ...memory, lastUsedAt: usedAt })),
      report: {
        keywords,
        candidateCount: candidates.length,
        selectedCount: selected.length,
        candidates,
      },
    };
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
    if (updates.kind !== undefined) {
      sets.push('kind = ?');
      values.push(updates.kind);
    }
    if (updates.explicit !== undefined) {
      sets.push('explicit = ?');
      values.push(updates.explicit ? 1 : 0);
    }
    if (updates.sourceMessageId !== undefined) {
      sets.push('source_message_id = ?');
      values.push(updates.sourceMessageId);
    }
    if (updates.observedAt !== undefined) {
      sets.push('observed_at = ?');
      values.push(normalizeObservedAt(updates.observedAt));
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

  /**
   * Soft-forget an exact memory key and keep a value-free tombstone.
   * The tombstone participates in precedence checks, so delayed extraction
   * from an older conversation cannot silently recreate forgotten content.
   */
  forget(input: ForgetMemoryInput): ForgetMemoryResult {
    const key = normalizeText(input.key);
    if (!key) throw new TypeError('memory key cannot be empty');
    const scope = input.scope ?? 'global';
    const observedAt = normalizeObservedAt(input.observedAt);
    const existing = this.findGoverningByKey(key, scope, input.threadId);
    if (!existing) return { action: 'not_found' };
    if (existing.status === 'forgotten') {
      if (Date.parse(observedAt) > Date.parse(existing.observedAt)) {
        return {
          action: 'already_forgotten',
          memory: this.update(existing.id, {
            observedAt,
            explicit: true,
            source: input.source ?? existing.source,
            sourceRunId: input.sourceRunId ?? existing.sourceRunId,
          }),
        };
      }
      return { action: 'already_forgotten', memory: existing };
    }
    return {
      action: 'forgotten',
      memory: this.update(existing.id, {
        value: '[forgotten]',
        status: 'forgotten',
        explicit: true,
        confidence: 1,
        source: input.source ?? existing.source,
        sourceRunId: input.sourceRunId ?? existing.sourceRunId,
        observedAt,
      }),
    };
  }

  private findGoverningByKey(
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
           WHERE status IN ('active', 'forgotten')
             AND scope = 'global' AND lower(trim(key)) = lower(?)
           ORDER BY observed_at DESC, updated_at DESC LIMIT 1`,
        ).get(key)
      : this.db.prepare(
          `SELECT * FROM memories
           WHERE status IN ('active', 'forgotten')
             AND scope = 'thread' AND thread_id = ? AND lower(trim(key)) = lower(?)
           ORDER BY observed_at DESC, updated_at DESC LIMIT 1`,
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
