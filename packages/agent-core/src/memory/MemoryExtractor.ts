import { config } from '../config.js';
import { modelName } from '../configAccess.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelProvider } from '../model/types.js';
import type { MemoryDocumentContents } from './MemoryDocumentStore.js';
import { z } from 'zod';

export interface MemorySourceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface MemoryExtractorOptions {
  systemPrompt?: string;
  model?: string;
  modelProvider?: ModelProvider;
  timeoutMs?: number;
  maxDocumentCharacters?: number;
}

const memoryDocumentEnvelopeSchema = z.object({
  globalMemory: z.string(),
  workspaceMemory: z.string(),
}).strict();

const CREDENTIAL_VALUE_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]{12,}|\bghp_[A-Za-z0-9]{12,}|\bAKIA[A-Z0-9]{12,})/;

/**
 * Session-level Memory Agent. Assistant messages provide referential context,
 * but only user-authored messages are authoritative evidence.
 */
export class MemoryExtractor {
  private readonly systemPrompt: string;
  private readonly modelProvider: ModelProvider;
  private readonly timeoutMs: number;
  private readonly maxDocumentCharacters: number;

  constructor(options: MemoryExtractorOptions = {}) {
    this.systemPrompt = options.systemPrompt ?? [
      'You maintain two concise, user-visible Markdown memory documents for a local agent runtime.',
      'Review one complete user-visible conversation together with the latest documents.',
      'Assistant messages provide context for references such as "I agree", but only user messages authorize a memory change.',
      'Put stable cross-workspace user preferences in globalMemory.',
      'Put durable facts, decisions, constraints and conventions for the current folder in workspaceMemory.',
      'Do not store temporary requests, unfinished speculation, general knowledge, assistant claims, tool output, credentials or secrets.',
      'Preserve existing unrelated content. Correct or remove existing content only when the user clearly changes or rejects it.',
      'Keep Markdown concise, readable and organized under headings. Do not add IDs, confidence scores, timestamps or hidden metadata.',
      'Return ONLY one JSON object with the complete updated documents:',
      '{"globalMemory":"# Global Memory\\n...","workspaceMemory":"# Workspace Memory\\n..."}',
      'If nothing changes, return the input documents unchanged.',
    ].join(' ');
    this.modelProvider = options.modelProvider ??
      (options.model
        ? new OpenAICompatibleProvider(config.openai, options.model)
        : config.utilityModelProvider ??
          config.modelProvider ??
          new OpenAICompatibleProvider(config.openai, modelName()));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxDocumentCharacters = options.maxDocumentCharacters ?? 64 * 1024;
  }

  get model(): string {
    return this.modelProvider.model;
  }

  async extract(
    messages: MemorySourceMessage[],
    current: MemoryDocumentContents,
  ): Promise<MemoryDocumentContents> {
    if (!messages.some((message) => message.role === 'user')) return current;
    const response = await this.modelProvider.complete({
      messages: [
        { role: 'system', content: this.systemPrompt },
        {
          role: 'user',
          content: JSON.stringify({
            conversation: messages,
            currentDocuments: {
              globalMemory: current.global,
              workspaceMemory: current.workspace,
            },
          }),
        },
      ],
      jsonMode: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseDocuments(response.content);
  }

  private parseDocuments(raw: string): MemoryDocumentContents {
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = memoryDocumentEnvelopeSchema.parse(JSON.parse(cleaned));
    const global = parsed.globalMemory.trim();
    const workspace = parsed.workspaceMemory.trim();
    if (!global.startsWith('# ') || !workspace.startsWith('# ')) {
      throw new TypeError('Memory documents must start with a Markdown heading');
    }
    if (global.length > this.maxDocumentCharacters || workspace.length > this.maxDocumentCharacters) {
      throw new RangeError('Memory document exceeds the configured safety limit');
    }
    if (CREDENTIAL_VALUE_PATTERN.test(`${global}\n${workspace}`)) {
      throw new TypeError('Credentials and secrets cannot be stored in long-term memory');
    }
    return { global, workspace };
  }
}
