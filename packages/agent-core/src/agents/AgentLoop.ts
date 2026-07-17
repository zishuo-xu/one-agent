import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import Database from 'better-sqlite3';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolCall, ToolResult } from '../tools/types.js';
import { Message } from './types.js';
import { ContextManager } from '../context/ContextManager.js';
import { PersistenceContextManager } from '../context/PersistenceContextManager.js';
import { Planner } from '../planning/Planner.js';
import { ReasoningChain } from '../planning/ReasoningChain.js';
import type { Plan, PlanStep } from '../planning/types.js';
import { TaskJudge } from '../planning/TaskJudge.js';
import { getSharedConnection } from '../db/connection.js';
import { RunStore } from '../db/runStore.js';
import { ThreadStore } from '../db/threadStore.js';
import { ToolCallStore } from '../db/toolCallStore.js';
import { TraceEventStore } from '../db/traceEventStore.js';
import { MemoryStore } from '../db/memoryStore.js';
import { MemoryExtractor } from '../memory/MemoryExtractor.js';
import { CreateToolCallInput, Memory } from '../db/types.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelProvider, TokenUsage } from '../model/types.js';
import { SubAgentRunner } from './SubAgentRunner.js';
import { createSpawnAgentTool } from './spawnAgentTool.js';
import { ModelCaller } from './ModelCaller.js';
import { RunRecorder } from './RunRecorder.js';
import { SimpleLoop } from './loops/SimpleLoop.js';
import { PlanningLoop } from './loops/PlanningLoop.js';
import type { LoopInfrastructure, LoopStrategy } from './loops/types.js';

export interface AgentLoopOptions {
  systemPrompt?: string;
  maxRetries?: number;
  timeoutMs?: number;
  maxToolIterations?: number;
  maxReplanAttempts?: number;
  maxRetryAttempts?: number;
  tools?: ToolRegistry;
  contextManager?: ContextManager;
  planner?: Planner;
  taskJudge?: TaskJudge;
  modelProvider?: ModelProvider;
  enablePlanning?: boolean | 'auto';
  threadId?: string;
  taskId?: string;
  db?: Database.Database;
  runStore?: RunStore;
  toolCallStore?: ToolCallStore;
  threadStore?: ThreadStore;
  traceEventStore?: TraceEventStore;
  memoryStore?: MemoryStore;
  memoryExtractor?: MemoryExtractor;
  awaitMemoryExtraction?: boolean;
  maxContextTokens?: number;
  recentTokenBudget?: number;
  signal?: AbortSignal;
  /** Offer the spawn_agent tool for delegating subtasks (default true). */
  subAgents?: boolean;
  /** Internal: current delegation depth. Sub-agents are constructed at depth 1. */
  subAgentDepth?: number;
  /** Maximum delegation depth before spawn_agent is withheld (default 1). */
  maxSubAgentDepth?: number;
}

export type AgentLoopEvent =
  | { type: 'plan'; plan: Plan }
  | { type: 'thought'; content: string }
  | { type: 'reflection'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'message_delta'; content: string }
  | {
      type: 'sub_agent';
      task: string;
      status: 'started' | 'completed' | 'failed';
      stepId?: string;
      reply?: string;
      error?: string;
      toolCallCount?: number;
      durationMs?: number;
      tokenUsage?: TokenUsage;
      /** Condensed internal event stream of the sub-agent (terminal events only). */
      events?: AgentLoopEvent[];
    }
  | { type: 'message'; content: string };

/** Tools available to parallel sub-agents: read-only, so waves cannot conflict. */
const READ_ONLY_DELEGATION_TOOLS = ['read_file', 'list_files', 'search_files', 'web_search', 'get_time'];

type ExecutionUnit = { type: 'single'; step: PlanStep } | { type: 'wave'; steps: PlanStep[] };

