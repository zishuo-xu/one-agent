import { config } from '../config.js';
import type { TokenUsage } from '../model/types.js';
import type { TraceEventStore } from '../db/traceEventStore.js';
import type { AgentLoopEvent } from './AgentLoop.js';

export interface TokenUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RunRecorderOptions {
  traceEventStore?: TraceEventStore;
  /** Forwarded to listeners (AgentLoop re-emits these as its own 'event'). */
  onEvent?: (event: AgentLoopEvent) => void;
  /**
   * Callback for real prompt_tokens of the loop's own model calls, so the
   * context manager can anchor its "last real + delta estimate". Auxiliary
   * calls (planner/judge/sub-agents) must use trackPromptSize: false.
   */
  onContextTokens?: (promptTokens: number) => void;
}

/**
 * Everything a run leaves behind: the in-memory event stream, trace
 * persistence (with per-token deltas aggregated into one row per stream),
 * and token accounting. Loops emit into the recorder; readers (CLI, API,
 * trace-web, eval) consume the same event stream regardless of source.
 */
export class RunRecorder {
  private readonly traceEventStore?: TraceEventStore;
  private readonly onEvent?: (event: AgentLoopEvent) => void;
  private readonly onContextTokens?: (promptTokens: number) => void;

  private events: AgentLoopEvent[] = [];
  private tokenUsage: TokenUsageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  /** Buffered streaming deltas awaiting one aggregated trace row per stream. */
  private readonly deltaTraceBuffers = new Map<string, string[]>();
  private runId?: string;
  private taskId?: string;
  private threadId?: string;

  constructor(options: RunRecorderOptions = {}) {
    this.traceEventStore = options.traceEventStore;
    this.onEvent = options.onEvent;
    this.onContextTokens = options.onContextTokens;
  }

  /** Reset per-chat state (events and usage), keeping run correlation. */
  reset(): void {
    this.events = [];
    this.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  setRun(correlation: { runId?: string; taskId?: string; threadId?: string }): void {
    this.runId = correlation.runId;
    this.taskId = correlation.taskId;
    this.threadId = correlation.threadId;
  }

  /** Flush buffered deltas and clear run correlation (call in chat()'s finally). */
  endRun(): void {
    this.flushDeltaTraceBuffers();
    this.runId = undefined;
  }

  record(event: AgentLoopEvent): void {
    this.events.push(event);
    this.onEvent?.(event);

    if (!this.traceEventStore) {
      return;
    }
    if (event.type === 'message_delta' || event.type === 'reasoning_delta') {
      // Per-token deltas get one aggregated trace row per stream instead of
      // one row per token — a long answer would otherwise write thousands of
      // rows (write amplification) and slow every trace query.
      const buffer = this.deltaTraceBuffers.get(event.type) ?? [];
      buffer.push(event.content);
      this.deltaTraceBuffers.set(event.type, buffer);
      return;
    }
    // Keep persisted order: buffered deltas happened before this event.
    this.flushDeltaTraceBuffers();
    this.persistTraceEvent(event);
  }

  accumulateUsage(usage?: TokenUsage, options?: { trackPromptSize?: boolean }): void {
    if (!usage) return;
    this.tokenUsage.promptTokens += usage.promptTokens;
    this.tokenUsage.completionTokens += usage.completionTokens;
    this.tokenUsage.totalTokens += usage.totalTokens;
    if (usage.promptTokens > 0 && options?.trackPromptSize !== false) {
      this.onContextTokens?.(usage.promptTokens);
    }
  }

  getEvents(): AgentLoopEvent[] {
    return [...this.events];
  }

  /** Totals, or undefined when nothing was measured (e.g. all mocks without usage). */
  getUsage(): TokenUsageTotals | undefined {
    return this.tokenUsage.totalTokens > 0 ? { ...this.tokenUsage } : undefined;
  }

  /** Write buffered delta streams as one aggregated trace row each. */
  private flushDeltaTraceBuffers(): void {
    if (!this.traceEventStore || this.deltaTraceBuffers.size === 0) {
      return;
    }
    for (const [type, chunks] of this.deltaTraceBuffers) {
      if (chunks.length > 0) {
        this.persistTraceEvent({ type, content: chunks.join('') } as AgentLoopEvent);
      }
    }
    this.deltaTraceBuffers.clear();
  }

  private persistTraceEvent(event: AgentLoopEvent): void {
    try {
      this.traceEventStore!.create({
        runId: this.runId,
        taskId: this.taskId,
        threadId: this.threadId,
        eventType: event.type,
        eventData: event,
        model: config.model,
      });
    } catch {
      // Trace persistence should not break the main loop.
    }
  }
}
