import Database from 'better-sqlite3';
import { Message } from '../agents/types.js';
import { ContextManager, ContextManagerOptions } from './ContextManager.js';
import { MessageStore } from '../db/messageStore.js';
import { ThreadStore } from '../db/threadStore.js';
import { persistedToMessage } from '../db/types.js';

export interface PersistenceContextManagerOptions extends ContextManagerOptions {
  threadId: string;
  db: Database.Database;
  threadStore?: ThreadStore;
  messageStore?: MessageStore;
}

export class PersistenceContextManager extends ContextManager {
  private readonly threadId: string;
  private readonly db: Database.Database;
  private readonly threadStore: ThreadStore;
  private readonly messageStore: MessageStore;

  constructor(options: PersistenceContextManagerOptions) {
    super(options);
    this.threadId = options.threadId;
    this.db = options.db;
    this.threadStore = options.threadStore ?? new ThreadStore(this.db);
    this.messageStore = options.messageStore ?? new MessageStore(this.db);
    this.loadThread(options.threadId);
  }

  addMessage(message: Message): void {
    super.addMessage(message);
    if (message.role !== 'system') {
      this.messageStore.save(this.threadId, message);
      this.threadStore.updateTimestamp(this.threadId);
    }
  }

  private loadThread(threadId: string): void {
    const thread = this.threadStore.getById(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    super.clear();
    super.addMessage({ role: 'system', content: this.systemPrompt });

    const rows = this.messageStore.getByThread(threadId);
    for (const row of rows) {
      super.addMessage(persistedToMessage(row));
    }
  }
}
