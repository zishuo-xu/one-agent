import { describe, expect, it } from 'vitest';
import type { Memory } from '@one-agent/agent-core';
import { formatMemoryDetail, formatMemoryList, resolveMemory } from '../src/commands/memory.js';

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'abcdef12-3456-7890',
    key: 'preferred language',
    value: 'Chinese',
    source: 'extracted',
    threadId: 'thread-1',
    scope: 'global',
    sourceRunId: 'run-1',
    confidence: 0.7,
    status: 'active',
    expiresAt: null,
    lastUsedAt: null,
    supersededById: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('memory CLI formatting', () => {
  it('lists active memory identity, scope, confidence, key, and value', () => {
    const output = formatMemoryList([memory()]).join('\n');
    expect(output).toContain('abcdef12');
    expect(output).toContain('global');
    expect(output).toContain('70%');
    expect(output).toContain('preferred language: Chinese');
  });

  it('shows governance metadata in memory detail', () => {
    const output = formatMemoryDetail(memory()).join('\n');
    expect(output).toContain('sourceRunId: run-1');
    expect(output).toContain('status: active');
    expect(output).toContain('confidence: 70%');
  });

  it('resolves exact or unique-prefix ids but rejects ambiguous prefixes', () => {
    const memories = [
      memory(),
      memory({ id: 'abc99999-0000' }),
    ];
    expect(resolveMemory(memories, 'abcdef12')?.id).toBe('abcdef12-3456-7890');
    expect(resolveMemory(memories, 'abc')).toBeUndefined();
    expect(resolveMemory(memories, 'missing')).toBeUndefined();
  });
});
