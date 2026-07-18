import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CreateMemoryInput } from '../../src/db/types.js';
import { createConnection } from '../../src/db/connection.js';
import { MemoryStore, type MemoryRecallOutcome } from '../../src/db/memoryStore.js';

interface MemoryRecallEvalCase {
  id: string;
  query: string;
  threadId?: string;
  limit?: number;
  memories: CreateMemoryInput[];
  expectedSelectedKeys: string[];
  expectedOutcomes?: Record<string, MemoryRecallOutcome>;
}

interface MemoryRecallEvalDataset {
  version: string;
  cases: MemoryRecallEvalCase[];
}

const datasetPath = new URL('../../memory-eval-datasets/recall-v1.json', import.meta.url);
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as MemoryRecallEvalDataset;

describe(`memory recall eval: ${dataset.version}`, () => {
  for (const scenario of dataset.cases) {
    it(scenario.id, () => {
      const db = createConnection({ path: ':memory:' });
      const store = new MemoryStore(db);
      for (const memory of scenario.memories) store.create(memory);

      const recall = store.recallRelevantMemories(scenario.query, {
        threadId: scenario.threadId,
        limit: scenario.limit,
      });

      expect(recall.memories.map((memory) => memory.key)).toEqual(scenario.expectedSelectedKeys);
      const outcomes = new Map(recall.report.candidates.map((candidate) => [candidate.key, candidate.outcome]));
      for (const [key, expected] of Object.entries(scenario.expectedOutcomes ?? {})) {
        expect(outcomes.get(key), `${scenario.id}: ${key}`).toBe(expected);
      }
      db.close();
    });
  }
});
