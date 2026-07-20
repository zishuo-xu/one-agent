import Database from 'better-sqlite3';
import { config } from '../config.js';
import { MessageStore } from '../db/messageStore.js';
import { ThreadStore } from '../db/threadStore.js';
import { TraceEventStore } from '../db/traceEventStore.js';
import { MemoryDocumentStore, type MemoryDocumentScope } from './MemoryDocumentStore.js';
import { MemoryExtractor } from './MemoryExtractor.js';
import type { AgentEvent } from '../agents/events.js';

export interface MemoryConsolidationResult {
  threadId: string;
  status: 'completed' | 'failed' | 'skipped';
  messageCount: number;
  changedScopes: MemoryDocumentScope[];
  markedExtracted: boolean;
  error?: string;
}

export interface MemoryConsolidatorOptions {
  extractor?: MemoryExtractor;
  threadStore?: ThreadStore;
  messageStore?: MessageStore;
  documentStore?: MemoryDocumentStore;
  traceEventStore?: TraceEventStore;
}

/** Consolidates one complete thread at a time. Failed work stays unextracted. */
export class MemoryConsolidator {
  private readonly extractor: MemoryExtractor;
  private readonly threadStore: ThreadStore;
  private readonly messageStore: MessageStore;
  private readonly documentStore: MemoryDocumentStore;
  private readonly traceEventStore: TraceEventStore;
  private readonly inFlight = new Map<string, Promise<MemoryConsolidationResult>>();

  constructor(private readonly db: Database.Database, options: MemoryConsolidatorOptions = {}) {
    this.extractor = options.extractor ?? new MemoryExtractor();
    this.threadStore = options.threadStore ?? new ThreadStore(db);
    this.messageStore = options.messageStore ?? new MessageStore(db);
    this.documentStore = options.documentStore ?? new MemoryDocumentStore({
      workspaceRoot: config.workspaceRoot,
    });
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
    if (!thread) return this.failedResult(threadId, 0, 'Thread not found');
    if (thread.memoryExtracted) {
      return {
        threadId,
        status: 'skipped',
        messageCount: 0,
        changedScopes: [],
        markedExtracted: true,
      };
    }

    const messages = this.messageStore.getByThread(threadId)
      .filter((message) => !message.internal && (message.role === 'user' || message.role === 'assistant'))
      .map((message) => ({
        id: message.id,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        createdAt: message.createdAt,
      }));
    this.record(threadId, 'started', { messageCount: messages.length });

    try {
      const changedScopes: MemoryDocumentScope[] = [];
      await this.documentStore.update(async (current) => {
        const next = await this.extractor.extract(messages, current);
        if (next.global.trim() !== current.global.trim()) changedScopes.push('global');
        if (next.workspace.trim() !== current.workspace.trim()) changedScopes.push('workspace');
        return next;
      });

      // Files are committed before the database flag. A crash between these
      // operations only causes an idempotent retry; it never loses memory.
      const markedExtracted = this.threadStore.markMemoryExtractedIfUnchanged(
        threadId,
        thread.updatedAt,
      );
      const result: MemoryConsolidationResult = {
        threadId,
        status: 'completed',
        messageCount: messages.length,
        changedScopes,
        markedExtracted,
      };
      this.record(threadId, 'completed', {
        messageCount: messages.length,
        changedScopes,
        markedExtracted,
        durationMs: Date.now() - startedMs,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record(threadId, 'failed', {
        messageCount: messages.length,
        durationMs: Date.now() - startedMs,
        error: message,
      });
      return this.failedResult(threadId, messages.length, message);
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

  private failedResult(threadId: string, messageCount: number, error: string): MemoryConsolidationResult {
    return {
      threadId,
      status: 'failed',
      messageCount,
      changedScopes: [],
      markedExtracted: false,
      error,
    };
  }
}
