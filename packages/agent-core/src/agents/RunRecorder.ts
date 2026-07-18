import { config } from '../config.js';
import type { TokenUsage } from '../model/types.js';
import type { TraceEventStore } from '../db/traceEventStore.js';
import type { AgentEvent } from './events.js';
import { sanitizeTraceEvent } from './traceSanitizer.js';

export interface TokenUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RunRecorderOptions {
  traceEventStore?: TraceEventStore;
  /** Forwarded to listeners (AgentLoop re-emits these as its own 'event'). */
  onEvent?: (event: AgentEvent) => void;
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
  private readonly onEvent?: (event: AgentEvent) => void;
  private readonly onContextTokens?: (promptTokens: number) => void;

  private events: AgentEvent[] = [];
  private tokenUsage: TokenUsageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  /** Buffered streaming deltas awaiting one aggregated trace row per stream. */
  private readonly deltaTraceBuffers = new Map<string, { chunks: string[]; occurredAt: string }>();
  private runId?: string;
  private taskId?: string;
  private threadId?: string;
  private sequence = 0;
  private persistedTraceEvents = 0;
  private droppedTraceEvents = 0;
  private traceError?: string;

  constructor(options: RunRecorderOptions = {}) {
    this.traceEventStore = options.traceEventStore;
    this.onEvent = options.onEvent;
    this.onContextTokens = options.onContextTokens;
  }

  /** Reset per-chat state (events and usage), keeping run correlation. */
  reset(): void {
    this.events = [];
    this.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.deltaTraceBuffers.clear();
    this.sequence = 0;
    this.persistedTraceEvents = 0;
    this.droppedTraceEvents = 0;
    this.traceError = undefined;
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

  record(event: AgentEvent): void {
    this.events.push(event);
    this.onEvent?.(event);

    if (!this.traceEventStore) {
      return;
    }
    if (event.type === 'message_delta' || event.type === 'reasoning_delta') {
      // Per-token deltas get one aggregated trace row per stream instead of
      // one row per token — a long answer would otherwise write thousands of
      // rows (write amplification) and slow every trace query.
      const buffer = this.deltaTraceBuffers.get(event.type) ?? {
        chunks: [],
        occurredAt: new Date().toISOString(),
      };
      buffer.chunks.push(event.content);
      this.deltaTraceBuffers.set(event.type, buffer);
      return;
    }
    // Keep persisted order: buffered deltas happened before this event.
    this.flushDeltaTraceBuffers();
    this.persistTraceEvent(event);
  }

  /**
   * Persist a recovery point as a mandatory Trace fact. Unlike observational
   * events, losing this event would make the recorded history unsafe to
   * resume, so persistence failure stops the current state transition.
   */
  recordRecoveryPoint(checkpoint: Extract<AgentEvent, { type: 'recovery_point' }>['checkpoint']): void {
    const event: AgentEvent = { type: 'recovery_point', checkpoint };
    this.events.push(event);
    this.onEvent?.(event);

    if (!this.traceEventStore) return;
    this.flushDeltaTraceBuffers();
    this.persistTraceEvent(event, new Date().toISOString(), true);
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

  getEvents(): AgentEvent[] {
    return [...this.events];
  }

  /** Totals, or undefined when nothing was measured (e.g. all mocks without usage). */
  getUsage(): TokenUsageTotals | undefined {
    return this.tokenUsage.totalTokens > 0 ? { ...this.tokenUsage } : undefined;
  }

  getTraceHealth(): {
    status: 'complete' | 'partial' | 'failed';
    droppedEventCount: number;
    error?: string;
  } {
    return {
      status:
        this.droppedTraceEvents === 0
          ? 'complete'
          : this.persistedTraceEvents === 0
            ? 'failed'
            : 'partial',
      droppedEventCount: this.droppedTraceEvents,
      error: this.traceError,
    };
  }

  /** Write buffered delta streams as one aggregated trace row each. */
  private flushDeltaTraceBuffers(): void {
    if (!this.traceEventStore || this.deltaTraceBuffers.size === 0) {
      return;
    }
    for (const [type, buffer] of this.deltaTraceBuffers) {
      if (buffer.chunks.length > 0) {
        this.persistTraceEvent(
          { type, content: buffer.chunks.join('') } as AgentEvent,
          buffer.occurredAt,
        );
      }
    }
    this.deltaTraceBuffers.clear();
  }

  private persistTraceEvent(
    event: AgentEvent,
    occurredAt = new Date().toISOString(),
    durable = false,
  ): void {
    const sequence = this.sequence++;
    try {
      this.traceEventStore!.create({
        runId: this.runId,
        taskId: this.taskId,
        threadId: this.threadId,
        eventType: event.type,
        // Recovery points are the exact facts used to continue execution.
        // TraceEventStore sanitizes public reads, while RunStore reads this
        // raw row only for recovery.
        eventData: durable ? event : sanitizeTraceEvent(event),
        model: config.model,
        sequence,
        createdAt: occurredAt,
      });
      this.persistedTraceEvents++;
    } catch (error) {
      this.droppedTraceEvents++;
      this.traceError = error instanceof Error ? error.message : String(error);
      if (durable) throw error;
      // Observational Trace persistence should not break the main loop.
    }
  }
}
