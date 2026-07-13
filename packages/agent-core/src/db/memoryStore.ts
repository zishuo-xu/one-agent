import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Memory, CreateMemoryInput } from './types.js';

interface MemoryRow {
  id: string;
  key: string;
  value: string;
  source: string | null;
  thread_id: string | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function extractKeywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w) && w.length >= 2);
  return Array.from(new Set(words));
}

export class MemoryStore {
  constructor(private db: Database.Database) {}

  create(input: CreateMemoryInput): Memory {
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memories (id, key, value, source, thread_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.key,
        input.value,
        input.source ?? null,
        input.threadId ?? null,
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): Memory | undefined {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  list(): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories ORDER BY updated_at DESC')
      .all() as MemoryRow[];
    return rows.map(rowToMemory);
  }

  getRelevantMemories(query: string, limit = 5): Memory[] {
    const keywords = extractKeywords(query);
    if (keywords.length === 0 || limit <= 0) {
      return [];
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    for (const word of keywords) {
      conditions.push('key LIKE ? OR value LIKE ?');
      values.push(`%${word}%`, `%${word}%`);
    }

    values.push(limit);

    const sql = `SELECT * FROM memories WHERE ${conditions.join(' OR ')} ORDER BY updated_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...values) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  update(id: string, updates: Partial<Omit<Memory, 'id' | 'createdAt'>>): Memory {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.key !== undefined) {
      sets.push('key = ?');
      values.push(updates.key);
    }
    if (updates.value !== undefined) {
      sets.push('value = ?');
      values.push(updates.value);
    }
    if (updates.source !== undefined) {
      sets.push('source = ?');
      values.push(updates.source);
    }
    if (updates.threadId !== undefined) {
      sets.push('thread_id = ?');
      values.push(updates.threadId);
    }

    if (sets.length === 0) return this.getById(id)!;

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
}
