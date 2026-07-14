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
  enablePlanning?: boolean;
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
}

export type AgentLoopEvent =
  | { type: 'plan'; plan: Plan }
  | { type: 'thought'; content: string }
  | { type: 'reflection'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'message_delta'; content: string }
  | { type: 'message'; content: string };

export class AgentLoop extends EventEmitter {
  private readonly systemPrompt: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxToolIterations: number;
  private readonly maxReplanAttempts: number;
  private readonly maxRetryAttempts: number;
  private readonly enablePlanning: boolean;
  private readonly threadId?: string;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly contextManager: ContextManager;
  private readonly planner: Planner;
  private readonly taskJudge: TaskJudge;
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

    if (options.contextManager) {
      this.contextManager = options.contextManager;
    } else if (options.threadId) {
      const db = options.db ?? getSharedConnection();
      this.contextManager = new PersistenceContextManager({
        systemPrompt: this.systemPrompt,
        threadId: options.threadId,
        db,
        maxContextTokens: options.maxContextTokens,
        recentTokenBudget: options.recentTokenBudget,
      });
    } else {
      this.contextManager = new ContextManager({
        systemPrompt: this.systemPrompt,
        maxContextTokens: options.maxContextTokens,
        recentTokenBudget: options.recentTokenBudget,
      });
    }

    this.planner = options.planner ?? new Planner();
    this.taskJudge = options.taskJudge ?? new TaskJudge();
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
      if (!this.enablePlanning || !this.toolRegistry) {
        result = await this.runSimpleLoop(runId);
      } else {
        result = await this.runPlanningLoop(message, runId, this.currentMemoryText);
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

    throw new Error(
      `AgentLoop stopped after ${this.maxToolIterations + 1} tool iteration(s) without a final answer`
    );
  }

  private async runPlanningLoop(userMessage: string, runId?: string, memories?: string): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    let plan = await this.planner.createPlan(userMessage, this.toolRegistry!.list(), memories);
    this.emitEvent({ type: 'plan', plan });

    let executionOrder = this.flattenPlanPostOrder(plan);
    let currentStepIndex = 0;
    let replanAttempts = 0;
    let retryAttempts = 0;

