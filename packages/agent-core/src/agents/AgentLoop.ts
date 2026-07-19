import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { config } from '../config.js';
import {
  modelName,
  modelTimeoutMs,
  runtimeSettings,
  strategySettings,
  subAgentSettings,
} from '../configAccess.js';
import Database from 'better-sqlite3';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolCall, ToolResult } from '../tools/types.js';
import { Message } from './types.js';
import { ContextManager } from '../context/ContextManager.js';
import { PersistenceContextManager } from '../context/PersistenceContextManager.js';
import { estimateTokens } from '../context/tokenEstimate.js';
import { Planner } from '../planning/Planner.js';
import { ReasoningChain } from '../planning/ReasoningChain.js';
import type { Plan } from '../planning/types.js';
import { TaskJudge } from '../planning/TaskJudge.js';
import { parsePlanReviewAnswer } from '../planning/planReview.js';
import { getSharedConnection } from '../db/connection.js';
import { RunStore } from '../db/runStore.js';
import { ToolCallStore } from '../db/toolCallStore.js';
import { TraceEventStore } from '../db/traceEventStore.js';
import { MemoryStore } from '../db/memoryStore.js';
import {
  MANAGE_MEMORY_SYSTEM_INSTRUCTION,
  MANAGE_MEMORY_TOOL_NAME,
} from '../memory/manageMemoryTool.js';
import { CreateToolCallInput, Memory, type AgentRun } from '../db/types.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelProvider, TokenUsage } from '../model/types.js';
import { SubAgentRunner, type DelegationBudget } from './SubAgentRunner.js';
import { createSpawnAgentTool } from './spawnAgentTool.js';
import { ModelCaller } from './ModelCaller.js';
import { RunRecorder } from './RunRecorder.js';
import { ToolRunner } from './ToolRunner.js';
import { SimpleLoop } from './loops/SimpleLoop.js';
import { PlanningLoop } from './loops/PlanningLoop.js';
import type { LoopInfrastructure, LoopStrategy } from './loops/types.js';
import {
  assessCheckpointRecovery,
  type RunCheckpoint,
} from './checkpoint.js';
import type { AgentEvent } from './events.js';
import type { AgentRunResult, RunContext } from './RunContext.js';
import type { LoopResult, TerminalLoopResult } from './RunContext.js';
import {
  REQUEST_USER_INPUT_SYSTEM_INSTRUCTION,
  REQUEST_USER_INPUT_TOOL_NAME,
} from './requestUserInputTool.js';
import type { UserInputRequest } from './requestUserInputTool.js';
import {
  parseToolApprovalAnswer,
  ToolApprovalRequiredError,
  type ToolPolicy,
} from '../tools/policy.js';
import { StrategyController } from './StrategyController.js';

export type { AgentLoopEvent } from './events.js';

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
  traceEventStore?: TraceEventStore;
  memoryStore?: MemoryStore;
  maxContextTokens?: number;
  recentTokenBudget?: number;
  signal?: AbortSignal;
  /** Offer the spawn_agent tool for delegating subtasks (default true). */
  subAgents?: boolean;
  /** Internal: current delegation depth. Sub-agents are constructed at depth 1. */
  subAgentDepth?: number;
  /** Maximum delegation depth before spawn_agent is withheld (default 1). */
  maxSubAgentDepth?: number;
  /** Resource limits shared by all sub-agents created during one parent Run. */
  subAgentBudget?: Partial<DelegationBudget>;
  /** Runtime tool authorization policy. Omit to execute registered tools directly. */
  toolPolicy?: ToolPolicy;
  /** In-run direct-to-planning transition policy. */
  strategyController?: StrategyController;
  /** Pause after planning so an interactive user can approve the frozen plan. */
  requirePlanApproval?: boolean;
}

interface ExecutionRecovery {
  checkpoint: RunCheckpoint;
  resumedFromRunId: string;
  addUserMessage: false;
  inputAnswer?: string;
  inputRequestId?: string;
  pendingInput?: UserInputRequest;
}

interface PreparedExecution {
  startedMs: number;
  runId?: string;
  reasoning: ReasoningChain;
}

