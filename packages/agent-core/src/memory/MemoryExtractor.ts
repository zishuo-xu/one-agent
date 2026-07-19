import { config } from '../config.js';
import { modelName } from '../configAccess.js';
import type { Memory } from '../db/types.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelProvider } from '../model/types.js';

export interface MemorySourceMessage {
  id: string;
  content: string;
  createdAt: string;
}

export interface ExtractedMemoryCandidate {
  key: string;
  value: string;
  evidence: string;
  kind: Memory['kind'];
  scope: Memory['scope'];
  confidence: number;
  explicit: boolean;
  sourceMessageId: string;
  expiresAt?: string;
}

export interface ExistingMemorySnapshot {
  key: string;
  value: string;
  kind: Memory['kind'];
  scope: Memory['scope'];
  explicit: boolean;
}

export interface MemoryExtractorOptions {
  systemPrompt?: string;
  model?: string;
  modelProvider?: ModelProvider;
  timeoutMs?: number;
}

const MEMORY_KINDS = new Set<Memory['kind']>([
  'user_profile',
  'user_preference',
  'project_rule',
  'durable_goal',
  'fact',
]);

/**
 * Session-level Memory Agent. It receives only user-authored messages and
 * returns evidence-linked candidates; it never writes storage directly.
 */
export class MemoryExtractor {
  private readonly systemPrompt: string;
  private readonly modelProvider: ModelProvider;
  private readonly timeoutMs: number;

  constructor(options: MemoryExtractorOptions = {}) {
    this.systemPrompt = options.systemPrompt ?? [
      'You are the Memory Agent for a reliability-first agent runtime.',
      'Review all user-authored messages from one conversation and extract only durable facts useful in future conversations.',
      'Allowed kinds: user_profile, user_preference, project_rule, durable_goal.',
      'Do not store general knowledge, questions, assistant claims, search results, file contents, tool tasks, temporary requests, predictions, weather, news, passwords, API keys, tokens, secrets, or other credentials.',
      'A question is not evidence of its answer. Never infer a preference or fact from something the user only asked about.',
      'If an existing memory already expresses the same meaning, especially an explicit memory, do not emit a duplicate candidate.',
      'When a user changes or corrects a fact, emit the latest durable value and cite the exact user message that supports it.',
      'Every item must cite one sourceMessageId and include an exact verbatim evidence quote from that message. Do not invent IDs or evidence.',
      'The value must be the smallest literal fact copied from the evidence, not a paraphrase or an inferred answer.',
      'Return ONLY a JSON array with no markdown:',
      '[{"key":"concise stable name","value":"literal fact","evidence":"exact user quote containing literal fact","kind":"user_preference","scope":"global","confidence":0.95,"explicit":true,"sourceMessageId":"message-id","expiresAt":null}]',
      'Use the same language as the user. If nothing should be remembered, return [].',
    ].join(' ');
    this.modelProvider = options.modelProvider ??
      (options.model
        ? new OpenAICompatibleProvider(config.openai, options.model)
        : config.utilityModelProvider ??
          config.modelProvider ??
          new OpenAICompatibleProvider(config.openai, modelName()));
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  get model(): string {
    return this.modelProvider.model;
  }

  async extract(
    messages: MemorySourceMessage[],
    existingMemories: ExistingMemorySnapshot[] = [],
  ): Promise<ExtractedMemoryCandidate[]> {
    if (messages.length === 0) return [];
    const allowedIds = new Set(messages.map((message) => message.id));
    const prompt = JSON.stringify({
      userMessages: messages.map(({ id, content, createdAt }) => ({ id, createdAt, content })),
      existingMemories,
    });
    const response = await this.modelProvider.complete({
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: prompt },
      ],
      timeoutMs: this.timeoutMs,
    });
    return this.parseCandidates(response.content || '[]', messages, allowedIds);
  }

  private parseCandidates(
    raw: string,
    messages: MemorySourceMessage[],
    allowedIds: Set<string>,
  ): ExtractedMemoryCandidate[] {
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new TypeError('Memory Agent must return a JSON array');

    const sourceById = new Map(messages.map((message) => [message.id, message.content]));
    return parsed.flatMap((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new TypeError(`Invalid memory candidate at index ${index}`);
      }
      const candidate = item as Record<string, unknown>;
      const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
      const value = typeof candidate.value === 'string' ? candidate.value.trim() : '';
      const evidence = typeof candidate.evidence === 'string' ? candidate.evidence.trim() : '';
      const sourceMessageId = typeof candidate.sourceMessageId === 'string'
        ? candidate.sourceMessageId
        : '';
      const kind = candidate.kind as Memory['kind'];
      const scope = candidate.scope === 'thread' ? 'thread' : 'global';
      const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : 0.7;
      if (!key || !value || !MEMORY_KINDS.has(kind) || !allowedIds.has(sourceMessageId)) {
        throw new TypeError(`Invalid memory candidate at index ${index}`);
      }
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new TypeError(`Invalid memory confidence at index ${index}`);
      }
      const sourceContent = sourceById.get(sourceMessageId) ?? '';
      if (!evidence || !sourceContent.includes(evidence) || !evidence.includes(value)) {
        return [];
      }
      return [{
        key,
        value,
        evidence,
        kind,
        scope,
        confidence,
        explicit: candidate.explicit === true,
        sourceMessageId,
        expiresAt: typeof candidate.expiresAt === 'string' ? candidate.expiresAt : undefined,
      }];
    });
  }
}