export class AgentLoop extends EventEmitter {
  private readonly systemPrompt: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxToolIterations: number;
  private readonly maxReplanAttempts: number;
  private readonly maxRetryAttempts: number;
  private readonly enablePlanning: boolean | 'auto';
  private readonly threadId?: string;
  private toolRegistry?: ToolRegistry;
  private toolExecutor?: ToolExecutor;
  private readonly subAgentDepth: number;
  private readonly maxSubAgentDepth: number;
  private subAgentRunner?: SubAgentRunner;
  private readonly contextManager: ContextManager;
  private readonly planner: Planner;
  private readonly taskJudge: TaskJudge;
  private readonly modelProvider: ModelProvider;
  private readonly modelCaller: ModelCaller;
  private readonly recorder: RunRecorder;
  private readonly runStore?: RunStore;
  private readonly toolCallStore?: ToolCallStore;
  private readonly threadStore?: ThreadStore;
  private readonly traceEventStore?: TraceEventStore;
  private readonly memoryStore?: MemoryStore;
  private readonly memoryExtractor?: MemoryExtractor;
  private readonly awaitMemoryExtraction: boolean;
  private signal?: AbortSignal;
  private readonly taskId?: string;
  private currentMemoryText?: string;
  private readonly simpleLoop: SimpleLoop;
  private readonly planningLoop: PlanningLoop;
  private reasoningChain: ReasoningChain;

  constructor(options: AgentLoopOptions = {}) {
    super();
    this.systemPrompt = options.systemPrompt ?? config.systemPrompt;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxToolIterations = options.maxToolIterations ?? 5;
    this.maxReplanAttempts = options.maxReplanAttempts ?? 3;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 2;
    this.enablePlanning = options.enablePlanning ?? false;
    this.timeoutMs =
      options.timeoutMs ?? (typeof config.timeoutMs === 'number' ? config.timeoutMs : 30000);
    this.threadId = options.threadId;
    this.taskId = options.taskId;
    this.toolRegistry = options.tools;
    this.toolExecutor = this.toolRegistry ? new ToolExecutor(this.toolRegistry) : undefined;
    this.signal = options.signal;
    // Resolve the model provider chain. Falls back to wrapping config.openai
    // directly so tests/eval that mock the raw client keep working.
    this.modelProvider =
      options.modelProvider ??
      config.modelProvider ??
      new OpenAICompatibleProvider(config.openai, config.model);

    // Sub-agent support: below the depth cap, offer the spawn_agent tool on a
    // cloned registry (never mutate the shared one). Sub-agents are built at
    // depth + 1, so at the cap they cannot spawn further agents — recursion
    // is impossible by construction.
    this.subAgentDepth = options.subAgentDepth ?? 0;
    this.maxSubAgentDepth = options.maxSubAgentDepth ?? 1;
    const subAgentsEnabled = options.subAgents ?? true;
    if (subAgentsEnabled && this.toolRegistry && this.subAgentDepth < this.maxSubAgentDepth) {
      // Sub-agents run on the utility model when configured (cheaper); an
      // explicitly pinned provider (tests, eval) always wins.
      const subAgentProvider =
        options.modelProvider ?? config.utilityModelProvider ?? this.modelProvider;
      this.subAgentRunner = new SubAgentRunner({
        tools: this.toolRegistry,
        modelProvider: subAgentProvider,
        signal: () => this.signal,
        maxToolIterations: this.maxToolIterations,
      });
      const augmented = new ToolRegistry();
      augmented.registerMany(this.toolRegistry.list());
      augmented.register(createSpawnAgentTool((task) => this.planningLoop.runSubAgent(task)));
      this.toolRegistry = augmented;
      this.toolExecutor = new ToolExecutor(augmented);
    }

    if (options.contextManager) {
      this.contextManager = options.contextManager;
    } else {
      // Summarization runs on the utility model when configured; an explicitly
      // pinned provider (tests, eval) always wins.
      const utilityProvider =
        options.modelProvider ?? config.utilityModelProvider ?? this.modelProvider;
      if (options.threadId) {
        const db = options.db ?? getSharedConnection();
        this.contextManager = new PersistenceContextManager({
          systemPrompt: this.systemPrompt,
          threadId: options.threadId,
          db,
          maxContextTokens: options.maxContextTokens,
          recentTokenBudget: options.recentTokenBudget,
          modelProvider: utilityProvider,
        });
      } else {
        this.contextManager = new ContextManager({
          systemPrompt: this.systemPrompt,
          maxContextTokens: options.maxContextTokens,
          recentTokenBudget: options.recentTokenBudget,
          modelProvider: utilityProvider,
        });
      }
    }

    // An explicitly pinned provider (tests, eval) always wins for the
    // auxiliary roles too; otherwise they fall back to their own defaults
    // (PLANNING_MODEL / shared chain).
    this.planner =
      options.planner ??
      new Planner(options.modelProvider ? { modelProvider: options.modelProvider } : {});
    this.taskJudge =
      options.taskJudge ??
      new TaskJudge(options.modelProvider ? { modelProvider: options.modelProvider } : {});
    // Roll auxiliary model calls (planner / judge / auto-mode classifier)
    // into the run's token accounting. Their prompts are not part of the
    // conversation context, so they must not anchor its size estimate.
    const trackAuxUsage = (usage?: TokenUsage) =>
      this.recorder.accumulateUsage(usage, { trackPromptSize: false });
    this.planner.onUsage = trackAuxUsage;
    this.taskJudge.onUsage = trackAuxUsage;
    this.reasoningChain = new ReasoningChain();

    // The single entry point for this loop's own model calls: streaming and
    // non-streaming completions, retry policy, usage feedback, live deltas.
    this.modelCaller = new ModelCaller({
      modelProvider: this.modelProvider,
      contextManager: this.contextManager,
      toolRegistry: this.toolRegistry,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal: () => this.signal,
      onUsage: (usage) => this.recorder.accumulateUsage(usage),
      onDelta: (type, content) => this.recorder.record({ type, content }),
    });

    this.memoryStore = options.memoryStore;
    this.memoryExtractor = options.memoryExtractor;
    this.awaitMemoryExtraction = options.awaitMemoryExtraction ?? true;

    if (options.threadId) {
      const db = options.db ?? getSharedConnection();
      this.runStore = options.runStore ?? new RunStore(db);
      this.toolCallStore = options.toolCallStore ?? new ToolCallStore(db);
      this.threadStore = options.threadStore ?? new ThreadStore(db);
      this.traceEventStore = options.traceEventStore ?? new TraceEventStore(db);
    }

    // Constructed after the persistence stores so trace persistence is wired.
    this.recorder = new RunRecorder({
      traceEventStore: this.traceEventStore,
      onEvent: (event) => this.emit('event', event),
      onContextTokens: (promptTokens) => this.contextManager.updateLastKnownTokens(promptTokens),
    });

    // Execution strategies share one infrastructure bundle; adding a new
    // loop mode means a new LoopStrategy implementation, not surgery here.
    const infra: LoopInfrastructure = {
      contextManager: this.contextManager,
      modelCaller: this.modelCaller,
      recorder: this.recorder,
      toolRegistry: this.toolRegistry,
      toolExecutor: this.toolExecutor,
      planner: this.planner,
      taskJudge: this.taskJudge,
      subAgentRunner: this.subAgentRunner,
      maxToolIterations: this.maxToolIterations,
      maxReplanAttempts: this.maxReplanAttempts,
      maxRetryAttempts: this.maxRetryAttempts,
      checkSignal: () => this.checkSignal(),
      persistToolCall: (runId, toolCall, result) => this.persistToolCall(runId, toolCall, result),
    };
    this.simpleLoop = new SimpleLoop(infra);
    this.planningLoop = new PlanningLoop(infra);
  }

