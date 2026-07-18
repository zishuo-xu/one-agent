import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
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
import type { ModelCallTraceEvent, ModelProvider, TokenUsage } from '../model/types.js';
import { SubAgentRunner } from './SubAgentRunner.js';
import { createSpawnAgentTool } from './spawnAgentTool.js';
import { ModelCaller } from './ModelCaller.js';
import { RunRecorder } from './RunRecorder.js';
import { SimpleLoop } from './loops/SimpleLoop.js';
import { PlanningLoop } from './loops/PlanningLoop.js';
import type { LoopInfrastructure, LoopStrategy } from './loops/types.js';
import {
  assessCheckpointRecovery,
  type RunCheckpoint,
} from './checkpoint.js';

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
  | {
      type: 'run';
      phase: 'started' | 'completed' | 'failed' | 'cancelled';
      loopMode?: 'simple' | 'planning' | 'auto';
      model?: string;
      provider?: string;
      enabledTools?: string[];
      resumedFromRunId?: string;
      durationMs?: number;
      error?: string;
    }
  | ModelCallTraceEvent
  | { type: 'plan'; plan: Plan }
  | {
      type: 'plan_step';
      stepId: string;
      parentStepId?: string;
      status: 'pending' | 'running' | 'completed' | 'failed' | 'retrying';
      attempt?: number;
      failureAnalysis?: import('../planning/types.js').FailureAnalysis;
    }
  | { type: 'thought'; content: string }
  | { type: 'reflection'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall; stepId?: string; attempt?: number }
  | {
      type: 'tool_result';
      toolResult: ToolResult;
      toolCallId?: string;
      stepId?: string;
      attempt?: number;
      status?: 'succeeded' | 'failed' | 'rejected' | 'skipped';
      durationMs?: number;
    }
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
      onTrace: (event) => this.recorder.record(event),
    });

    this.memoryStore = options.memoryStore;
    this.memoryExtractor = options.memoryExtractor;
    this.awaitMemoryExtraction = options.awaitMemoryExtraction ?? false;

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
    this.planner.onTrace = (event) => this.recorder.record(event);
    this.taskJudge.onTrace = (event) => this.recorder.record(event);
    this.contextManager.onUsage = trackAuxUsage;
    this.contextManager.onTrace = (event) => this.recorder.record(event);

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
      saveCheckpoint: (runId, checkpoint) => this.saveCheckpoint(runId, checkpoint),
    };
    this.simpleLoop = new SimpleLoop(infra);
    this.planningLoop = new PlanningLoop(infra);
  }

  async chat(message: string, signal?: AbortSignal): Promise<{ reply: string; events: AgentLoopEvent[]; runId?: string; tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    return this.execute(message, signal);
  }

  async resumeRun(runId: string, signal?: AbortSignal): Promise<{ reply: string; events: AgentLoopEvent[]; runId?: string; tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    if (!this.runStore || !this.threadId) {
      throw new Error('Run recovery requires a persisted thread and RunStore.');
    }
    const interruptedRun = this.runStore.getById(runId);
    if (!interruptedRun || interruptedRun.threadId !== this.threadId) {
      throw new Error(`Recoverable run not found in this thread: ${runId}`);
    }
    if (interruptedRun.status !== 'running') {
      throw new Error(`Run ${runId} is ${interruptedRun.status}, not an interrupted running run.`);
    }
    const checkpoint = interruptedRun.checkpoint;
    if (!checkpoint) {
      throw new Error(`Run ${runId} has no checkpoint and cannot be resumed.`);
    }
    if (checkpoint.recoveryCount >= 3) {
      const reason = 'Maximum recovery count (3) reached.';
      this.runStore.update(runId, {
        status: 'recovery_required',
        endTime: new Date().toISOString(),
        error: reason,
      });
      throw new Error(reason);
    }
    const assessment = assessCheckpointRecovery(checkpoint);
    if (!assessment.resumable) {
      this.runStore.update(runId, {
        status: 'recovery_required',
        endTime: new Date().toISOString(),
        error: assessment.reason,
      });
      throw new Error(assessment.reason);
    }

    this.runStore.update(runId, {
      status: 'interrupted',
      endTime: new Date().toISOString(),
      traceStatus: interruptedRun.traceStatus === 'recording' ? 'partial' : interruptedRun.traceStatus,
      error: 'Execution was interrupted and resumed by a new run.',
    });
    if (checkpoint.activeToolCall) {
      // The previous process persisted the assistant tool_call before it
      // entered the tool. Pair that orphaned call before the next model
      // request; strict providers reject histories with an unmatched call.
      this.contextManager.addMessage({
        role: 'tool',
        tool_call_id: checkpoint.activeToolCall.id,
        content: JSON.stringify({
          success: false,
          error: 'Interrupted before the tool result was durably recorded; retrying safely.',
        }),
        internal: true,
      });
    }
    return this.execute(checkpoint.originalMessage, signal, {
      checkpoint,
      resumedFromRunId: runId,
      addUserMessage: false,
    });
  }

  private async execute(
    message: string,
    signal?: AbortSignal,
    recovery?: { checkpoint: RunCheckpoint; resumedFromRunId: string; addUserMessage: false },
  ): Promise<{ reply: string; events: AgentLoopEvent[]; runId?: string; tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const startedMs = Date.now();
    this.signal = signal ?? this.signal;
    this.checkSignal();
    if (recovery?.addUserMessage !== false) {
      this.contextManager.addMessage({ role: 'user', content: message });
    }
    this.recorder.reset();
    this.reasoningChain = new ReasoningChain();

    // Recall relevant long-term memories and inject them into the context.
    this.currentMemoryText = undefined;
    if (this.memoryStore) {
      const memories = this.memoryStore.getRelevantMemories(message, { threadId: this.threadId });
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
        model: this.modelProvider.model,
        status: 'running',
        traceStatus: 'recording',
      });
      runId = run.id;
      this.recorder.setRun({ runId, taskId: this.taskId, threadId: this.threadId });
    }
    this.recorder.record({
      type: 'run',
      phase: 'started',
      loopMode: this.enablePlanning === 'auto' ? 'auto' : this.enablePlanning ? 'planning' : 'simple',
      model: this.modelProvider.model,
      provider: this.modelProvider.name,
      enabledTools: this.toolRegistry?.list().map((tool) => tool.name) ?? [],
      resumedFromRunId: recovery?.resumedFromRunId,
    });

    try {
      // Planning requires both the opt-in and a tool registry; in 'auto' mode
      // a cheap classifier decides per message whether planning is worth it.
      const planningEnabled = (recovery || this.enablePlanning !== false) && this.toolRegistry;
      const loop: LoopStrategy =
        planningEnabled && (recovery || await this.resolvePlanningMode(message))
          ? this.planningLoop
          : this.simpleLoop;
      const result = await loop.run({
        message,
        runId,
        memories: this.currentMemoryText,
        reasoningChain: this.reasoningChain,
        resumeCheckpoint: recovery?.checkpoint,
        resumedFromRunId: recovery?.resumedFromRunId,
      });
      const usage = this.recorder.getUsage();
      this.recorder.record({
        type: 'run',
        phase: 'completed',
        durationMs: Date.now() - startedMs,
      });
      this.recorder.endRun();
      this.completeRun(runId);
      const memoryPersistence = this.persistMemories(message, result.reply, runId);
      if (this.awaitMemoryExtraction) await memoryPersistence;
      else void memoryPersistence;
      return { reply: result.reply, events: this.recorder.getEvents(), runId, tokenUsage: usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recorder.record({
        type: 'run',
        phase: this.signal?.aborted ? 'cancelled' : 'failed',
        durationMs: Date.now() - startedMs,
        error: message,
      });
      this.recorder.endRun();
      this.failRun(runId, message);
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
          (message.role === 'user' || message.role === 'assistant') &&
          !message.tool_calls?.length &&
          !(message.role === 'user' && message.content.startsWith('Execute the following step'))
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
    const modelCallId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const messages: Message[] = [
      {
        role: 'system',
        content:
          'You decide whether a user request needs multi-step planning with tools, ' +
          'or can be answered directly. Reply with exactly one word: "plan" or "direct".',
      },
      { role: 'user', content: message },
    ];
    this.recorder.record({
      type: 'model_call', phase: 'started', modelCallId, purpose: 'classifier',
      provider: this.modelProvider.name, model: this.modelProvider.model,
      attempt: 0, streaming: false, startedAt, messageCount: messages.length, toolCount: 0,
    });
    try {
      const response = await this.modelProvider.complete({
        messages,
        timeoutMs: this.timeoutMs,
        signal: this.signal,
      });
      if (response.usage) {
        this.recorder.accumulateUsage(response.usage, { trackPromptSize: false });
      }
      const verdict = response.content.trim().toLowerCase();
      const plan = verdict.startsWith('plan');
      this.recorder.record({
        type: 'model_call', phase: 'completed', modelCallId, purpose: 'classifier',
        provider: this.modelProvider.name, model: this.modelProvider.model,
        attempt: 0, streaming: false, startedAt, durationMs: Date.now() - startedMs,
        usage: response.usage,
      });
      this.recorder.record({
        type: 'thought',
        content: `Auto planning decision: ${plan ? 'plan' : 'direct'}`,
      });
      return plan;
    } catch (error) {
      this.recorder.record({
        type: 'model_call', phase: 'failed', modelCallId, purpose: 'classifier',
        provider: this.modelProvider.name, model: this.modelProvider.model,
        attempt: 0, streaming: false, startedAt, durationMs: Date.now() - startedMs,
        error: error instanceof Error ? error.message : String(error),
      });
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

  private completeRun(runId: string | undefined): void {
    if (!runId || !this.runStore) {
      return;
    }
    const trace = this.recorder.getTraceHealth();
    this.runStore.update(runId, {
      status: 'completed',
      endTime: new Date().toISOString(),
      reasoningChain: this.reasoningChain.getSteps(),
      traceStatus: trace.status,
      droppedTraceEvents: trace.droppedEventCount,
      traceError: trace.error,
    });
  }

  private failRun(runId: string | undefined, error: string): void {
    if (!runId || !this.runStore) return;
    const trace = this.recorder.getTraceHealth();
    this.runStore.update(runId, {
      status: this.signal?.aborted ? 'cancelled' : 'failed',
      endTime: new Date().toISOString(),
      error,
      reasoningChain: this.reasoningChain.getSteps(),
      traceStatus: trace.status,
      droppedTraceEvents: trace.droppedEventCount,
      traceError: trace.error,
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

  private saveCheckpoint(runId: string | undefined, checkpoint: RunCheckpoint): void {
    if (!runId || !this.runStore) return;
    this.runStore.update(runId, { checkpoint });
  }

  private formatMemories(memories: Memory[]): string {
    return memories.map((m) => `${m.key}: ${m.value}`).join('\n');
  }

  private async extractAndStoreMemories(
    userMessage: string,
    assistantReply: string,
    sourceRunId?: string,
  ): Promise<void> {
    if (!this.memoryStore || !this.memoryExtractor) {
      return;
    }

    try {
      const facts = await this.memoryExtractor.extract(userMessage, assistantReply);
      for (const fact of facts) {
        this.memoryStore.remember({
          key: fact.key,
          value: fact.value,
          source: 'extracted',
          threadId: this.threadId,
          sourceRunId,
          scope: 'global',
          confidence: 0.7,
        });
      }
    } catch {
      // Memory extraction should not break the main loop.
    }
  }

  private async persistMemories(
    userMessage: string,
    assistantReply: string,
    sourceRunId?: string,
  ): Promise<void> {
    const extraction = this.extractAndStoreMemories(userMessage, assistantReply, sourceRunId);
    if (this.awaitMemoryExtraction) {
      await extraction;
    }
  }

}
