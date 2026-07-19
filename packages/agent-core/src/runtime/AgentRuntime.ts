import type Database from 'better-sqlite3';
import { AgentLoop } from '../agents/AgentLoop.js';
import type { DelegationBudget } from '../agents/SubAgentRunner.js';
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
import { DefaultToolPolicy, type ToolPolicy } from '../tools/policy.js';
import { config } from '../config.js';
import { modelName } from '../configAccess.js';
import type { ModelProvider, RequiredModelCapability } from '../model/types.js';
import { assertModelCapabilities } from '../model/capabilities.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';

export interface AgentRuntimeOptions {
  workspaceRoot: string;
  db?: Database.Database;
  tools?: ToolRegistry;
  toolPolicy?: ToolPolicy;
  /** Optional pinned Provider; otherwise the configured provider chain is used. */
  modelProvider?: ModelProvider;
}

export interface CreateRuntimeAgentOptions {
  threadId?: string;
  taskId?: string;
  signal?: AbortSignal;
  planning?: boolean | 'auto';
  subAgents?: boolean;
  subAgentBudget?: Partial<DelegationBudget>;
  /** Offer durable clarification. Disable for non-interactive workers. */
  userInput?: boolean;
  /** Review PlanningLoop plans before execution. Defaults to the system config for interactive agents. */
  planApproval?: boolean;
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
  readonly toolPolicy: ToolPolicy;
  private readonly modelProvider?: ModelProvider;

  constructor(options: AgentRuntimeOptions) {
    this.db = options.db ?? getSharedConnection();
    this.tools = options.tools ?? this.createTools(options.workspaceRoot);
    this.toolPolicy = options.toolPolicy ?? new DefaultToolPolicy({
      confirmTools: config.tools.requireApproval,
    });
    this.modelProvider = options.modelProvider;
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
    const disabledTools = config.tools?.disabled ?? [];
    const memoryToolDisabled = disabledTools.includes(MANAGE_MEMORY_TOOL_NAME);
    if (!memoryToolDisabled && !tools.has(MANAGE_MEMORY_TOOL_NAME)) {
      tools.register(createManageMemoryTool({
        memoryStore: this.stores.memories,
        threadId: options.threadId,
      }));
    }
    const inputToolDisabled = disabledTools.includes(REQUEST_USER_INPUT_TOOL_NAME);
    if (options.userInput !== false && !inputToolDisabled && !tools.has(REQUEST_USER_INPUT_TOOL_NAME)) {
      tools.register(createRequestUserInputTool());
    }
    // Keep preflight resolution aligned with AgentLoop's compatibility path:
    // older embedders may provide only openai + model in their config.
    const provider =
      this.modelProvider ??
      config.modelProvider ??
      new OpenAICompatibleProvider(config.openai, modelName());
    const required: RequiredModelCapability[] = ['streaming'];
    if (tools.list().length > 0) required.push('toolCalling');
    assertModelCapabilities(
      provider,
      required,
      `AgentRuntime with ${tools.list().length} registered tools`,
    );
    return new AgentLoop({
      db: this.db,
      tools,
      threadId: options.threadId,
      taskId: options.taskId,
      signal: options.signal,
      enablePlanning: options.planning,
      subAgents: options.subAgents,
      subAgentBudget: options.subAgentBudget,
      runStore: this.stores.runs,
      toolCallStore: this.stores.toolCalls,
      traceEventStore: this.stores.traces,
      memoryStore: this.stores.memories,
      toolPolicy: options.userInput === false ? undefined : this.toolPolicy,
      requirePlanApproval:
        options.userInput !== false && (options.planApproval ?? config.runtime.planApproval),
      modelProvider: this.modelProvider,
    });
  }

  private createTools(workspaceRoot: string): ToolRegistry {
    const tools = new ToolRegistry();
    tools.registerMany(createBuiltInTools(new Sandbox(workspaceRoot), {
      disabled: config.tools?.disabled,
      search: config.tools?.search,
    }));
    return tools;
  }
}
