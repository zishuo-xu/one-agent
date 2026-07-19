import crypto from 'node:crypto';
import { config } from '../config.js';
import { contextSettings, modelName, modelTimeoutMs } from '../configAccess.js';
import { Message } from '../agents/types.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelCallTraceEvent, ModelProvider, TokenUsage } from '../model/types.js';
import { estimateMessageTokens, estimateMessagesTokens, estimateTokens } from './tokenEstimate.js';

export interface ContextManagerOptions {
  systemPrompt: string;
  maxRecentMessages?: number;
  summaryTrigger?: number;
  /** Maximum estimated tokens in context before summarization triggers. When set, takes priority over summaryTrigger. */
  maxContextTokens?: number;
  /** Token budget for the recent (non-summarized) message window. When set, takes priority over maxRecentMessages. */
  recentTokenBudget?: number;
  /** Provider used for summarization calls. Defaults to the shared provider chain. */
  modelProvider?: ModelProvider;
}

export class ContextManager {
  /** Optional run-level observability sinks, wired by AgentLoop. */
  onUsage?: (usage: TokenUsage) => void;
  onTrace?: (event: ModelCallTraceEvent) => void;
  private messages: Message[] = [];
  private summaryMessage: Message | null = null;
  private lastSummarizedIndex = 0;
  protected readonly systemPrompt: string;
  private readonly maxRecentMessages: number;
  private readonly summaryTrigger: number;
  private readonly maxContextTokens?: number;
  private readonly recentTokenBudget?: number;
  private readonly modelProvider?: ModelProvider;
  private memoryContext: string | null = null;
  /** Real prompt_tokens from the last model call (reported by the API). */
  private lastKnownPromptTokens?: number;
  /** Message count at the time of the last buildContext(), to compute the delta. */
  private lastBuildMessageCount = 1;

  constructor(options: ContextManagerOptions) {
    this.systemPrompt = options.systemPrompt;
    this.maxRecentMessages = options.maxRecentMessages ?? 10;
    this.summaryTrigger = options.summaryTrigger ?? 20;
    const contextConfig = contextSettings();
    this.maxContextTokens = options.maxContextTokens ?? contextConfig.maxTokens;
    this.recentTokenBudget = options.recentTokenBudget ?? contextConfig.recentTokenBudget;
    this.modelProvider = options.modelProvider;
    this.messages.push({ role: 'system', content: this.systemPrompt });
    this.lastSummarizedIndex = 1; // system prompt is at index 0, considered summarized
  }

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  setMemoryContext(content: string): void {
    this.memoryContext = content;
  }

  clearMemoryContext(): void {
    this.memoryContext = null;
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
    await this.trySummarizeUpTo(absRecentStart);

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

    await this.trySummarizeUpTo(recentStart);

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

  /**
   * Summarize messages up to `endIndex` and fold them into the running
   * summary. On failure the previous summary and lastSummarizedIndex are left
   * untouched: this turn proceeds with just the recent window and the next
   * build retries, instead of permanently replacing history with an error
   * string.
   */
  private async trySummarizeUpTo(endIndex: number): Promise<void> {
    if (this.lastSummarizedIndex >= endIndex) {
      return;
    }
    const messagesToSummarize = this.messages.slice(this.lastSummarizedIndex, endIndex);
    try {
      const newSummary = await this.summarize(messagesToSummarize);
      this.summaryMessage = await this.mergeSummary(newSummary);
      this.lastSummarizedIndex = endIndex;
    } catch {
      // Transient summarization failure — history is preserved and the next
      // buildContext() retries from the same lastSummarizedIndex.
    }
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

  private resolveModelProvider(): ModelProvider {
    return (
      this.modelProvider ??
      config.utilityModelProvider ??
      config.modelProvider ??
      new OpenAICompatibleProvider(config.openai, modelName())
    );
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

    const provider = this.resolveModelProvider();
    const modelCallId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const requestMessages: Message[] = [
        { role: 'system', content: 'You are a helpful summarizer.' },
        { role: 'user', content: prompt },
    ];
    this.onTrace?.({
      type: 'model_call', phase: 'started', modelCallId, purpose: 'summary',
      provider: provider.name, model: provider.model, attempt: 0, streaming: false,
      startedAt, messageCount: requestMessages.length, toolCount: 0,
    });
    try {
      const response = await provider.complete({
        messages: requestMessages,
        timeoutMs: modelTimeoutMs(),
      });
      if (response.usage) this.onUsage?.(response.usage);
      this.onTrace?.({
        type: 'model_call', phase: 'completed', modelCallId, purpose: 'summary',
        provider: provider.name, model: provider.model, attempt: 0, streaming: false,
        startedAt, durationMs: Date.now() - startedMs, usage: response.usage,
      });
      return response.content.trim() || 'No summary available.';
    } catch (error) {
      this.onTrace?.({
        type: 'model_call', phase: 'failed', modelCallId, purpose: 'summary',
        provider: provider.name, model: provider.model, attempt: 0, streaming: false,
        startedAt, durationMs: Date.now() - startedMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
