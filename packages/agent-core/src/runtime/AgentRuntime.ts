import type Database from 'better-sqlite3';
import { AgentLoop } from '../agents/AgentLoop.js';
import {
  createRequestUserInputTool,
  REQUEST_USER_INPUT_TOOL_NAME,
} from '../agents/requestUserInputTool.js';
import { getSharedConnection } from '../db/connection.js';
import { MemoryStore } from '../db/memoryStore.js';
import { MessageStore } from '../db/messageStore.js';
import { RunStore } from '../db/runStore.js';
import { SqliteTaskStore } from '../db/taskStore.js';
import { ThreadStore } from '../db/threadStore.js';
import { ToolCallStore } from '../db/toolCallStore.js';
import { TraceEventStore } from '../db/traceEventStore.js';
import { MemoryConsolidator } from '../memory/MemoryConsolidator.js';
import {
  createManageMemoryTool,
  MANAGE_MEMORY_TOOL_NAME,
} from '../memory/manageMemoryTool.js';
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
  /** Offer durable clarification. Disable for non-interactive workers. */
  userInput?: boolean;
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
    const tools = new ToolRegistry();
    tools.registerMany(this.tools.list());
    const memoryToolDisabled = (process.env.DISABLED_TOOLS ?? '')
      .split(',')
      .some((name) => name.trim() === MANAGE_MEMORY_TOOL_NAME);
    if (!memoryToolDisabled && !tools.has(MANAGE_MEMORY_TOOL_NAME)) {
      tools.register(createManageMemoryTool({
        memoryStore: this.stores.memories,
        threadId: options.threadId,
      }));
    }
    const inputToolDisabled = (process.env.DISABLED_TOOLS ?? '')
      .split(',')
      .some((name) => name.trim() === REQUEST_USER_INPUT_TOOL_NAME);
    if (options.userInput !== false && !inputToolDisabled && !tools.has(REQUEST_USER_INPUT_TOOL_NAME)) {
      tools.register(createRequestUserInputTool());
    }
    return new AgentLoop({
      db: this.db,
      tools,
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
