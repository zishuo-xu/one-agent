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
import { TaskJudge } from '../planning/TaskJudge.js';
import { JudgeResult, Plan, PlanStep, FailureAnalysis } from '../planning/types.js';
import { getSharedConnection } from '../db/connection.js';
import { RunStore } from '../db/runStore.js';
import { ThreadStore } from '../db/threadStore.js';
import { ToolCallStore } from '../db/toolCallStore.js';
import { TraceEventStore } from '../db/traceEventStore.js';
import { MemoryStore } from '../db/memoryStore.js';
import { MemoryExtractor } from '../memory/MemoryExtractor.js';
import { CreateToolCallInput, Memory } from '../db/types.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelProvider, ModelResponse, ModelToolCall, TokenUsage } from '../model/types.js';
import { SubAgentRunner, SubAgentTask, SubAgentResult } from './SubAgentRunner.js';
import { createSpawnAgentTool } from './spawnAgentTool.js';

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
  private readonly runStore?: RunStore;
  private readonly toolCallStore?: ToolCallStore;
  private readonly threadStore?: ThreadStore;
  private readonly traceEventStore?: TraceEventStore;
  private readonly memoryStore?: MemoryStore;
  private readonly memoryExtractor?: MemoryExtractor;
  private readonly awaitMemoryExtraction: boolean;
  private signal?: AbortSignal;
  private readonly taskId?: string;
  private currentRunId?: string;
  private currentMemoryText?: string;
  private reasoningChain: ReasoningChain;
  private events: AgentLoopEvent[] = [];
  private tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  /** Buffered streaming deltas awaiting one aggregated trace row per stream. */
  private readonly deltaTraceBuffers = new Map<string, string[]>();

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
      augmented.register(createSpawnAgentTool((task) => this.runSubAgent(task)));
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

    this.planner = options.planner ?? new Planner();
    this.taskJudge = options.taskJudge ?? new TaskJudge();
    // Roll auxiliary model calls (planner / judge / auto-mode classifier)
    // into the run's token accounting. Their prompts are not part of the
    // conversation context, so they must not anchor its size estimate.
    const trackAuxUsage = (usage?: TokenUsage) =>
      this.accumulateUsage(usage, { trackPromptSize: false });
    this.planner.onUsage = trackAuxUsage;
    this.taskJudge.onUsage = trackAuxUsage;
    this.reasoningChain = new ReasoningChain();

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
  }

  async chat(message: string, signal?: AbortSignal): Promise<{ reply: string; events: AgentLoopEvent[]; runId?: string; tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    this.signal = signal ?? this.signal;
    this.checkSignal();
    this.contextManager.addMessage({ role: 'user', content: message });
    this.events = [];
    this.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.reasoningChain = new ReasoningChain();
    this.taskJudge.reset();

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
    this.currentRunId = undefined;
    if (this.threadId && this.runStore) {
      const run = this.runStore.create({
        threadId: this.threadId,
        taskId: this.taskId,
        model: config.model,
        status: 'running',
      });
      runId = run.id;
      this.currentRunId = runId;
    }

    try {
      let result: { reply: string; events: AgentLoopEvent[] };
      // Planning requires both the opt-in and a tool registry; in 'auto' mode
      // a cheap classifier decides per message whether planning is worth it.
      const planningEnabled = this.enablePlanning !== false && this.toolRegistry;
      if (!planningEnabled) {
        result = await this.runSimpleLoop(runId);
      } else if (await this.resolvePlanningMode(message)) {
        result = await this.runPlanningLoop(message, runId, this.currentMemoryText);
      } else {
        result = await this.runSimpleLoop(runId);
      }
      this.completeRun(runId);
      await this.persistMemories(message, result.reply);
      const usage = this.tokenUsage.totalTokens > 0 ? this.tokenUsage : undefined;
      return { ...result, runId, tokenUsage: usage };
    } catch (error) {
      if (runId && this.runStore) {
        this.runStore.fail(runId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      // Flush any buffered streaming deltas as one aggregated trace row per
      // stream (must happen before currentRunId is cleared).
      this.flushDeltaTraceBuffers();
      this.currentRunId = undefined;
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
    return [...this.events];
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
        this.accumulateUsage(response.usage, { trackPromptSize: false });
      }
      const verdict = response.content.trim().toLowerCase();
      const plan = verdict.startsWith('plan');
      this.emitEvent({
        type: 'thought',
        content: `Auto planning decision: ${plan ? 'plan' : 'direct'}`,
      });
      return plan;
    } catch {
      this.emitEvent({
        type: 'thought',
        content: 'Auto planning classifier failed; defaulting to plan',
      });
      return true;
    }
  }

  private async runSimpleLoop(runId?: string): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    let toolIterations = 0;

    while (toolIterations <= this.maxToolIterations) {
      this.checkSignal();
      // A single streaming completion serves two purposes at once: it streams
      // the answer text to the client token-by-token (message_delta events)
      // and accumulates any tool-call deltas. If tool calls arrive we execute
      // them and loop; otherwise the text already reached the user live and we
      // just record the final message. No separate "probe" round-trip.
      const { content, toolCalls } = await this.callModelStreaming();

      if (toolCalls && toolCalls.length > 0) {
        const calls = toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: this.safeParseArgs(tc.function.arguments),
        }));

        this.contextManager.addMessage({
          role: 'assistant',
          content,
          tool_calls: toolCalls,
          internal: true,
        });

        for (const call of calls) {
          this.emitEvent({ type: 'tool_call', toolCall: call });

          if (!this.toolExecutor) {
            const result: ToolResult = {
              success: false,
              error: 'No tool executor available',
            };
            this.emitEvent({ type: 'tool_result', toolResult: result });
            this.contextManager.addMessage({
              role: 'tool',
              content: JSON.stringify(result),
              tool_call_id: call.id,
              internal: true,
            });
            this.persistToolCall(runId, call, result);
            continue;
          }

          const result = await this.toolExecutor.execute(call);
          this.emitEvent({ type: 'tool_result', toolResult: result });
          this.contextManager.addMessage({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: call.id,
            internal: true,
          });
          this.persistToolCall(runId, call, result);
        }

        toolIterations++;
        continue;
      }

      // No tool calls: the answer was already streamed live above.
      this.contextManager.addMessage({ role: 'assistant', content });
      this.emitEvent({ type: 'message', content });
      return { reply: content, events: this.events };
    }

    // Tool budget exhausted: rather than throwing away everything the loop
    // has gathered, give the model one tool-free wrap-up call so partial
    // findings still reach the caller — crucial for sub-agents, whose parent
    // would otherwise receive only a bare error. A failing wrap-up call
    // propagates as before.
    this.contextManager.addMessage({
      role: 'user',
      content:
        'The tool-call budget for this turn is exhausted. Based on the work done so far, ' +
        'give your final answer or a summary of partial findings now. Do not call any more tools.',
      internal: true,
    });
    const { content } = await this.callModelStreaming({ includeTools: false });
    this.contextManager.addMessage({ role: 'assistant', content });
    this.emitEvent({ type: 'message', content });
    return { reply: content, events: this.events };
  }

  private async runPlanningLoop(userMessage: string, runId?: string, memories?: string): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    let plan = await this.planner.createPlan(userMessage, this.toolRegistry!.list(), memories);
    this.emitEvent({ type: 'plan', plan });

    // Execution units: single steps run in the main agent; consecutive
    // delegate+parallel steps are grouped into waves that run concurrently
    // in isolated sub-agents.
    let units = this.buildExecutionUnits(this.flattenPlanPostOrder(plan));
    let currentUnitIndex = 0;
    let replanAttempts = 0;
    let retryAttempts = 0;

    while (true) {
      this.checkSignal();
      const unit = units[currentUnitIndex];

      if (!unit) {
        // All steps completed mechanically: finalize without spending a
        // full-history judge call. The judge is still consulted for any
        // incomplete/failed end state.
        if (this.allStepsCompleted(plan.steps)) {
          return this.finalizeAnswer();
        }
        const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
        if (judge.complete || judge.nextAction === 'finalize') {
          return this.finalizeAnswer();
        }
        if (judge.nextAction === 'replan' && replanAttempts < this.maxReplanAttempts) {
          plan = await this.replan(userMessage, plan, judge.failureAnalysis);
          units = this.buildExecutionUnits(this.flattenPlanPostOrder(plan));
          replanAttempts++;
          currentUnitIndex = 0;
          retryAttempts = 0;
          continue;
        }
        return this.finalizeAnswer();
      }

      let executionResult: { next: 'continue' | 'retry' | 'replan' | 'final'; failureAnalysis?: FailureAnalysis };

      if (unit.type === 'single') {
        const step = unit.step;

        if (step.children && step.children.length > 0) {
          const anyChildFailed = step.children.some((child) => child.status === 'failed');
          if (anyChildFailed) {
            step.status = 'failed';
            const failureAnalysis: FailureAnalysis = {
              category: 'tool_failure',
              affectedStepIds: [step.id, ...step.children.filter((c) => c.status === 'failed').map((c) => c.id)],
              rootCause: 'One or more sub-steps failed.',
              recommendation: 'Replan the affected sub-steps or provide a fallback.',
            };
            this.reasoningChain.addFailureAnalysis(failureAnalysis);
            const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
            if (judge.complete || judge.nextAction === 'finalize') {
              return this.finalizeAnswer();
            }
            if (judge.nextAction === 'replan' && replanAttempts < this.maxReplanAttempts) {
              plan = await this.replan(userMessage, plan, judge.failureAnalysis ?? failureAnalysis);
              units = this.buildExecutionUnits(this.flattenPlanPostOrder(plan));
              replanAttempts++;
              currentUnitIndex = 0;
              retryAttempts = 0;
              continue;
            }
            return this.finalizeAnswer();
          }
        }

        // Container step: its children already ran (post-order flatten) and
        // none failed, so executing the parent as a regular step would just
        // duplicate their work. Complete it and move on.
        if (step.children && step.children.length > 0) {
          step.status = 'completed';
          retryAttempts = 0;
          currentUnitIndex++;
          continue;
        }

        step.status = 'running';
        executionResult = step.delegate
          ? await this.executeSingleDelegatedStep(step, plan)
          : await this.executeStep(step, plan, runId);
      } else {
        // On wave retries, completed steps keep their status and are NOT
        // re-executed — only failed/pending steps run again.
        for (const step of unit.steps) {
          if (step.status !== 'completed') {
            step.status = 'running';
          }
        }
        executionResult = await this.executeWave(unit.steps, plan);
      }

      if (executionResult.next === 'final') {
        return this.finalizeAnswer();
      }

      if (executionResult.next === 'replan' && replanAttempts < this.maxReplanAttempts) {
        plan = await this.replan(userMessage, plan, executionResult.failureAnalysis);
        units = this.buildExecutionUnits(this.flattenPlanPostOrder(plan));
        replanAttempts++;
        currentUnitIndex = 0;
        retryAttempts = 0;
        continue;
      }

      if (executionResult.next === 'retry' && retryAttempts < this.maxRetryAttempts) {
        if (unit.type === 'single') {
          unit.step.status = 'pending';
        } else {
          for (const step of unit.steps) {
            if (step.status === 'failed') step.status = 'pending';
          }
        }
        retryAttempts++;
        continue;
      }

      // A failed step must never be silently promoted to 'completed'. If we
      // got here via a retry outcome that the retry budget couldn't absorb,
      // surface the failure to the user instead of lying about success.
      if (executionResult.next === 'retry') {
        return this.finalizeAnswer();
      }

      // Same guard for the replan path: a replan outcome that the replan
      // budget couldn't absorb must also surface as failure, not success.
      if (executionResult.next === 'replan') {
        return this.finalizeAnswer();
      }

      if (unit.type === 'single') {
        unit.step.status = 'completed';
      }
      retryAttempts = 0;
      currentUnitIndex++;
    }
  }

  private flattenPlanPostOrder(plan: Plan): PlanStep[] {
    const order: PlanStep[] = [];
    const visit = (step: PlanStep) => {
      if (step.children && step.children.length > 0) {
        for (const child of step.children) {
          visit(child);
        }
      }
      order.push(step);
    };
    for (const step of plan.steps) {
      visit(step);
    }
    return order;
  }

  /**
   * Group the flattened execution order into units: consecutive steps marked
   * delegate+parallel form a concurrent wave; everything else stays a single
   * step executed by the main agent (serially delegated when only `delegate`
   * is set).
   */
  private buildExecutionUnits(order: PlanStep[]): ExecutionUnit[] {
    const units: ExecutionUnit[] = [];
    let i = 0;
    while (i < order.length) {
      const step = order[i];
      if (step.delegate && step.parallel) {
        const wave: PlanStep[] = [];
        while (i < order.length && order[i].delegate && order[i].parallel) {
          wave.push(order[i]);
          i++;
        }
        units.push({ type: 'wave', steps: wave });
      } else {
        units.push({ type: 'single', step });
        i++;
      }
    }
    return units;
  }

  /**
   * Run a single delegated step in a sub-agent with the full tool set, then
   * map the outcome onto the same next-action vocabulary as executeStep.
   */
  private async executeSingleDelegatedStep(
    step: PlanStep,
    plan: Plan,
  ): Promise<{ next: 'continue' | 'retry' | 'replan' | 'final'; failureAnalysis?: FailureAnalysis }> {
    const result = await this.executeDelegatedStep(step, plan);
    if (result.success) {
      return { next: 'continue' };
    }

    step.status = 'failed';
    const failureAnalysis: FailureAnalysis = {
      category: 'tool_failure',
      affectedStepIds: [step.id],
      rootCause: `Sub-agent failed: ${result.error ?? 'unknown'}`,
      recommendation: 'Retry the delegated step or replan with a different decomposition.',
    };
    this.reasoningChain.addFailureAnalysis(failureAnalysis);
    const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
    if (judge.complete || judge.nextAction === 'finalize') {
      return { next: 'final' };
    }
    if (judge.nextAction === 'replan') {
      return { next: 'replan', failureAnalysis: judge.failureAnalysis ?? failureAnalysis };
    }
    return { next: 'retry', failureAnalysis: judge.failureAnalysis ?? failureAnalysis };
  }

  /**
   * Run a wave of delegate+parallel steps concurrently. Parallel steps are
   * read-only by construction (executeDelegatedStep restricts their tools),
   * so concurrent execution cannot produce write conflicts. Steps that fail
   * are marked failed and the whole wave goes through one Judge decision.
   * On retry, only non-completed steps re-execute.
   */
  private async executeWave(
    steps: PlanStep[],
    plan: Plan,
  ): Promise<{ next: 'continue' | 'retry' | 'replan' | 'final'; failureAnalysis?: FailureAnalysis }> {
    // Completed steps from a previous pass are not re-executed (retry only
    // re-runs what failed); their results are already in the reasoning chain.
    const toRun = steps.filter((step) => step.status !== 'completed');
    const results = await Promise.allSettled(
      toRun.map((step) => this.executeDelegatedStep(step, plan)),
    );

    const failed: Array<{ step: PlanStep; reason: string }> = [];
    for (let i = 0; i < toRun.length; i++) {
      const outcome = results[i];
      if (outcome.status === 'fulfilled' && outcome.value.success) {
        toRun[i].status = 'completed';
      } else {
        toRun[i].status = 'failed';
        const reason =
          outcome.status === 'fulfilled'
            ? outcome.value.error ?? 'unknown sub-agent failure'
            : outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
        failed.push({ step: toRun[i], reason });
      }
    }

    if (failed.length === 0) {
      return { next: 'continue' };
    }

    const failureAnalysis: FailureAnalysis = {
      category: 'tool_failure',
      affectedStepIds: failed.map((f) => f.step.id),
      rootCause: failed
        .map((f) => `Step ${f.step.id} (${f.step.description}): ${f.reason}`)
        .join(' | '),
      recommendation: 'Retry the failed sub-tasks or replan with a different decomposition.',
    };
    this.reasoningChain.addFailureAnalysis(failureAnalysis);

    const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
    if (judge.complete || judge.nextAction === 'finalize') {
      return { next: 'final' };
    }
    if (judge.nextAction === 'replan') {
      return { next: 'replan', failureAnalysis: judge.failureAnalysis ?? failureAnalysis };
    }
    return { next: 'retry', failureAnalysis: judge.failureAnalysis ?? failureAnalysis };
  }

  /**
   * Execute one plan step in an isolated sub-agent. Parallel steps get a
   * read-only tool set (the safety invariant of wave execution); serial
   * delegated steps inherit the full tool set. The sub-agent's result is
   * recorded into the reasoning chain and surfaced into the parent's context
   * so later steps and the final answer can build on it.
   */
  private async executeDelegatedStep(step: PlanStep, plan: Plan): Promise<SubAgentResult> {
    this.reasoningChain.setCurrentPlanStepId(step.id);
    const allowedTools = step.parallel ? READ_ONLY_DELEGATION_TOOLS : undefined;

    const planSummary = plan.steps.map((s) => `${s.id}. ${s.description}`).join('; ');
    const result = await this.runSubAgent({
      task: step.description,
      context: `Executing one step of a larger plan: ${planSummary}`,
      expectedOutcome: step.expectedOutcome,
      allowedTools,
      stepId: step.id,
      memoryText: this.currentMemoryText,
    });

    this.reasoningChain.addThought(
      result.success
        ? `Delegated step completed: ${result.reply.slice(0, 200)}`
        : `Delegated step failed: ${result.error ?? 'unknown'}`,
    );
    this.reasoningChain.commitStep();

    this.contextManager.addMessage({
      role: 'user',
      content:
        `[Sub-agent result for step ${step.id}: ${step.description}]\n` +
        (result.success ? result.reply : `FAILED: ${result.error ?? 'unknown error'}`),
      internal: true,
    });

    return result;
  }

  private async executeStep(
    step: PlanStep,
    plan: Plan,
    runId?: string
  ): Promise<{ next: 'continue' | 'retry' | 'replan' | 'final'; failureAnalysis?: FailureAnalysis }> {
    this.reasoningChain.setCurrentPlanStepId(step.id);

    const constraint = this.resolveStepToolConstraint(step);
    const allowedToolNames = constraint.requiredTool
      ? [constraint.requiredTool]
      : constraint.allowedTools;

    this.contextManager.addMessage({
      role: 'user',
      content: this.buildStepPrompt(step, plan, allowedToolNames, constraint.strict),
      internal: true,
    });

    this.checkSignal();
    const response = await this.callModel({ allowedTools: allowedToolNames });

    // Prefer real content; fall back to reasoning_content for endpoints that
    // return generated text there (provider surfaces both separately).
    const thought = (response.content.trim() ? response.content : (response.reasoning ?? '')).trim();
    if (thought) {
      this.reasoningChain.addThought(thought);
      this.emitEvent({ type: 'thought', content: thought });
      this.contextManager.addMessage({ role: 'assistant', content: thought, internal: true });
    }

    const responseToolCalls = response.toolCalls ?? [];
    if (responseToolCalls.length > 0) {
      const toolCalls = responseToolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: this.safeParseArgs(tc.arguments),
      }));

      // Record the model's tool calls before validating them so the trace is complete.
      this.contextManager.addMessage({
        role: 'assistant',
        content: thought,
        tool_calls: this.toWireToolCalls(responseToolCalls),
        internal: true,
      });

      for (const call of toolCalls) {
        this.reasoningChain.addAction(call);
        this.emitEvent({ type: 'tool_call', toolCall: call });
      }

      const deviation = this.detectToolDeviation(toolCalls, constraint);
      if (deviation) {
        // The assistant tool_calls message is already in context (recorded
        // above for trace completeness). Every tool_call needs a paired tool
        // message or strict providers reject all subsequent requests. These
        // calls were rejected before execution — the placeholder says so.
        for (const call of toolCalls) {
          this.contextManager.addMessage({
            role: 'tool',
            content: JSON.stringify({
              success: false,
              error: 'Tool call rejected: deviates from step tool constraint; not executed.',
            }),
            tool_call_id: call.id,
            internal: true,
          });
        }
        const failureAnalysis: FailureAnalysis = {
          category: 'plan_mismatch',
          affectedStepIds: [step.id],
          rootCause: `Step required ${this.formatExpectedTools(constraint)} but model used: ${toolCalls.map((c) => c.name).join(', ')}`,
          recommendation: 'Retry the step with the expected tool or replan if the tool set is insufficient.',
        };
        this.reasoningChain.addFailureAnalysis(failureAnalysis);
        step.status = 'failed';
        const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
        if (judge.complete || judge.nextAction === 'finalize') {
          return { next: 'final' };
        }
        if (judge.nextAction === 'retry') {
          return { next: 'retry', failureAnalysis };
        }
        if (judge.nextAction === 'replan') {
          return { next: 'replan', failureAnalysis };
        }
        return { next: 'retry', failureAnalysis };
      }

      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        let result: ToolResult;
        if (!this.toolExecutor) {
          result = { success: false, error: 'No tool executor available' };
        } else {
          this.checkSignal();
          result = await this.toolExecutor.execute(call);
        }
        this.reasoningChain.addObservation(result);
        this.emitEvent({ type: 'tool_result', toolResult: result });
        this.contextManager.addMessage({
          role: 'tool',
          content: JSON.stringify(result),
          tool_call_id: call.id,
          internal: true,
        });
        this.persistToolCall(runId, call, result);

        if (!result.success) {
          step.status = 'failed';
          // Calls after the failed one never execute, but their tool_calls
          // are already in context. Pair them with placeholder tool messages
          // (same provider constraint as the deviation path above).
          for (const skipped of toolCalls.slice(i + 1)) {
            this.contextManager.addMessage({
              role: 'tool',
              content: JSON.stringify({
                success: false,
                error: 'Skipped: a preceding tool call failed.',
              }),
              tool_call_id: skipped.id,
              internal: true,
            });
          }
          const failureAnalysis: FailureAnalysis = {
            category: 'tool_failure',
            affectedStepIds: [step.id],
            rootCause: `Tool ${call.name} failed: ${result.error ?? 'unknown'}`,
            recommendation: 'Retry the tool call or replan to work around the failure.',
          };
          this.reasoningChain.addFailureAnalysis(failureAnalysis);
          const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
          if (judge.complete || judge.nextAction === 'finalize') {
            return { next: 'final' };
          }
          if (judge.nextAction === 'retry') {
            return { next: 'retry', failureAnalysis: judge.failureAnalysis ?? failureAnalysis };
          }
          if (judge.nextAction === 'replan') {
            return { next: 'replan', failureAnalysis: judge.failureAnalysis ?? failureAnalysis };
          }
          // Tool failed and Judge did not ask for retry/replan/finalize.
          // Never treat a failed step as completed — surface it as a retry so
          // the outer loop can bound attempts and eventually fail loudly.
          return { next: 'retry', failureAnalysis };
        }
      }
    }

    this.reasoningChain.commitStep();
    this.reasoningChain.setCurrentPlanStepId(undefined);

    // A step that satisfied a required-tool constraint was already validated
    // mechanically (deviation and tool failures are handled above), so skip
    // the judge call for it. Unconstrained steps still get a semantic check.
    if (constraint.requiredTool) {
      return { next: 'continue' };
    }

    const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());

    if (judge.complete || judge.nextAction === 'finalize') {
      return { next: 'final' };
    }
    if (judge.nextAction === 'replan') {
      return { next: 'replan', failureAnalysis: judge.failureAnalysis };
    }
    return { next: 'continue' };
  }

  private resolveStepToolConstraint(step: PlanStep): {
    requiredTool?: string;
    allowedTools?: string[];
    strict: boolean;
  } {
    const requiredTool = step.requiredTool ?? step.toolName;
    const strict = step.strict ?? (requiredTool !== undefined);
    return { requiredTool, allowedTools: step.allowedTools, strict };
  }

  /** Recursively check whether every step (including nested children) completed. */
  private allStepsCompleted(steps: PlanStep[]): boolean {
    return steps.every(
      (s) => s.status === 'completed' && (!s.children || this.allStepsCompleted(s.children))
    );
  }

  private detectToolDeviation(
    toolCalls: ToolCall[],
    constraint: { requiredTool?: string; allowedTools?: string[]; strict: boolean }
  ): boolean {
    if (!constraint.strict) {
      return false;
    }
    if (constraint.requiredTool) {
      return toolCalls.some((call) => call.name !== constraint.requiredTool);
    }
    if (constraint.allowedTools && constraint.allowedTools.length > 0) {
      return toolCalls.some((call) => !constraint.allowedTools!.includes(call.name));
    }
    return false;
  }

  private formatExpectedTools(
    constraint: { requiredTool?: string; allowedTools?: string[] }
  ): string {
    if (constraint.requiredTool) {
      return `tool "${constraint.requiredTool}"`;
    }
    if (constraint.allowedTools && constraint.allowedTools.length > 0) {
      return `one of [${constraint.allowedTools.join(', ')}]`;
    }
    return 'any available tool';
  }

  private async finalizeAnswer(): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    this.contextManager.addMessage({
      role: 'user',
      content: 'Based on the above execution, provide a final answer to the user.',
      internal: true,
    });

    this.checkSignal();
    const content = await this.streamModel({ includeTools: false });

    this.contextManager.addMessage({ role: 'assistant', content });
    this.emitEvent({ type: 'message', content });

    return { reply: content, events: this.events };
  }

  private async replan(userMessage: string, currentPlan: Plan, failureAnalysis?: FailureAnalysis): Promise<Plan> {
    const reflection = failureAnalysis
      ? `The previous plan did not succeed. Category: ${failureAnalysis.category}. ` +
        `Root cause: ${failureAnalysis.rootCause ?? 'unknown'}. ` +
        `Recommendation: ${failureAnalysis.recommendation ?? 'none'}. ` +
        `Affected steps: ${failureAnalysis.affectedStepIds?.join(', ') ?? 'unknown'}.`
      : `The previous plan did not succeed. Plan: ${currentPlan.steps
          .map((s) => s.description)
          .join('; ')}`;
    this.reasoningChain.addReflection(reflection);
    this.emitEvent({ type: 'reflection', content: reflection });

    const newPlan = await this.planner.createPlan(
      userMessage,
      this.toolRegistry!.list(),
      this.currentMemoryText,
      currentPlan,
      failureAnalysis
    );
    this.emitEvent({ type: 'plan', plan: newPlan });
    return newPlan;
  }

  private buildStepPrompt(
    step: PlanStep,
    plan: Plan,
    allowedToolNames?: string[],
    strict?: boolean
  ): string {
    const steps = plan.steps
      .map((s) => `${s.id}. ${s.description} ${s.status === 'completed' ? '✓' : ''}`)
      .join('\n');

    const toolConstraint = allowedToolNames
      ? `You must use one of these tools for this step: ${allowedToolNames.join(', ')}`
      : 'You may use any available tool if needed.';
    const strictHint = strict ? 'Do not deviate from the specified tool.' : '';

    return [
      'Execute the following step from the plan.',
      '',
      'Plan:',
      steps,
      '',
      `Current step: ${step.description}`,
      step.expectedOutcome ? `Expected outcome: ${step.expectedOutcome}` : '',
      '',
      toolConstraint,
      strictHint,
      '',
      'Think step by step. If you need a tool, call it. If the step can be completed without a tool, just explain.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private accumulateUsage(usage?: TokenUsage, options?: { trackPromptSize?: boolean }): void {
    if (!usage) return;
    this.tokenUsage.promptTokens += usage.promptTokens;
    this.tokenUsage.completionTokens += usage.completionTokens;
    this.tokenUsage.totalTokens += usage.totalTokens;
    // Feed the real prompt_tokens back to the context manager so it can use
    // "last real + delta estimate" for the next compression decision. Only
    // this loop's own model calls may anchor that estimate — see runSubAgent.
    if (usage.promptTokens > 0 && options?.trackPromptSize !== false) {
      this.contextManager.updateLastKnownTokens(usage.promptTokens);
    }
  }

  private async callModel(options: { includeTools?: boolean; allowedTools?: string[] } = {}): Promise<ModelResponse> {
    const { includeTools = true, allowedTools } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkSignal();
      try {
        const messages = await this.contextManager.buildContext();
        const tools = includeTools
          ? this.toolRegistry?.getSchemas(allowedTools)
          : undefined;
        const response = await this.modelProvider.complete({
          messages,
          tools,
          timeoutMs: this.timeoutMs,
          signal: this.signal,
        });
        this.accumulateUsage(response.usage);
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `Model call failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  /**
   * Open a single streaming completion that simultaneously streams the answer
   * text to the user (via message_delta events) and accumulates tool-call
   * deltas by their `index`. There is exactly one request per turn, and for
   * tool-less answers the text already reached the client token-by-token by
   * the time the stream ends.
   *
   * Wire-format concerns (reasoning_content probing, non-streaming fallback
   * for endpoints that ignore `stream: true`) live in the provider; this
   * method only applies agent-level policy: reasoning-as-fallback and the
   * no-retry-after-emitted-delta guard.
   */
  private async callModelStreaming(options: { allowedTools?: string[]; includeTools?: boolean } = {}): Promise<{
    content: string;
    toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  }> {
    const { allowedTools, includeTools = true } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkSignal();
      // Track whether we have already streamed partial content to the client
      // during this attempt. Once any message_delta has been emitted we cannot
      // safely retry: a retry would replay the same tokens and the user would
      // see duplicated/garbled output. Only retry while no delta has shipped.
      let emittedDelta = false;
      try {
        const messages = await this.contextManager.buildContext();
        const tools = includeTools
          ? this.toolRegistry?.getSchemas(allowedTools)
          : undefined;

        let content = '';
        // Reasoning-as-fallback policy: stream content live; buffer reasoning
        // and use it as the answer only if the stream ends with no real content.
        let reasoningBuffer = '';
        let hasRealContent = false;
        // Tool-call deltas arrive fragmented across chunks, indexed by position.
        const toolCallMap = new Map<
          number,
          { id?: string; name?: string; arguments: string }
        >();

        for await (const chunk of this.modelProvider.stream({
          messages,
          tools,
          timeoutMs: this.timeoutMs,
          signal: this.signal,
        })) {
          this.checkSignal();
          this.accumulateUsage(chunk.usage);

          if (chunk.content) {
            content += chunk.content;
            if (chunk.content.trim()) hasRealContent = true;
            emittedDelta = true;
            this.emitEvent({ type: 'message_delta', content: chunk.content });
          }
          if (chunk.reasoning && !hasRealContent) {
            reasoningBuffer += chunk.reasoning;
            // Emit reasoning live so the user sees activity instead of
            // staring at a blank spinner for seconds on end.
            this.emitEvent({ type: 'reasoning_delta', content: chunk.reasoning });
          }
          if (chunk.toolCallDeltas) {
            for (const tc of chunk.toolCallDeltas) {
              const existing = toolCallMap.get(tc.index) ?? {
                id: undefined,
                name: undefined,
                arguments: '',
              };
              if (tc.id) existing.id = tc.id;
              if (tc.name) existing.name = tc.name;
              if (tc.argumentsDelta) existing.arguments += tc.argumentsDelta;
              toolCallMap.set(tc.index, existing);
            }
          }
        }

        // If the model only produced reasoning_content (no real content),
        // use it as the answer so the user is not left with an empty reply.
        // Do NOT re-emit it as a message_delta: the reasoning was already
        // streamed live via reasoning_delta, and replaying the whole buffer
        // would print the entire text a second time.
        if (!hasRealContent && reasoningBuffer) {
          content = reasoningBuffer;
          emittedDelta = true;
        }

        const toolCalls =
          toolCallMap.size > 0
            ? [...toolCallMap.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, tc]) => ({
                  id: tc.id ?? '',
                  type: 'function' as const,
                  function: { name: tc.name ?? '', arguments: tc.arguments },
                }))
            : undefined;

        return { content, toolCalls };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (emittedDelta) {
          // Partial content already reached the client; retrying would
          // duplicate it. Surface the error to the caller instead.
          throw lastError;
        }
      }
    }

    throw new Error(
      `Model call failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  private async streamModel(options: { includeTools?: boolean; allowedTools?: string[] } = {}): Promise<string> {
    const { includeTools = false, allowedTools } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkSignal();
      let emittedDelta = false;
      try {
        const messages = await this.contextManager.buildContext();
        const tools = includeTools
          ? this.toolRegistry?.getSchemas(allowedTools)
          : undefined;

        let content = '';
        // Same reasoning/content separation policy as callModelStreaming.
        let reasoningBuffer = '';
        let hasRealContent = false;
        for await (const chunk of this.modelProvider.stream({
          messages,
          tools,
          timeoutMs: this.timeoutMs,
          signal: this.signal,
        })) {
          this.checkSignal();
          this.accumulateUsage(chunk.usage);
          if (chunk.content) {
            content += chunk.content;
            if (chunk.content.trim()) hasRealContent = true;
            emittedDelta = true;
            this.emitEvent({ type: 'message_delta', content: chunk.content });
          }
          if (chunk.reasoning && !hasRealContent) {
            reasoningBuffer += chunk.reasoning;
            this.emitEvent({ type: 'reasoning_delta', content: chunk.reasoning });
          }
        }
        if (!hasRealContent && reasoningBuffer) {
          // Same no-replay policy as callModelStreaming: the reasoning was
          // already streamed live; re-emitting it would double-print.
          content = reasoningBuffer;
          emittedDelta = true;
        }
        return content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (emittedDelta) {
          throw lastError;
        }
      }
    }

    throw new Error(
      `Model call failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  private toWireToolCalls(
    toolCalls: ModelToolCall[]
  ): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
    return toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  /**
   * Execute a subtask in an isolated sub-agent. Emits sub_agent lifecycle
   * events (which flow into the parent's run trace) and rolls the sub-agent's
   * token usage up into this run's accounting.
   */
  private async runSubAgent(task: SubAgentTask): Promise<SubAgentResult> {
    if (!this.subAgentRunner) {
      return {
        success: false,
        reply: '',
        error: 'Sub-agents are disabled or the delegation depth limit was reached',
        toolCalls: [],
        durationMs: 0,
        events: [],
      };
    }

    this.emitEvent({ type: 'sub_agent', task: task.task, status: 'started', stepId: task.stepId });
    const result = await this.subAgentRunner.run(task);
    if (result.tokenUsage) {
      // Roll the cost into the run totals, but never let the sub-agent's
      // (much smaller) prompt anchor this loop's context-size estimate —
      // that would understate the parent's size and skip summarization.
      this.accumulateUsage(result.tokenUsage, { trackPromptSize: false });
    }
    this.emitEvent({
      type: 'sub_agent',
      task: task.task,
      status: result.success ? 'completed' : 'failed',
      stepId: task.stepId,
      reply: result.reply || undefined,
      error: result.error,
      toolCallCount: result.toolCalls.length,
      durationMs: result.durationMs,
      tokenUsage: result.tokenUsage,
      events: result.events,
    });
    return result;
  }

  private emitEvent(event: AgentLoopEvent): void {
    this.events.push(event);
    this.emit('event', event);

    if (!this.traceEventStore) {
      return;
    }
    if (event.type === 'message_delta' || event.type === 'reasoning_delta') {
      // Per-token deltas get one aggregated trace row per stream instead of
      // one row per token — a long answer would otherwise write thousands of
      // rows (write amplification) and slow every trace query.
      const buffer = this.deltaTraceBuffers.get(event.type) ?? [];
      buffer.push(event.content);
      this.deltaTraceBuffers.set(event.type, buffer);
      return;
    }
    // Keep persisted order: buffered deltas happened before this event.
    this.flushDeltaTraceBuffers();
    this.persistTraceEvent(event);
  }

  /** Write buffered delta streams as one aggregated trace row each. */
  private flushDeltaTraceBuffers(): void {
    if (!this.traceEventStore || this.deltaTraceBuffers.size === 0) {
      return;
    }
    for (const [type, chunks] of this.deltaTraceBuffers) {
      if (chunks.length > 0) {
        this.persistTraceEvent({ type, content: chunks.join('') } as AgentLoopEvent);
      }
    }
    this.deltaTraceBuffers.clear();
  }

  private persistTraceEvent(event: AgentLoopEvent): void {
    try {
      this.traceEventStore!.create({
        runId: this.currentRunId,
        taskId: this.taskId,
        threadId: this.threadId,
        eventType: event.type,
        eventData: event,
        model: config.model,
      });
    } catch {
      // Trace persistence should not break the main loop.
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

  private safeParseArgs(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
