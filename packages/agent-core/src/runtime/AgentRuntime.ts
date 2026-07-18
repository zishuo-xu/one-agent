import type Database from 'better-sqlite3';
import { AgentLoop } from '../agents/AgentLoop.js';
import { getSharedConnection } from '../db/connection.js';
import { MemoryStore } from '../db/memoryStore.js';
import { MessageStore } from '../db/messageStore.js';
import { RunStore } from '../db/runStore.js';
import { SqliteTaskStore } from '../db/taskStore.js';
import { ThreadStore } from '../db/threadStore.js';
import { ToolCallStore } from '../db/toolCallStore.js';
import { TraceEventStore } from '../db/traceEventStore.js';
import { MemoryConsolidator } from '../memory/MemoryConsolidator.js';
import { createBuiltInTools } from '../tools/built-in/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { Sandbox } from '../tools/sandbox.js';

export interface AgentRuntimeOptions {
  workspaceRoot: string;
  db?: Database.Database;
  tools?: ToolRegistry;
}

export interface CreateRuntimeAgentOptions {
  threadId?: string;
  taskId?: string;
  signal?: AbortSignal;
  planning?: boolean | 'auto';
  subAgents?: boolean;
}

/**
 * Composition root for one workspace.
 *
 * Entrypoints should construct this once instead of knowing how to wire the
 * sandbox, tools, stores, memory lifecycle and AgentLoop dependencies.
 */
export class AgentRuntime {
  readonly db: Database.Database;
  readonly tools: ToolRegistry;
  readonly stores: {
    threads: ThreadStore;
    messages: MessageStore;
    runs: RunStore;
    toolCalls: ToolCallStore;
    traces: TraceEventStore;
    tasks: SqliteTaskStore;
    memories: MemoryStore;
  };
  readonly memory: MemoryConsolidator;

  constructor(options: AgentRuntimeOptions) {
    this.db = options.db ?? getSharedConnection();
    this.tools = options.tools ?? this.createTools(options.workspaceRoot);
    this.stores = {
      threads: new ThreadStore(this.db),
      messages: new MessageStore(this.db),
      runs: new RunStore(this.db),
      toolCalls: new ToolCallStore(this.db),
      traces: new TraceEventStore(this.db),
      tasks: new SqliteTaskStore(this.db),
      memories: new MemoryStore(this.db),
    };
    this.memory = new MemoryConsolidator(this.db, {
      threadStore: this.stores.threads,
      messageStore: this.stores.messages,
      memoryStore: this.stores.memories,
      traceEventStore: this.stores.traces,
    });
  }

  createAgent(options: CreateRuntimeAgentOptions = {}): AgentLoop {
    return new AgentLoop({
      db: this.db,
      tools: this.tools,
      threadId: options.threadId,
      taskId: options.taskId,
      signal: options.signal,
      enablePlanning: options.planning,
      subAgents: options.subAgents,
      runStore: this.stores.runs,
      toolCallStore: this.stores.toolCalls,
      traceEventStore: this.stores.traces,
      memoryStore: this.stores.memories,
    });
  }

  private createTools(workspaceRoot: string): ToolRegistry {
    const tools = new ToolRegistry();
    tools.registerMany(createBuiltInTools(new Sandbox(workspaceRoot)));
    return tools;
  }
}
