import { z } from 'zod';
import type { ToolDefinition } from '../tools/types.js';
import {
  MemoryDocumentStore,
  type MemoryDocumentScope,
  type MemoryDocumentContents,
} from './MemoryDocumentStore.js';

export const MANAGE_MEMORY_TOOL_NAME = 'manage_memory';

export const MANAGE_MEMORY_SYSTEM_INSTRUCTION =
  'When the user explicitly asks you to remember, correct, forget, or inspect long-term memory, ' +
  'use the manage_memory tool. Global memory is for stable cross-folder user preferences; workspace ' +
  'memory is for durable facts and decisions in the current folder. Do not call it for implicit facts; ' +
  'session-level memory consolidation handles those later. Never store credentials or secrets.';

export interface ManageMemoryToolOptions {
  documentStore: MemoryDocumentStore;
}

const actions = ['remember', 'correct', 'forget', 'inspect'] as const;
const sensitiveValuePattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]{12,}|\bghp_[A-Za-z0-9]{12,}|\bAKIA[A-Z0-9]{12,})/;

function replaceUnique(content: string, oldText: string, newText: string): string {
  const first = content.indexOf(oldText);
  if (first < 0) throw new Error('The exact memory text was not found. Inspect memory and retry.');
  if (content.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error('The memory text is ambiguous. Supply a longer exact fragment.');
  }
  return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
}

function appendExplicitMemory(content: string, text: string): string {
  if (content.includes(text)) return content;
  const heading = '## Explicit Memories';
  const bullet = `- ${text}`;
  if (content.includes(heading)) {
    return content.replace(heading, `${heading}\n\n${bullet}`);
  }
  return `${content.trimEnd()}\n\n${heading}\n\n${bullet}\n`;
}

/** Explicit user control over the same Markdown documents used by consolidation. */
export function createManageMemoryTool(options: ManageMemoryToolOptions): ToolDefinition {
  const { documentStore } = options;
  return {
    name: MANAGE_MEMORY_TOOL_NAME,
    description:
      'Manage user-visible Markdown memory only when explicitly requested. ' +
      'remember appends a concise literal statement. correct and forget require an exact existing text fragment. ' +
      'Use global for stable cross-folder user preferences and workspace for facts or decisions limited to this folder. ' +
      'inspect returns the latest documents. Never store credentials, secrets, temporary requests, or tool output.',
    parameters: z.object({
      action: z.enum(actions),
      scope: z.enum(['global', 'workspace']).optional(),
      text: z.string().optional().describe('Literal statement for remember, or replacement text for correct.'),
      oldText: z.string().optional().describe('Exact existing document fragment for correct or forget.'),
    }),
    execute: async (rawArgs) => {
      const args = rawArgs as {
        action: (typeof actions)[number];
        scope?: MemoryDocumentScope;
        text?: string;
        oldText?: string;
      };
      if (args.action === 'inspect') {
        const documents = args.scope
          ? [documentStore.read(args.scope)]
          : documentStore.readAll();
        return {
          action: 'inspected',
          documents: documents.map(({ scope, path, content, hash, updatedAt }) => ({
            scope, path, content, hash, updatedAt,
          })),
        };
      }

      const scope = args.scope ?? 'global';
      const text = args.text?.trim();
      const oldText = args.oldText?.trim();
      if (text && sensitiveValuePattern.test(text)) {
        throw new Error('Credentials and secrets cannot be stored in long-term memory.');
      }

      let changed = false;
      await documentStore.update((current) => {
        const next: MemoryDocumentContents = { ...current };
        const content = current[scope];
        if (args.action === 'remember') {
          if (!text) throw new Error('remember requires non-empty text.');
          next[scope] = appendExplicitMemory(content, text);
        } else if (args.action === 'correct') {
          if (!oldText || !text) throw new Error('correct requires oldText and text.');
          next[scope] = replaceUnique(content, oldText, text);
        } else {
          if (!oldText) throw new Error('forget requires oldText.');
          next[scope] = replaceUnique(content, oldText, '');
        }
        changed = next[scope] !== content;
        return next;
      });
      return {
        action: args.action,
        scope,
        changed,
        document: documentStore.read(scope),
      };
    },
  };
}