interface ApprovalContinuation {
  terminalResult?: TerminalLoopResult;
  approvedToolResult?: { stepId?: string; result: ToolResult };
}

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
  private readonly traceEventStore?: TraceEventStore;
  private readonly memoryStore?: MemoryStore;
  private signal?: AbortSignal;
  private readonly taskId?: string;
  private readonly simpleLoop: SimpleLoop;
  private readonly planningLoop: PlanningLoop;
  private readonly toolRunner: ToolRunner;
  private readonly strategyController: StrategyController;
  private lastReasoningChain: ReasoningChain;

  constructor(options: AgentLoopOptions = {}) {
    super();
    const runtimeConfig = runtimeSettings();
    const subAgentConfig = subAgentSettings();
    const baseSystemPrompt = options.systemPrompt ?? runtimeConfig.systemPrompt;
    const systemInstructions = [baseSystemPrompt];
    if (options.tools?.has(MANAGE_MEMORY_TOOL_NAME)) {
      systemInstructions.push(MANAGE_MEMORY_SYSTEM_INSTRUCTION);
    }
    if (options.tools?.has(REQUEST_USER_INPUT_TOOL_NAME)) {
      systemInstructions.push(REQUEST_USER_INPUT_SYSTEM_INSTRUCTION);
    }
    this.systemPrompt = systemInstructions.join(' ');
    this.maxRetries = options.maxRetries ?? runtimeConfig.maxRetries;
    this.maxToolIterations = options.maxToolIterations ?? runtimeConfig.maxToolIterations;
    this.maxReplanAttempts = options.maxReplanAttempts ?? runtimeConfig.maxReplanAttempts;
    this.maxRetryAttempts = options.maxRetryAttempts ?? runtimeConfig.maxRetryAttempts;
    this.enablePlanning = options.enablePlanning ?? false;
    this.timeoutMs =
      options.timeoutMs ?? modelTimeoutMs();
    this.threadId = options.threadId;
    this.taskId = options.taskId;
    this.strategyController = options.strategyController ?? new StrategyController(strategySettings());
    this.toolRegistry = options.tools;
    this.toolExecutor = this.toolRegistry ? new ToolExecutor(this.toolRegistry) : undefined;
    this.signal = options.signal;
    // Resolve the model provider chain. Falls back to wrapping config.openai
    // directly so tests/eval that mock the raw client keep working.
    this.modelProvider =
      options.modelProvider ??
      config.modelProvider ??
      new OpenAICompatibleProvider(config.openai, modelName());

    // Sub-agent support: below the depth cap, offer the spawn_agent tool on a
    // cloned registry (never mutate the shared one). Sub-agents are built at
    // depth + 1, so at the cap they cannot spawn further agents — recursion
    // is impossible by construction.
    this.subAgentDepth = options.subAgentDepth ?? 0;
    this.maxSubAgentDepth = options.maxSubAgentDepth ?? subAgentConfig.maxDepth;
    const subAgentsEnabled = options.subAgents ?? subAgentConfig.enabled;
    if (subAgentsEnabled && this.toolRegistry && this.subAgentDepth < this.maxSubAgentDepth) {
      // Sub-agents run on the utility model when configured (cheaper); an
      // explicitly pinned provider (tests, eval) always wins.
      const subAgentProvider =
        options.modelProvider ?? config.utilityModelProvider ?? this.modelProvider;
      this.subAgentRunner = new SubAgentRunner({
        tools: this.toolRegistry,
        modelProvider: subAgentProvider,
        signal: () => this.signal,
        budget: {
          maxTasksPerRun: subAgentConfig.maxTasksPerRun,
          maxConcurrency: subAgentConfig.maxConcurrency,
          maxTotalTokens: subAgentConfig.maxTotalTokens,
          taskTimeoutMs: subAgentConfig.taskTimeoutMs,
          maxToolIterations: subAgentConfig.maxToolIterations,
          ...options.subAgentBudget,
        },
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
    this.lastReasoningChain = new ReasoningChain();

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

    if (options.threadId) {
      const db = options.db ?? getSharedConnection();
      this.runStore = options.runStore ?? new RunStore(db);
      this.toolCallStore = options.toolCallStore ?? new ToolCallStore(db);
      this.traceEventStore = options.traceEventStore ?? new TraceEventStore(db);
    }

    // Constructed after the persistence stores so trace persistence is wired.
    this.recorder = new RunRecorder({
      traceEventStore: this.traceEventStore,
      onEvent: (event: AgentEvent) => this.emit('event', event),
      onContextTokens: (promptTokens) => this.contextManager.updateLastKnownTokens(promptTokens),
    });
    this.planner.onTrace = (event) => this.recorder.record(event);
    this.taskJudge.onTrace = (event) => this.recorder.record(event);
    this.contextManager.onUsage = trackAuxUsage;
    this.contextManager.onTrace = (event) => this.recorder.record(event);

    // Execution strategies share one infrastructure bundle; adding a new
    // loop mode means a new LoopStrategy implementation, not surgery here.
    this.toolRunner = new ToolRunner({
      executor: this.toolExecutor,
      contextManager: this.contextManager,
      recorder: this.recorder,
      checkSignal: () => this.checkSignal(),
      persist: (runId, toolCall, result) => this.persistToolCall(runId, toolCall, result),
      policy: options.toolPolicy,
    });
    const infra: LoopInfrastructure = {
      contextManager: this.contextManager,
      modelCaller: this.modelCaller,
      recorder: this.recorder,
      toolRegistry: this.toolRegistry,
      toolRunner: this.toolRunner,
      planner: this.planner,
      taskJudge: this.taskJudge,
      subAgentRunner: this.subAgentRunner,
      maxToolIterations: this.maxToolIterations,
      maxReplanAttempts: this.maxReplanAttempts,
      maxRetryAttempts: this.maxRetryAttempts,
      requirePlanApproval: options.requirePlanApproval ?? false,
      checkSignal: () => this.checkSignal(),
      recordRecoveryPoint: (runId, checkpoint) => this.recordRecoveryPoint(runId, checkpoint),
    };
    this.simpleLoop = new SimpleLoop(infra);
    this.planningLoop = new PlanningLoop(infra);
  }

  async chat(message: string, signal?: AbortSignal): Promise<AgentRunResult> {
    const waiting = this.threadId && this.runStore?.getWaitingByThread(this.threadId);
    if (waiting) {
      throw new Error(`Thread is waiting for user input on run ${waiting.id}. Continue or cancel it first.`);
    }
    return this.execute(message, signal);
  }

  async resumeRun(runId: string, signal?: AbortSignal): Promise<AgentRunResult> {
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
    const checkpoint = this.readRecoveryPoint(interruptedRun);
    if (!checkpoint) {
      throw new Error(`Run ${runId} has no checkpoint and cannot be resumed.`);
    }
    if (checkpoint.loopMode !== 'planning') {
      throw new Error(`Run ${runId} is not an interrupted planning run.`);
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

  async continueRun(runId: string, answer: string, signal?: AbortSignal): Promise<AgentRunResult> {
    if (!this.runStore || !this.threadId) {
      throw new Error('Run continuation requires a persisted thread and RunStore.');
    }
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer) throw new Error('A non-empty answer is required.');
    const waitingRun = this.runStore.getById(runId);
    if (!waitingRun || waitingRun.threadId !== this.threadId) {
      throw new Error(`Waiting run not found in this thread: ${runId}`);
    }
    const checkpoint = this.readRecoveryPoint(waitingRun);
    if (waitingRun.status !== 'waiting_for_input' || !checkpoint?.pendingInput) {
      throw new Error(`Run ${runId} is not waiting for user input.`);
    }
    this.signal = signal ?? this.signal;
    this.checkSignal();
    const pendingInput = checkpoint.pendingInput;
    if (pendingInput?.kind === 'tool_approval' && !parseToolApprovalAnswer(normalizedAnswer)) {
      throw new Error('Tool approval requires an explicit approve or reject answer.');
    }
    if (pendingInput?.kind === 'plan_approval') {
      const review = parsePlanReviewAnswer(normalizedAnswer);
      const limits = pendingInput.planReview;
      if (review.decision === 'revise' && limits && limits.revision >= limits.maxRevisions) {
        throw new Error('The plan has already been revised once. Reply approve or reject.');
      }
    }
    if (!this.runStore.claimWaiting(runId)) {
      throw new Error(`Run ${runId} was already continued or cancelled.`);
    }
    const continuationCheckpoint = JSON.parse(JSON.stringify(checkpoint)) as RunCheckpoint;
    delete continuationCheckpoint.pendingInput;
    return this.execute(checkpoint.originalMessage, signal, {
      checkpoint: continuationCheckpoint,
      resumedFromRunId: runId,
      addUserMessage: false,
      inputAnswer: normalizedAnswer,
      inputRequestId: pendingInput.id,
      pendingInput,
    });
  }

  cancelWaitingRun(runId: string): boolean {
    if (!this.runStore || !this.threadId) return false;
    const run = this.runStore.getById(runId);
    if (!run || run.threadId !== this.threadId) return false;
    if (!this.runStore.cancelWaiting(runId)) return false;
    return true;
  }

  private async execute(
    message: string,
    signal?: AbortSignal,
    recovery?: ExecutionRecovery,
  ): Promise<AgentRunResult> {
    const execution = this.prepareRun(message, signal, recovery);
    try {
      const result = await this.executeStrategy(message, execution, recovery);
      return this.finalizeRun(execution, result);
    } catch (error) {
      this.failExecution(execution, error);
      throw error;
    } finally {
      // Flush any buffered streaming deltas as one aggregated trace row per
      // stream, and clear run correlation.
      this.recorder.endRun();
    }
  }

  /** Phase 1: establish request context, Run correlation and opening Trace. */
  private prepareRun(
    message: string,
    signal?: AbortSignal,
    recovery?: ExecutionRecovery,
  ): PreparedExecution {
    const startedMs = Date.now();
    this.signal = signal ?? this.signal;
    this.checkSignal();
    this.subAgentRunner?.resetBudget();
    if (recovery?.addUserMessage !== false) {
      this.contextManager.addMessage({ role: 'user', content: message });
    }
    const shouldAddInputAnswer =
      !recovery?.pendingInput?.kind ||
      recovery.pendingInput.kind === 'clarification';
    if (recovery?.inputAnswer && shouldAddInputAnswer) {
      this.contextManager.addMessage({ role: 'user', content: recovery.inputAnswer });
    }
    this.recorder.reset();
    const reasoning = new ReasoningChain();
    this.lastReasoningChain = reasoning;

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
    if (recovery?.inputRequestId) {
      this.recorder.record({ type: 'input_received', requestId: recovery.inputRequestId });
    }
    return { startedMs, runId, reasoning };
  }

  /** Phase 2: resolve continuation, recall memory, select and run one strategy. */
  private async executeStrategy(
    message: string,
    execution: PreparedExecution,
    recovery?: ExecutionRecovery,
  ): Promise<TerminalLoopResult> {
    const approval = await this.continueApprovedTool(execution.runId, recovery);
    if (approval.terminalResult) return approval.terminalResult;

    const memoryQuery = recovery?.pendingInput?.kind === 'clarification'
      ? recovery.inputAnswer ?? message
      : message;
    const memoryText = this.recallMemory(memoryQuery);

    // Planning requires both the opt-in and a tool registry; in 'auto' mode
    // a cheap classifier decides per message whether planning is worth it.
    const planningEnabled = (recovery || this.enablePlanning !== false) && this.toolRegistry;
    const loop: LoopStrategy = recovery
      ? recovery.checkpoint.loopMode === 'planning' ? this.planningLoop : this.simpleLoop
      : planningEnabled && await this.resolvePlanningMode(message)
        ? this.planningLoop
        : this.simpleLoop;
    const runContext: RunContext = {
      message,
      runId: execution.runId,
      taskId: this.taskId,
      threadId: this.threadId,
      signal: this.signal,
      memoryText,
      reasoning: execution.reasoning,
      strategy:
        !recovery && this.enablePlanning === 'auto' && loop === this.simpleLoop
          ? { controller: this.strategyController, switchCount: 0 }
          : undefined,
      recovery: recovery
        ? {
            checkpoint: recovery.checkpoint,
            resumedFromRunId: recovery.resumedFromRunId,
            approvedToolResult: approval.approvedToolResult,
            pendingInput: recovery.pendingInput,
            inputAnswer: recovery.inputAnswer,
          }
        : undefined,
    };
    const result = await this.runStrategy(loop, runContext, message, recovery);
    if (result.status !== 'switch_strategy') return result;

    this.recorder.record({
      type: 'strategy_switch',
      from: result.from,
      to: result.to,
      reason: result.reason,
      trigger: {
        phase: result.trigger.phase,
        toolIteration: result.trigger.toolIteration,
        toolCallNames: result.trigger.toolCallNames,
        switchCount: result.trigger.switchCount + 1,
      },
    });
    const planningResult = await this.runStrategy(
      this.planningLoop,
      { ...runContext, strategy: undefined },
      message,
      recovery,
    );
    if (planningResult.status === 'switch_strategy') {
      throw new Error('PlanningLoop cannot request another strategy switch.');
    }
    return planningResult;
  }

  private async runStrategy(
    loop: LoopStrategy,
    runContext: RunContext,
    message: string,
    recovery?: ExecutionRecovery,
  ): Promise<LoopResult> {
    try {
      return await loop.run(runContext);
    } catch (error) {
      if (!(error instanceof ToolApprovalRequiredError)) throw error;
      const checkpoint = this.createApprovalCheckpoint(
        loop,
        runContext.runId,
        message,
        recovery,
        error.request,
      );
      return {
        status: 'waiting_for_input',
        reply: error.request.question,
        inputRequest: error.request,
        checkpoint,
      };
    }
  }

  /** Phase 3: persist the terminal lifecycle state and build the public result. */
  private finalizeRun(execution: PreparedExecution, result: TerminalLoopResult): AgentRunResult {
    const usage = this.recorder.getUsage();
    if (result.status === 'waiting_for_input') {
      // The model's tool-call message remains internal, but the actual
      // question is part of the user-visible conversation and survives
      // /history plus process restarts like any normal assistant message.
      this.contextManager.addMessage({ role: 'assistant', content: result.inputRequest.question });
      this.recordRecoveryPoint(execution.runId, result.checkpoint);
      this.recorder.record({ type: 'input_required', request: result.inputRequest });
      this.recorder.record({
        type: 'run',
        phase: 'waiting_for_input',
        durationMs: Date.now() - execution.startedMs,
      });
      this.recorder.endRun();
      this.waitRun(execution.runId);
      return {
        status: 'waiting_for_input',
        reply: result.reply,
        inputRequest: result.inputRequest,
        events: this.recorder.getEvents(),
        runId: execution.runId,
        tokenUsage: usage,
      };
    }
    this.recorder.record({
      type: 'run',
      phase: 'completed',
      durationMs: Date.now() - execution.startedMs,
    });
    this.recorder.endRun();
    this.completeRun(execution.runId);
    return {
      status: 'completed',
      reply: result.reply,
      events: this.recorder.getEvents(),
      runId: execution.runId,
      tokenUsage: usage,
    };
  }

  private failExecution(execution: PreparedExecution, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.recorder.record({
      type: 'run',
      phase: this.signal?.aborted ? 'cancelled' : 'failed',
      durationMs: Date.now() - execution.startedMs,
      error: message,
    });
    this.recorder.endRun();
    this.failRun(execution.runId, message);
  }

  private async continueApprovedTool(
    runId: string | undefined,
    recovery?: ExecutionRecovery,
  ): Promise<ApprovalContinuation> {
    const approval = recovery?.pendingInput?.approval;
    if (recovery?.pendingInput?.kind !== 'tool_approval' || !approval) return {};

    const decision = parseToolApprovalAnswer(recovery.inputAnswer ?? '');
    if (decision === 'reject') {
      const rejected: ToolResult = { success: false, error: 'Tool execution rejected by user.' };
      this.toolRunner.recordResult(approval.toolCall, rejected, {
        runId,
        stepId: approval.stepId,
        attempt: approval.attempt,
        status: 'rejected',
        persist: true,
        contextMode: 'observation',
      });
      const reply = `Cancelled ${approval.toolCall.name}; the tool was not executed.`;
      this.contextManager.addMessage({ role: 'assistant', content: reply });
      this.recorder.record({ type: 'message', content: reply });
      return { terminalResult: { status: 'completed', reply } };
    }

    const approvedCall: ToolCall = {
      ...approval.toolCall,
      id: `${approval.toolCall.id}:approved:${crypto.randomUUID()}`,
    };
    this.toolRunner.recordCalls([approvedCall], {
      stepId: approval.stepId,
      attempt: approval.attempt,
    });
    const result = await this.toolRunner.execute(approvedCall, {
      runId,
      stepId: approval.stepId,
      attempt: approval.attempt,
      approvedFingerprint: approval.fingerprint,
      contextMode: 'observation',
    });
    return { approvedToolResult: { stepId: approval.stepId, result } };
  }

  /** Recall is optional context; its failure remains visible but non-fatal. */
  private recallMemory(query: string): string | undefined {
    let memoryText: string | undefined;
    this.contextManager.clearMemoryContext();
    if (!this.memoryStore) return memoryText;
    try {
      const recall = this.memoryStore.recallRelevantMemories(query, { threadId: this.threadId });
      if (recall.memories.length > 0) {
        memoryText = this.formatMemories(recall.memories);
        this.contextManager.setMemoryContext(memoryText);
      }
      this.recorder.record({
        type: 'memory_recall',
        ...recall.report,
        injectedMemoryIds: recall.memories.map((memory) => memory.id),
        injectedCharacters: memoryText?.length ?? 0,
        estimatedTokens: estimateTokens(memoryText ?? ''),
      });
    } catch (error) {
      this.recorder.record({
        type: 'memory_recall',
        keywords: [],
        candidateCount: 0,
        selectedCount: 0,
        candidates: [],
        injectedMemoryIds: [],
        injectedCharacters: 0,
        estimatedTokens: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return memoryText;
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
    return this.lastReasoningChain;
  }

  getEvents(): AgentEvent[] {
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
          'You are a cost-aware routing controller for an agent runtime. ' +
          'Reply with exactly one word: "plan" or "direct". ' +
          'Choose plan only for work that clearly needs dependent multi-stage execution, ' +
          'coordinated changes, explicit verification/recovery, or decomposition of an ambiguous task. ' +
          'Choose direct for conversation, memory recall, concise answers, and one or two independent ' +
          'read-only or tool operations. The runtime can safely promote a direct task before a large ' +
          'tool batch, so when uncertain choose direct.',
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
      reasoningChain: this.lastReasoningChain.getSteps(),
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
      reasoningChain: this.lastReasoningChain.getSteps(),
      traceStatus: trace.status,
      droppedTraceEvents: trace.droppedEventCount,
      traceError: trace.error,
    });
  }

  private waitRun(runId: string | undefined): void {
    if (!runId || !this.runStore) return;
    const trace = this.recorder.getTraceHealth();
    this.runStore.update(runId, {
      status: 'waiting_for_input',
      endTime: new Date().toISOString(),
      reasoningChain: this.lastReasoningChain.getSteps(),
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

  private recordRecoveryPoint(runId: string | undefined, checkpoint: RunCheckpoint): void {
    if (!runId || !this.runStore) return;
    // The ordered Trace is the single recovery source for new runs. This
    // mandatory write replaces the old agent_runs.checkpoint mirror.
    this.recorder.recordRecoveryPoint(checkpoint);
  }

  private formatMemories(memories: Memory[]): string {
    return memories.map((m) => `${m.key}: ${m.value}`).join('\n');
  }

  private createApprovalCheckpoint(
    loop: LoopStrategy,
    runId: string | undefined,
    message: string,
    recovery: ExecutionRecovery | undefined,
    request: UserInputRequest,
  ): RunCheckpoint {
    if (loop === this.planningLoop) {
      const persistedRun = runId ? this.runStore?.getById(runId) : undefined;
      const persisted = persistedRun ? this.readRecoveryPoint(persistedRun) : undefined;
      if (!persisted || persisted.loopMode !== 'planning') {
        throw new Error('PlanningLoop approval requires a persisted planning checkpoint.');
      }
      persisted.pendingInput = request;
      return persisted;
    }
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      originalMessage: message,
      loopMode: 'simple',
      recoveryCount: recovery ? recovery.checkpoint.recoveryCount + 1 : 0,
      resumedFromRunId: recovery?.resumedFromRunId,
      pendingInput: request,
    };
  }

  /** Trace-first recovery read with a legacy checkpoint fallback. */
  private readRecoveryPoint(run: AgentRun): RunCheckpoint | undefined {
    return this.traceEventStore?.getLatestRecoveryPoint(run.id) ?? run.checkpoint;
  }

}