    while (true) {
      this.checkSignal();
      const step = executionOrder[currentStepIndex];

      if (!step) {
        const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
        if (judge.complete || judge.nextAction === 'finalize') {
          return this.finalizeAnswer();
        }
        if (judge.nextAction === 'replan' && replanAttempts < this.maxReplanAttempts) {
          plan = await this.replan(userMessage, plan, judge.failureAnalysis);
          executionOrder = this.flattenPlanPostOrder(plan);
          replanAttempts++;
          currentStepIndex = 0;
          retryAttempts = 0;
          continue;
        }
        return this.finalizeAnswer();
      }

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
            executionOrder = this.flattenPlanPostOrder(plan);
            replanAttempts++;
            currentStepIndex = 0;
            retryAttempts = 0;
            continue;
          }
          return this.finalizeAnswer();
        }
      }

      step.status = 'running';

      const executionResult = await this.executeStep(step, plan, runId);

      if (executionResult.next === 'final') {
        return this.finalizeAnswer();
      }

      if (executionResult.next === 'replan' && replanAttempts < this.maxReplanAttempts) {
        plan = await this.replan(userMessage, plan, executionResult.failureAnalysis);
        executionOrder = this.flattenPlanPostOrder(plan);
        replanAttempts++;
        currentStepIndex = 0;
        retryAttempts = 0;
        continue;
      }

      if (executionResult.next === 'retry' && retryAttempts < this.maxRetryAttempts) {
        step.status = 'pending';
        retryAttempts++;
        continue;
      }

      // A failed step must never be silently promoted to 'completed'. If we
      // got here via a retry outcome that the retry budget couldn't absorb,
      // surface the failure to the user instead of lying about success.
      // (executeStep sets step.status='failed' before returning 'retry'.)
      if (executionResult.next === 'retry') {
        return this.finalizeAnswer();
      }

      step.status = 'completed';
      retryAttempts = 0;
      currentStepIndex++;
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
    const assistantMessage = response.choices[0]?.message;

    const thought = this.extractMessageContent(assistantMessage).trim();
    if (thought) {
      this.reasoningChain.addThought(thought);
      this.emitEvent({ type: 'thought', content: thought });
      this.contextManager.addMessage({ role: 'assistant', content: thought, internal: true });
    }

    if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
      const toolCalls = assistantMessage.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: this.safeParseArgs(tc.function.arguments),
      }));

      // Record the model's tool calls before validating them so the trace is complete.
      this.contextManager.addMessage({
        role: 'assistant',
        content: thought,
        tool_calls: assistantMessage.tool_calls,
        internal: true,
      });

      for (const call of toolCalls) {
        this.reasoningChain.addAction(call);
        this.emitEvent({ type: 'tool_call', toolCall: call });
      }

      const deviation = this.detectToolDeviation(toolCalls, constraint);
      if (deviation) {
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

      for (const call of toolCalls) {
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

  private accumulateUsage(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    const pt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
    const ct = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
    const tt = typeof u.total_tokens === 'number' ? u.total_tokens : pt + ct;
    this.tokenUsage.promptTokens += pt;
    this.tokenUsage.completionTokens += ct;
    this.tokenUsage.totalTokens += tt;
    // Feed the real prompt_tokens back to the context manager so it can use
    // "last real + delta estimate" for the next compression decision.
    if (pt > 0) {
      this.contextManager.updateLastKnownTokens(pt);
    }
  }

  private async callModel(options: { includeTools?: boolean; allowedTools?: string[] } = {}) {
    const { includeTools = true, allowedTools } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkSignal();
      try {
        const messages = await this.contextManager.buildContext();
        const tools = includeTools
          ? this.toolRegistry?.getSchemas(allowedTools)
          : undefined;
        const response = await config.openai.chat.completions.create(
          {
            model: config.model,
            messages: messages as never,
            tools,
          },
          { timeout: this.timeoutMs, signal: this.signal }
        );
        this.accumulateUsage((response as unknown as Record<string, unknown>).usage);
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
   * deltas by their `index`. This replaces the old "probe then stream" flow:
   * there is exactly one request per turn, and for tool-less answers the text
   * already reached the client token-by-token by the time the stream ends.
   *
   * Some compatible endpoints ignore `stream: true` and return a plain object;
   * in that case we fall back to reading content + tool_calls off the whole
   * message and emit a single message_delta so callers keep their contract.
   */
  private async callModelStreaming(options: { allowedTools?: string[] } = {}): Promise<{
    content: string;
    toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  }> {
    const { allowedTools } = options;
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
        const tools = this.toolRegistry?.getSchemas(allowedTools);
        const response = await config.openai.chat.completions.create(
          {
            model: config.model,
            messages: messages as never,
            stream: true,
            stream_options: { include_usage: true },
            tools,
          },
          { timeout: this.timeoutMs, signal: this.signal }
        );

        if (Symbol.asyncIterator in response) {
          let content = '';
          // GLM-5.2 streams a reasoning_content "chain of thought" before the
          // actual answer in delta.content. We must NOT mix them: only stream
          // delta.content to the client live. Buffer reasoning_content and use
          // it as a fallback only if the stream ends with no real content.
          let reasoningBuffer = '';
          let hasRealContent = false;
          let reasoningStarted = false;
          // Tool-call deltas arrive fragmented across chunks and indexed by
          // position; accumulate function name + argument fragments.
          const toolCallMap = new Map<
            number,
            { id?: string; name?: string; arguments: string }
          >();

          for await (const chunk of response) {
            this.checkSignal();
            this.accumulateUsage((chunk as unknown as Record<string, unknown>).usage);
            const { content: contentDelta, reasoning: reasoningDelta } = this.extractDeltaFields(chunk);
            const delta = (chunk as unknown as { choices?: Array<{ delta?: Record<string, unknown> }> })
              .choices?.[0]?.delta;

            // Prefer real content; only buffer reasoning as fallback.
            if (contentDelta) {
              content += contentDelta;
              if (contentDelta.trim()) hasRealContent = true;
              emittedDelta = true;
              this.emitEvent({ type: 'message_delta', content: contentDelta });
            }
            if (reasoningDelta && !hasRealContent) {
              reasoningBuffer += reasoningDelta;
              // Emit reasoning live so the user sees activity instead of
              // staring at a blank spinner for seconds on end.
              if (!reasoningStarted) {
                reasoningStarted = true;
                this.emitEvent({ type: 'reasoning_delta', content: reasoningDelta });
              } else {
                this.emitEvent({ type: 'reasoning_delta', content: reasoningDelta });
              }
            }

            const tcDeltas = delta?.tool_calls as
              | Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>
              | undefined;
            if (tcDeltas) {
              for (const tc of tcDeltas) {
                const idx = tc.index ?? 0;
                const existing = toolCallMap.get(idx) ?? {
                  id: undefined,
                  name: undefined,
                  arguments: '',
                };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                toolCallMap.set(idx, existing);
              }
            }
          }

          // If the model only produced reasoning_content (no real content),
          // use it as the answer so the user is not left with an empty reply.
          if (!hasRealContent && reasoningBuffer) {
            content = reasoningBuffer;
            emittedDelta = true;
            this.emitEvent({ type: 'message_delta', content: reasoningBuffer });
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
        }

        // Non-streaming fallback: endpoint ignored stream:true.
        const nonStreamingResponse = response as unknown as {
          choices: Array<{
            message?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
            };
          }>;
          usage?: Record<string, unknown>;
        };
        this.accumulateUsage(nonStreamingResponse.usage);
        const message = nonStreamingResponse.choices[0]?.message;
        const content = this.extractMessageContent(message);
        if (content) {
          emittedDelta = true;
          this.emitEvent({ type: 'message_delta', content });
        }
        const toolCalls = message?.tool_calls;
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
        const response = await config.openai.chat.completions.create(
          {
            model: config.model,
            messages: messages as never,
            stream: true,
            stream_options: { include_usage: true },
            tools,
          },
          { timeout: this.timeoutMs, signal: this.signal }
        );

        let content = '';
        if (Symbol.asyncIterator in response) {
          // Same reasoning/content separation as callModelStreaming: only
          // stream delta.content live; emit reasoning_content live too.
          let reasoningBuffer = '';
          let hasRealContent = false;
          for await (const chunk of response) {
            this.checkSignal();
            this.accumulateUsage((chunk as unknown as Record<string, unknown>).usage);
            const { content: contentDelta, reasoning: reasoningDelta } = this.extractDeltaFields(chunk);
            if (contentDelta) {
              content += contentDelta;
              if (contentDelta.trim()) hasRealContent = true;
              emittedDelta = true;
              this.emitEvent({ type: 'message_delta', content: contentDelta });
            }
            if (reasoningDelta && !hasRealContent) {
              reasoningBuffer += reasoningDelta;
              this.emitEvent({ type: 'reasoning_delta', content: reasoningDelta });
            }
          }
          if (!hasRealContent && reasoningBuffer) {
            content = reasoningBuffer;
            emittedDelta = true;
            this.emitEvent({ type: 'message_delta', content: reasoningBuffer });
          }
        } else {
          const nonStreamingResponse = response as unknown as {
            choices: Array<{ message?: Record<string, unknown> }>;
          };
          const fallback = this.extractMessageContent(nonStreamingResponse.choices[0]?.message);
          content = fallback;
          if (content) {
            emittedDelta = true;
            this.emitEvent({ type: 'message_delta', content });
          }
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

  private extractMessageContent(message: unknown): string {
    if (!message || typeof message !== 'object') {
      return '';
    }
    const msg = message as Record<string, unknown>;
    const content = this.extractTextContent(msg.content);
    if (content.trim()) {
      return content;
    }
    // Volcengine GLM-5.2 sometimes returns generated text in reasoning_content
    // even for non-streaming completions.
    const reasoning = this.extractTextContent(msg.reasoning_content ?? msg.reasoningContent);
    if (reasoning.trim()) {
      return reasoning;
    }
    return '';
  }

  private extractTextContent(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (!Array.isArray(value)) {
      return '';
    }
    return value
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (!part || typeof part !== 'object') {
          return '';
        }
        const item = part as Record<string, unknown>;
        return this.extractTextContent(item.text ?? item.content);
      })
      .join('');
  }

  /**
   * Extract content and reasoning_content separately from a streaming chunk,
   * covering all nesting levels used by OpenAI and compatible endpoints
   * (delta.content, delta.message.content, choices[0].message.content, etc.).
   */
  private extractDeltaFields(chunk: unknown): { content: string; reasoning: string } {
    if (!chunk || typeof chunk !== 'object') {
      return { content: '', reasoning: '' };
    }
    const choice = (chunk as Record<string, unknown>).choices;
    if (!Array.isArray(choice) || choice.length === 0) {
      return { content: '', reasoning: '' };
    }
    const first = choice[0] as Record<string, unknown>;
    const delta = first?.delta as Record<string, unknown> | undefined;
    const nestedMessage = delta?.message as Record<string, unknown> | undefined;
    const msg = first?.message as Record<string, unknown> | undefined;

    const content =
      this.extractTextContent(delta?.content) ||
      this.extractTextContent(nestedMessage?.content) ||
      this.extractTextContent(msg?.content);

    const reasoning =
      this.extractTextContent(delta?.reasoning_content ?? delta?.reasoningContent) ||
      this.extractTextContent(nestedMessage?.reasoning_content ?? nestedMessage?.reasoningContent) ||
      this.extractTextContent(msg?.reasoning_content ?? msg?.reasoningContent);

    return { content, reasoning };
  }

  private extractDeltaContent(chunk: unknown): string {
    if (!chunk || typeof chunk !== 'object') {
      return '';
    }
    const choice = (chunk as Record<string, unknown>).choices;
    if (!Array.isArray(choice) || choice.length === 0) {
      return '';
    }
    const first = choice[0] as Record<string, unknown>;
    // Standard OpenAI streaming format: choices[0].delta.content
    const delta = first?.delta as Record<string, unknown> | undefined;
    const deltaContent = this.extractTextContent(delta?.content);
    if (deltaContent.trim()) {
      return deltaContent;
    }
    // Volcengine GLM-5.2 returns generated text in reasoning_content when streaming
    const deltaReasoning = this.extractTextContent(
      delta?.reasoning_content ?? delta?.reasoningContent
    );
    if (deltaReasoning.trim()) {
      return deltaReasoning;
    }
    // Some compatibility endpoints wrap content in choices[0].delta.message.content
    const message = delta?.message as Record<string, unknown> | undefined;
    const nestedContent = this.extractTextContent(message?.content);
    if (nestedContent.trim()) {
      return nestedContent;
    }
    const nestedReasoning = this.extractTextContent(
      message?.reasoning_content ?? message?.reasoningContent
    );
    if (nestedReasoning.trim()) {
      return nestedReasoning;
    }
    // Fallback for non-streaming-like chunks
    const msg = first?.message as Record<string, unknown> | undefined;
    const messageContent = this.extractTextContent(msg?.content);
    if (messageContent.trim()) {
      return messageContent;
    }
    const messageReasoning = this.extractTextContent(
      msg?.reasoning_content ?? msg?.reasoningContent
    );
    if (messageReasoning.trim()) {
      return messageReasoning;
    }
    return '';
  }

  private emitEvent(event: AgentLoopEvent): void {
    this.events.push(event);
    this.emit('event', event);

    if (this.traceEventStore) {
      try {
        this.traceEventStore.create({
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
