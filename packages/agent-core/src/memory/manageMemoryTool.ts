import { z } from 'zod';
import type { Memory } from '../db/types.js';
import type { MemoryStore } from '../db/memoryStore.js';
import type { ToolDefinition } from '../tools/types.js';

export const MANAGE_MEMORY_TOOL_NAME = 'manage_memory';

export const MANAGE_MEMORY_SYSTEM_INSTRUCTION =
  'When the user explicitly asks you to remember, correct, forget, or inspect long-term memory, ' +
  'use the manage_memory tool. Do not call it merely because a message contains an implicit durable fact; ' +
  'session-level memory consolidation handles implicit facts later. Never store credentials or secrets.';

export interface ManageMemoryToolOptions {
  memoryStore: MemoryStore;
  threadId?: string;
}

const actions = ['remember', 'correct', 'forget', 'inspect'] as const;
const kinds = [
  'user_profile',
  'user_preference',
  'project_rule',
  'durable_goal',
  'fact',
] as const;

const sensitiveKeyPattern =
  /(?:password|passcode|api[ _-]?key|access[ _-]?token|secret|credential|密码|口令|密钥|令牌)/i;
const sensitiveValuePattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]{12,}|\bghp_[A-Za-z0-9]{12,}|\bAKIA[A-Z0-9]{12,})/;

function visibleMemories(memories: Memory[], threadId?: string): Memory[] {
  return memories.filter(
    (memory) => memory.scope === 'global' || (memory.scope === 'thread' && memory.threadId === threadId),
  );
}

function publicMemory(memory: Memory) {
  return {
    id: memory.id,
    key: memory.key,
    value: memory.value,
    kind: memory.kind,
    scope: memory.scope,
    explicit: memory.explicit,
    observedAt: memory.observedAt,
  };
}

/** Explicit user control over long-term memory; implicit extraction remains session-level. */
export function createManageMemoryTool(options: ManageMemoryToolOptions): ToolDefinition {
  const { memoryStore, threadId } = options;
  return {
    name: MANAGE_MEMORY_TOOL_NAME,
    description:
      'Manage long-term memory only when the user explicitly asks to remember, correct, forget, ' +
      'or inspect it. Use a concise, stable key so later corrections target the same fact. ' +
      'remember/correct require key and value; forget requires the exact key; inspect may use query. ' +
      'Use global for cross-conversation facts and thread only for facts limited to this conversation. ' +
      'Never store passwords, API keys, tokens, secrets, credentials, temporary requests, or tool output.',
    parameters: z.object({
      action: z.enum(actions),
      key: z.string().optional().describe('Concise stable memory key; exact existing key for correction/forget.'),
      value: z.string().optional().describe('Durable memory value for remember/correct.'),
      kind: z.enum(kinds).optional(),
      scope: z.enum(['global', 'thread']).optional(),
      query: z.string().optional().describe('Optional search text for inspect.'),
      limit: z.number().int().min(1).max(20).optional().default(10),
    }),
    execute: (rawArgs) => {
      const args = rawArgs as {
        action: (typeof actions)[number];
        key?: string;
        value?: string;
        kind?: (typeof kinds)[number];
        scope?: Memory['scope'];
        query?: string;
        limit: number;
      };
      const scope = args.scope ?? 'global';
      if (scope === 'thread' && !threadId) {
        throw new Error('Thread-scoped memory requires a persisted thread.');
      }

      if (args.action === 'inspect') {
        const active = visibleMemories(memoryStore.list({ status: 'active' }), threadId)
          .filter((memory) => !args.scope || memory.scope === args.scope);
        const query = args.query?.trim();
        const recalled = query
          ? memoryStore.recallRelevantMemories(query, {
              limit: args.scope ? 20 : args.limit,
              threadId,
            }).memories
          : active.slice(0, args.limit);
        const matches = args.scope
          ? recalled.filter((memory) => memory.scope === args.scope).slice(0, args.limit)
          : recalled;
        return {
          action: 'inspected',
          memories: matches.map(publicMemory),
        };
      }

      const key = args.key?.trim();
      if (!key) throw new Error(`${args.action} requires a non-empty key.`);
      if (sensitiveKeyPattern.test(key)) {
        throw new Error('Credentials and secrets cannot be stored in long-term memory.');
      }

      if (args.action === 'forget') {
        const result = memoryStore.forget({
          key,
          scope,
          threadId: scope === 'thread' ? threadId : undefined,
          source: 'explicit_user',
        });
        return {
          action: result.action,
          memory: result.memory
            ? { id: result.memory.id, key: result.memory.key, scope: result.memory.scope }
            : undefined,
        };
      }

      const value = args.value?.trim();
      if (!value) throw new Error(`${args.action} requires a non-empty value.`);
      if (sensitiveValuePattern.test(value)) {
        throw new Error('Credentials and secrets cannot be stored in long-term memory.');
      }
      const result = memoryStore.remember({
        key,
        value,
        scope,
        threadId: scope === 'thread' ? threadId : undefined,
        source: 'explicit_user',
        confidence: 1,
        kind: args.kind ?? 'fact',
        explicit: true,
      });
      return {
        requestedAction: args.action,
        action: result.action,
        memory: publicMemory(result.memory),
        previousMemoryId: result.previousMemoryId,
      };
    },
  };
}
