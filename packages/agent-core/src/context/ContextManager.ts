import { config } from '../config.js';
import { Message } from '../agents/types.js';
import { estimateMessageTokens, estimateMessagesTokens, estimateTokens } from './tokenEstimate.js';

export interface ContextManagerOptions {
  systemPrompt: string;
  maxRecentMessages?: number;
  summaryTrigger?: number;
  /** Maximum estimated tokens in context before summarization triggers. When set, takes priority over summaryTrigger. */
  maxContextTokens?: number;
  /** Token budget for the recent (non-summarized) message window. When set, takes priority over maxRecentMessages. */
  recentTokenBudget?: number;
}

export class ContextManager {
  private messages: Message[] = [];
  private summaryMessage: Message | null = null;
  private lastSummarizedIndex = 0;
  protected readonly systemPrompt: string;
  private readonly maxRecentMessages: number;
  private readonly summaryTrigger: number;
  private readonly maxContextTokens?: number;
  private readonly recentTokenBudget?: number;
  private memoryContext: string | null = null;
  /** Real prompt_tokens from the last model call (reported by the API). */
  private lastKnownPromptTokens?: number;
  /** Message count at the time of the last buildContext(), to compute the delta. */
  private lastBuildMessageCount = 1;

  constructor(options: ContextManagerOptions) {
    this.systemPrompt = options.systemPrompt;
    this.maxRecentMessages = options.maxRecentMessages ?? 10;
    this.summaryTrigger = options.summaryTrigger ?? 20;
    this.maxContextTokens = options.maxContextTokens ?? config.maxContextTokens;
    this.recentTokenBudget = options.recentTokenBudget ?? config.recentTokenBudget;
    this.messages.push({ role: 'system', content: this.systemPrompt });
    this.lastSummarizedIndex = 1; // system prompt is at index 0, considered summarized
  }

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  setMemoryContext(content: string): void {
    this.memoryContext = content;
  }

  /** Feed back the real prompt_tokens from the model's usage response. */
  updateLastKnownTokens(promptTokens: number): void {
    this.lastKnownPromptTokens = promptTokens;
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.summaryMessage = null;
    this.lastSummarizedIndex = 1;
    this.memoryContext = null;
    this.lastKnownPromptTokens = undefined;
    this.lastBuildMessageCount = 1;
  }

  async buildContext(): Promise<Message[]> {
    // Token-based path (takes priority when maxContextTokens is set).
    if (this.maxContextTokens !== undefined) {
      return this.buildContextByTokens();
    }
    // Fallback: legacy message-count-based path.
    return this.buildContextByCount();
  }

  private async buildContextByTokens(): Promise<Message[]> {
    const nonSystemMessages = this.messages.slice(1);

    // Estimate total tokens: prefer "last real prompt_tokens + delta" over
    // pure estimation. The model reports the exact prompt_tokens after each
    // call; we combine that with a heuristic estimate of messages added since.
    let totalTokens: number;
    if (this.lastKnownPromptTokens !== undefined && this.lastBuildMessageCount < this.messages.length) {
      const newMessages = this.messages.slice(this.lastBuildMessageCount);
      const delta = estimateMessagesTokens(newMessages);
      totalTokens = this.lastKnownPromptTokens + delta;
    } else {
      totalTokens = estimateMessagesTokens(nonSystemMessages);
    }

    // Record the message count at this build for the next delta computation.
    this.lastBuildMessageCount = this.messages.length;

    // If within budget, return everything without summarizing.
    if (totalTokens <= this.maxContextTokens!) {
      return this.buildOutput(nonSystemMessages);
    }

    // Determine the recent window by accumulating tokens from the end.
    const budget = this.recentTokenBudget ?? 2048;
    let recentTokens = 0;
    let recentStart = nonSystemMessages.length; // index within nonSystemMessages

    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const msgTokens = estimateMessageTokens(nonSystemMessages[i]);
      if (recentTokens + msgTokens > budget && recentStart < nonSystemMessages.length) {
        break;
      }
      recentTokens += msgTokens;
      recentStart = i;
    }

    // Convert to absolute index in this.messages (add 1 for system prompt).
    let absRecentStart = recentStart + 1;

    // Never start the recent window on a 'tool' message: it must be preceded
    // by an 'assistant' message with tool_calls, otherwise the API rejects the
    // request with "Messages with role 'tool' must be a response to a preceding
    // message with 'tool_calls'". Back up until we find a non-tool message.
    while (absRecentStart < this.messages.length && this.messages[absRecentStart]?.role === 'tool') {
      absRecentStart--;
    }

    // Summarize messages that have aged out of the window.
    if (this.lastSummarizedIndex < absRecentStart) {
      const messagesToSummarize = this.messages.slice(this.lastSummarizedIndex, absRecentStart);
      const newSummary = await this.summarize(messagesToSummarize);
      this.summaryMessage = await this.mergeSummary(newSummary);
      this.lastSummarizedIndex = absRecentStart;
    }

    return this.buildOutput(this.messages.slice(absRecentStart));
  }

  private async buildContextByCount(): Promise<Message[]> {
    if (this.messages.length <= this.summaryTrigger) {
      return this.buildOutput(this.messages.slice(1));
    }

    let recentStart = Math.max(1, this.messages.length - this.maxRecentMessages);

    // Same fix as buildContextByTokens: don't start on a 'tool' message.
    while (recentStart < this.messages.length && this.messages[recentStart]?.role === 'tool') {
      recentStart--;
    }

    if (this.lastSummarizedIndex < recentStart) {
      const messagesToSummarize = this.messages.slice(this.lastSummarizedIndex, recentStart);
      const newSummary = await this.summarize(messagesToSummarize);
      this.summaryMessage = await this.mergeSummary(newSummary);
      this.lastSummarizedIndex = recentStart;
    }

    return this.buildOutput(this.messages.slice(recentStart));
  }

  /** Return a snapshot of context info for display (e.g. CLI /context). */
  getContextInfo(): {
    messageCount: number;
    estimatedTokens: number;
    maxContextTokens?: number;
    hasSummary: boolean;
    recentTokenBudget?: number;
    tokenSource: 'real' | 'estimate';
  } {
    const nonSystem = this.messages.slice(1);
    let estimatedTokens: number;
    let tokenSource: 'real' | 'estimate' = 'estimate';

    if (this.lastKnownPromptTokens !== undefined && this.lastBuildMessageCount < this.messages.length) {
      const newMessages = this.messages.slice(this.lastBuildMessageCount);
      estimatedTokens = this.lastKnownPromptTokens + estimateMessagesTokens(newMessages);
      tokenSource = 'real';
    } else if (this.lastKnownPromptTokens !== undefined) {
      estimatedTokens = this.lastKnownPromptTokens;
      tokenSource = 'real';
    } else {
      estimatedTokens = estimateMessagesTokens(nonSystem);
    }

    return {
      messageCount: nonSystem.length,
      estimatedTokens,
      maxContextTokens: this.maxContextTokens,
      hasSummary: this.summaryMessage !== null,
      recentTokenBudget: this.recentTokenBudget,
      tokenSource,
    };
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
        { timeout: config.timeoutMs }
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