  async chat(message: string, signal?: AbortSignal): Promise<{ reply: string; events: AgentLoopEvent[]; runId?: string; tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    this.signal = signal ?? this.signal;
    this.checkSignal();
    this.contextManager.addMessage({ role: 'user', content: message });
    this.recorder.reset();
    this.reasoningChain = new ReasoningChain();

    // Recall relevant long-term memories and inject them into the context.
    this.currentMemoryText = undefined;
    if (this.memoryStore) {
      const memories = this.memoryStore.getRelevantMemories(message);
      if (memories.length > 0) {
        this.currentMemoryText = this.formatMemories(memories);
        this.contextManager.setMemoryContext(this.currentMemoryText);
      }
    }

    let runId: string | undefined;
    if (this.threadId && this.runStore) {
      const run = this.runStore.create({
        threadId: this.threadId,
        taskId: this.taskId,
        model: config.model,
        status: 'running',
      });
      runId = run.id;
      this.recorder.setRun({ runId, taskId: this.taskId, threadId: this.threadId });
    }

    try {
      // Planning requires both the opt-in and a tool registry; in 'auto' mode
      // a cheap classifier decides per message whether planning is worth it.
      const planningEnabled = this.enablePlanning !== false && this.toolRegistry;
      const loop: LoopStrategy =
        planningEnabled && (await this.resolvePlanningMode(message))
          ? this.planningLoop
          : this.simpleLoop;
      const result = await loop.run({
        message,
        runId,
        memories: this.currentMemoryText,
        reasoningChain: this.reasoningChain,
      });
      this.completeRun(runId);
      await this.persistMemories(message, result.reply);
      const usage = this.recorder.getUsage();
      return { reply: result.reply, events: this.recorder.getEvents(), runId, tokenUsage: usage };
    } catch (error) {
      if (runId && this.runStore) {
        this.runStore.fail(runId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      // Flush any buffered streaming deltas as one aggregated trace row per
      // stream, and clear run correlation.
      this.recorder.endRun();
      this.currentMemoryText = undefined;
    }
  }

  getHistory(): Message[] {
    return this.contextManager.getHistory();
  }

  getUserFacingHistory(): Message[] {
    return this.contextManager
      .getHistory()
      .filter(
        (message) =>
          !message.internal &&
          (message.role === 'user' || message.role === 'assistant')
      );
  }

  getContext(): Message[] {
    return this.contextManager.getContextForDisplay();
  }

  getContextInfo(): {
    messageCount: number;
    estimatedTokens: number;
    maxContextTokens?: number;
    hasSummary: boolean;
    recentTokenBudget?: number;
    tokenSource: 'real' | 'estimate';
  } {
    return this.contextManager.getContextInfo();
  }

  getReasoningChain(): ReasoningChain {
    return this.reasoningChain;
  }

  getEvents(): AgentLoopEvent[] {
    return this.recorder.getEvents();
  }

  /**
   * Decide whether this message should go through the planning loop.
   * In 'auto' mode a cheap one-call classifier judges whether the request
   * needs multi-step tool use; the verdict is emitted as a thought event so
   * it shows up in traces. Classifier failure defaults to planning — auto
   * mode opted into planning, and wrongly skipping it loses capability.
   */
  private async resolvePlanningMode(message: string): Promise<boolean> {
    if (this.enablePlanning !== 'auto') {
      return this.enablePlanning === true;
    }
    try {
      const response = await this.modelProvider.complete({
        messages: [
          {
            role: 'system',
            content:
              'You decide whether a user request needs multi-step planning with tools, ' +
              'or can be answered directly. Reply with exactly one word: "plan" or "direct".',
          },
          { role: 'user', content: message },
        ],
        timeoutMs: this.timeoutMs,
        signal: this.signal,
      });
      if (response.usage) {
        this.recorder.accumulateUsage(response.usage, { trackPromptSize: false });
      }
      const verdict = response.content.trim().toLowerCase();
      const plan = verdict.startsWith('plan');
      this.recorder.record({
        type: 'thought',
        content: `Auto planning decision: ${plan ? 'plan' : 'direct'}`,
      });
      return plan;
    } catch {
      this.recorder.record({
        type: 'thought',
        content: 'Auto planning classifier failed; defaulting to plan',
      });
      return true;
    }
  }

  private checkSignal(): void {
    if (this.signal?.aborted) {
      throw new Error('AgentLoop was cancelled');
    }
  }

  private completeRun(runId?: string): void {
    if (!runId || !this.runStore) {
      return;
    }
    this.runStore.update(runId, {
      status: 'completed',
      endTime: new Date().toISOString(),
      reasoningChain: this.reasoningChain.getSteps(),
    });
  }

  private persistToolCall(runId: string | undefined, toolCall: ToolCall, result: ToolResult): void {
    if (!runId || !this.toolCallStore) {
      return;
    }
    const input: CreateToolCallInput = {
      runId,
      toolCall,
      result,
    };
    this.toolCallStore.create(input);
  }

  private formatMemories(memories: Memory[]): string {
    return memories.map((m) => `${m.key}: ${m.value}`).join('\n');
  }

  private async extractAndStoreMemories(userMessage: string, assistantReply: string): Promise<void> {
    if (!this.memoryStore || !this.memoryExtractor) {
      return;
    }

    try {
      const facts = await this.memoryExtractor.extract(userMessage, assistantReply);
      for (const fact of facts) {
        this.memoryStore.create({
          key: fact.key,
          value: fact.value,
          source: 'extracted',
          threadId: this.threadId,
        });
      }
    } catch {
      // Memory extraction should not break the main loop.
    }
  }

  private async persistMemories(userMessage: string, assistantReply: string): Promise<void> {
    const extraction = this.extractAndStoreMemories(userMessage, assistantReply);
    if (this.awaitMemoryExtraction) {
      await extraction;
    }
  }

}
