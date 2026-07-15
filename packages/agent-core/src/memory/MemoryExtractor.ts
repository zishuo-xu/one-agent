import { config } from '../config.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelProvider } from '../model/types.js';

export interface ExtractedFact {
  key: string;
  value: string;
}

export interface MemoryExtractorOptions {
  systemPrompt?: string;
  model?: string;
  modelProvider?: ModelProvider;
  timeoutMs?: number;
}

export class MemoryExtractor {
  private readonly systemPrompt: string;
  private readonly modelProvider: ModelProvider;
  private readonly timeoutMs: number;

  constructor(options: MemoryExtractorOptions = {}) {
    this.systemPrompt =
      options.systemPrompt ??
      'You are a memory extractor. Given a user message and an assistant reply, extract concise key facts worth remembering for future conversations. ' +
      'Return ONLY a JSON array in this format, with no markdown, no explanation: [{"key": "fact name", "value": "fact content"}]. ' +
      'If there is nothing notable to remember, return [].';
    this.modelProvider =
      options.modelProvider ??
      (options.model
        ? new OpenAICompatibleProvider(config.openai, options.model)
        : config.utilityModelProvider ??
          config.modelProvider ??
          new OpenAICompatibleProvider(config.openai, config.model));
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async extract(userMessage: string, assistantReply: string): Promise<ExtractedFact[]> {
    const prompt = [
      'User message:',
      userMessage,
      '',
      'Assistant reply:',
      assistantReply,
      '',
      'Extract key facts as JSON array.',
    ].join('\n');

    try {
      const response = await this.modelProvider.complete({
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: prompt },
        ],
        timeoutMs: this.timeoutMs,
      });

      const raw = response.content || '[]';
      return this.parseFacts(raw);
    } catch {
      // Extraction should never break the main loop.
      return [];
    }
  }

  private parseFacts(raw: string): ExtractedFact[] {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '')
      .trim();

    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((item): item is { key: string; value: string } => {
          return (
            item &&
            typeof item === 'object' &&
            typeof item.key === 'string' &&
            item.key.length > 0 &&
            typeof item.value === 'string' &&
            item.value.length > 0
          );
        })
        .map((item) => ({ key: item.key.trim(), value: item.value.trim() }));
    } catch {
      return [];
    }
  }
}
