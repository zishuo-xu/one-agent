import type { Memory } from '@one-agent/agent-core';
import { shortId } from '../format.js';
import { sanitizeTerminalText } from '../output.js';

function preview(value: string, limit = 100): string {
  return sanitizeTerminalText(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function resolveMemory(memories: Memory[], idOrPrefix: string): Memory | undefined {
  const exact = memories.find((memory) => memory.id === idOrPrefix);
  if (exact) return exact;
  const matches = memories.filter((memory) => memory.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}

export function formatMemoryList(memories: Memory[], limit = 20): string[] {
  if (memories.length === 0) return ['No active memories.'];
  const lines = memories.slice(0, limit).map((memory) =>
    `${shortId(memory.id)}  ${memory.scope.padEnd(6)}  ${(memory.confidence * 100).toFixed(0).padStart(3)}%  ${preview(memory.key, 36)}: ${preview(memory.value, 72)}`,
  );
  if (memories.length > limit) lines.push(`… ${memories.length - limit} more memories`);
  return lines;
}

export function formatMemoryDetail(memory: Memory): string[] {
  return [
    `Memory ${memory.id}`,
    `  key: ${preview(memory.key, 200)}`,
    `  value: ${preview(memory.value, 400)}`,
    `  status: ${memory.status}`,
    `  scope: ${memory.scope}${memory.threadId ? ` (${memory.threadId})` : ''}`,
    `  confidence: ${(memory.confidence * 100).toFixed(0)}%`,
    `  kind: ${memory.kind}`,
    `  explicit: ${memory.explicit}`,
    `  source: ${memory.source ?? 'unknown'}`,
    `  sourceRunId: ${memory.sourceRunId ?? '-'}`,
    `  sourceMessageId: ${memory.sourceMessageId ?? '-'}`,
    `  observedAt: ${memory.observedAt}`,
    `  expiresAt: ${memory.expiresAt ?? '-'}`,
    `  lastUsedAt: ${memory.lastUsedAt ?? '-'}`,
    `  supersededById: ${memory.supersededById ?? '-'}`,
    `  updatedAt: ${memory.updatedAt}`,
  ];
}
