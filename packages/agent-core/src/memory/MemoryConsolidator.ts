import Database from 'better-sqlite3';
import { MemoryStore } from '../db/memoryStore.js';
import { MessageStore } from '../db/messageStore.js';
import { ThreadStore } from '../db/threadStore.js';
import { TraceEventStore } from '../db/traceEventStore.js';
import { MemoryExtractor } from './MemoryExtractor.js';
import type { AgentEvent } from '../agents/events.js';

export interface MemoryConsolidationResult {
  threadId: string;
  status: 'completed' | 'failed' | 'skipped';
  messageCount: number;
  candidateCount: number;
  writtenCount: number;
  rejectedCount: number;
  markedExtracted: boolean;
  error?: string;
}

export interface MemoryConsolidatorOptions {
  extractor?: MemoryExtractor;
  threadStore?: ThreadStore;
  messageStore?: MessageStore;
  memoryStore?: MemoryStore;
  traceEventStore?: TraceEventStore;
}

const SENSITIVE_PATTERN = /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|密码|密钥|令牌)/i;

/** Consolidates one complete thread at a time. Failed work stays unextracted. */
export class MemoryConsolidator {
  private readonly extractor: MemoryExtractor;
  private readonly threadStore: ThreadStore;
  private readonly messageStore: MessageStore;
  private readonly memoryStore: MemoryStore;
  private readonly traceEventStore: TraceEventStore;
  private readonly inFlight = new Map<string, Promise<MemoryConsolidationResult>>();

  constructor(private readonly db: Database.Database, options: MemoryConsolidatorOptions = {}) {
    this.extractor = options.extractor ?? new MemoryExtractor();
    this.threadStore = options.threadStore ?? new ThreadStore(db);
    this.messageStore = options.messageStore ?? new MessageStore(db);
    this.memoryStore = options.memoryStore ?? new MemoryStore(db);
    this.traceEventStore = options.traceEventStore ?? new TraceEventStore(db);
  }

  consolidateThread(threadId: string): Promise<MemoryConsolidationResult> {
    const running = this.inFlight.get(threadId);
    if (running) return running;
    const work = this.runConsolidation(threadId).finally(() => this.inFlight.delete(threadId));
    this.inFlight.set(threadId, work);
    return work;
  }

  async recoverUnextracted(): Promise<MemoryConsolidationResult[]> {
    const results: MemoryConsolidationResult[] = [];
    for (const thread of this.threadStore.listUnextracted()) {
      results.push(await this.consolidateThread(thread.id));
    }
    return results;
  }

  private async runConsolidation(threadId: string): Promise<MemoryConsolidationResult> {
    const startedMs = Date.now();
    const thread = this.threadStore.getById(threadId);
    if (!thread) {
      return this.failedResult(threadId, 0, 0, 0, 'Thread not found');
    }
    if (thread.memoryExtracted) {
      return {
        threadId,
        status: 'skipped',
        messageCount: 0,
        candidateCount: 0,
        writtenCount: 0,
        rejectedCount: 0,
        markedExtracted: true,
      };
    }

    const userMessages = this.messageStore.getByThread(threadId)
      .filter((message) => message.role === 'user' && !message.internal)
      .map((message) => ({ id: message.id, content: message.content, createdAt: message.createdAt }));
    this.record(threadId, 'started', { messageCount: userMessages.length });

    try {
      const candidates = await this.extractor.extract(userMessages);
      const sources = new Map(userMessages.map((message) => [message.id, message]));
      let writtenCount = 0;
      let rejectedCount = 0;
      let markedExtracted = false;

      const commit = this.db.transaction(() => {
        for (const candidate of candidates) {
          const sourceMessage = sources.get(candidate.sourceMessageId);
          if (!sourceMessage || SENSITIVE_PATTERN.test(`${candidate.key}\n${candidate.value}`)) {
            rejectedCount++;
            continue;
          }
          this.memoryStore.remember({
            key: candidate.key,
            value: candidate.value,
            kind: candidate.kind,
            scope: candidate.scope,
            confidence: candidate.confidence,
            explicit: candidate.explicit,
            expiresAt: candidate.expiresAt,
            source: 'memory_agent',
            threadId,
            sourceMessageId: sourceMessage.id,
            observedAt: sourceMessage.createdAt,
          });
          writtenCount++;
        }
        markedExtracted = this.threadStore.markMemoryExtractedIfUnchanged(
          threadId,
          thread.updatedAt,
        );
      });
      commit();

      const result: MemoryConsolidationResult = {
        threadId,
        status: 'completed',
        messageCount: userMessages.length,
        candidateCount: candidates.length,
        writtenCount,
        rejectedCount,
        markedExtracted,
      };
      this.record(threadId, 'completed', {
        messageCount: userMessages.length,
        candidateCount: candidates.length,
        writtenCount,
        rejectedCount,
        markedExtracted,
        durationMs: Date.now() - startedMs,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record(threadId, 'failed', {
        messageCount: userMessages.length,
        durationMs: Date.now() - startedMs,
        error: message,
      });
      return this.failedResult(threadId, userMessages.length, 0, 0, message);
    }
  }

  private record(
    threadId: string,
    phase: 'started' | 'completed' | 'failed',
    data: Omit<Extract<AgentEvent, { type: 'memory_consolidation' }>, 'type' | 'phase'>,
  ): void {
    try {
      this.traceEventStore.create({
        threadId,
        eventType: `memory_consolidation_${phase}`,
        eventData: { type: 'memory_consolidation', phase, ...data },
        model: this.extractor.model,
      });
    } catch {
      // Observability must not change consolidation success or retry state.
    }
  }

  private failedResult(
    threadId: string,
    messageCount: number,
    candidateCount: number,
    rejectedCount: number,
    error: string,
  ): MemoryConsolidationResult {
    return {
      threadId,
      status: 'failed',
      messageCount,
      candidateCount,
      writtenCount: 0,
      rejectedCount,
      markedExtracted: false,
      error,
    };
  }
}
