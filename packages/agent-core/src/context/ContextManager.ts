import { config } from '../config.js';
import { Message } from '../agents/types.js';

export interface ContextManagerOptions {
  systemPrompt: string;
  maxRecentMessages?: number;
  summaryTrigger?: number;
}

export class ContextManager {
  private messages: Message[] = [];
  private summaryMessage: Message | null = null;
  private lastSummarizedIndex = 0;
  protected readonly systemPrompt: string;
  private readonly maxRecentMessages: number;
  private readonly summaryTrigger: number;
  private memoryContext: string | null = null;

  constructor(options: ContextManagerOptions) {
    this.systemPrompt = options.systemPrompt;
    this.maxRecentMessages = options.maxRecentMessages ?? 10;
    this.summaryTrigger = options.summaryTrigger ?? 20;
    this.messages.push({ role: 'system', content: this.systemPrompt });
    this.lastSummarizedIndex = 1; // system prompt is at index 0, considered summarized
  }

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  setMemoryContext(content: string): void {
    this.memoryContext = content;
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.summaryMessage = null;
    this.lastSummarizedIndex = 1;
    this.memoryContext = null;
  }

  async buildContext(): Promise<Message[]> {
    if (this.messages.length <= this.summaryTrigger) {
      return this.buildOutput(this.messages.slice(1));
    }

    const recentStart = Math.max(1, this.messages.length - this.maxRecentMessages);

    // If there are old messages not yet summarized, summarize them.
    if (this.lastSummarizedIndex < recentStart) {
      const messagesToSummarize = this.messages.slice(this.lastSummarizedIndex, recentStart);
      const newSummary = await this.summarize(messagesToSummarize);
      this.summaryMessage = await this.mergeSummary(newSummary);
      this.lastSummarizedIndex = recentStart;
    }

    return this.buildOutput(this.messages.slice(recentStart));
  }

  getContextForDisplay(): Message[] {
    const recentStart = Math.max(1, this.messages.length - this.maxRecentMessages);
    return this.buildOutput(this.messages.slice(recentStart));
  }

  private buildOutput(messages: Message[]): Message[] {
    const context: Message[] = [];
    context.push({ role: 'system', content: this.systemPrompt });
    if (this.memoryContext) {
      context.push({
        role: 'system',
        content: `Relevant context from past conversations: ${this.memoryContext}`,
      });
    }
    if (this.summaryMessage) {
      context.push(this.summaryMessage);
    }
    context.push(...messages);
    return context;
  }

  private async mergeSummary(newSummary: string): Promise<Message> {
    if (this.summaryMessage) {
      const previousSummary = this.summaryMessage.content.replace('Earlier conversation summary: ', '').trim();
      return {
        role: 'system',
        content: `Earlier conversation summary: ${previousSummary}\n${newSummary}`,
      };
    }
    return {
      role: 'system',
      content: `Earlier conversation summary: ${newSummary}`,
    };
  }

  private async summarize(messages: Message[]): Promise<string> {
    if (messages.length === 0) {
      return '';
    }

    const conversationText = messages
      .map((message) => this.formatMessageForSummary(message))
      .join('\n');

    const prompt =
      'Summarize the following conversation concisely. ' +
      'Preserve key facts, decisions, and tool results.\n\n' +
      conversationText;

    try {
      const response = await config.openai.chat.completions.create(
        {
          model: config.model,
          messages: [
            { role: 'system', content: 'You are a helpful summarizer.' },
            { role: 'user', content: prompt },
          ],
        },
        { timeout: 30000 }
      );
      return response.choices[0]?.message?.content?.trim() ?? 'No summary available.';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Summary unavailable: ${message}`;
    }
  }

  private formatMessageForSummary(message: Message): string {
    if (message.role === 'tool') {
      return `tool (${message.tool_call_id ?? 'unknown'}): ${message.content}`;
    }
    if (message.role === 'assistant' && message.tool_calls) {
      const calls = message.tool_calls
        .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
        .join(', ');
      return `assistant [tool_calls: ${calls}]`;
    }
    return `${message.role}: ${message.content}`;
  }
}
