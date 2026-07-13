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
  signal?: AbortSignal;
}

export type AgentLoopEvent =
  | { type: 'plan'; plan: Plan }
  | { type: 'thought'; content: string }
  | { type: 'reflection'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
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
  private signal?: AbortSignal;
  private readonly taskId?: string;
  private currentRunId?: string;
  private currentMemoryText?: string;
  private reasoningChain: ReasoningChain;
  private events: AgentLoopEvent[] = [];

  constructor(options: AgentLoopOptions = {}) {
    super();
    this.systemPrompt = options.systemPrompt ?? config.systemPrompt;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxToolIterations = options.maxToolIterations ?? 5;
    this.maxReplanAttempts = options.maxReplanAttempts ?? 3;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 2;
    this.enablePlanning = options.enablePlanning ?? false;
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
      });
    } else {
      this.contextManager = new ContextManager({
        systemPrompt: this.systemPrompt,
      });
    }

    this.planner = options.planner ?? new Planner();
    this.taskJudge = options.taskJudge ?? new TaskJudge();
    this.reasoningChain = new ReasoningChain();

    this.memoryStore = options.memoryStore;
    this.memoryExtractor = options.memoryExtractor;

    if (options.threadId) {
      const db = options.db ?? getSharedConnection();
      this.runStore = options.runStore ?? new RunStore(db);
      this.toolCallStore = options.toolCallStore ?? new ToolCallStore(db);
      this.threadStore = options.threadStore ?? new ThreadStore(db);
      this.traceEventStore = options.traceEventStore ?? new TraceEventStore(db);
    }
  }

  async chat(message: string, signal?: AbortSignal): Promise<{ reply: string; events: AgentLoopEvent[]; runId?: string }> {
    this.signal = signal ?? this.signal;
    this.checkSignal();
    this.contextManager.addMessage({ role: 'user', content: message });
    this.events = [];
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
      if (!this.enablePlanning || !this.toolRegistry) {
        const result = await this.runSimpleLoop(runId);
        this.completeRun(runId);
        await this.extractAndStoreMemories(message, result.reply);
        return { ...result, runId };
      }

      const result = await this.runPlanningLoop(message, runId, this.currentMemoryText);
      this.completeRun(runId);
      await this.extractAndStoreMemories(message, result.reply);
      return { ...result, runId };
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
      const response = await this.callModel();
      const assistantMessage = response.choices[0]?.message;

      if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCalls = assistantMessage.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: this.safeParseArgs(tc.function.arguments),
        }));

        this.contextManager.addMessage({
          role: 'assistant',
          content: assistantMessage.content ?? '',
          tool_calls: assistantMessage.tool_calls,
          internal: true,
        });

        for (const call of toolCalls) {
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

      const content = await this.streamFinalAnswer(assistantMessage?.content ?? '');
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

    const thought = assistantMessage?.content?.trim() ?? '';
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
        if (!this.toolExecutor) {
          const result: ToolResult = { success: false, error: 'No tool executor available' };
          this.reasoningChain.addObservation(result);
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

        this.checkSignal();
        const result = await this.toolExecutor.execute(call);
        this.reasoningChain.addObservation(result);
        this.emitEvent({ type: 'tool_result', toolResult: result });
        this.contextManager.addMessage({
          role: 'tool',
          content: JSON.stringify(result),
          tool_call_id: call.id,
        });
        this.persistToolCall(runId, call, result);

        if (!result.success) {
          step.status = 'failed';
          const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
          if (judge.complete || judge.nextAction === 'finalize') {
            return { next: 'final' };
          }
          if (judge.nextAction === 'retry') {
            return { next: 'retry', failureAnalysis: judge.failureAnalysis };
          }
          if (judge.nextAction === 'replan') {
            return { next: 'replan', failureAnalysis: judge.failureAnalysis };
          }
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
        return await config.openai.chat.completions.create(
          {
            model: config.model,
            messages: messages as never,
            tools,
          },
          { timeout: this.timeoutMs, signal: this.signal }
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
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
            tools,
          },
          { timeout: this.timeoutMs, signal: this.signal }
        );

        let content = '';
        if (Symbol.asyncIterator in response) {
          for await (const chunk of response) {
            this.checkSignal();
            const delta = this.extractDeltaContent(chunk);
            if (delta) {
              content += delta;
              this.emitEvent({ type: 'message_delta', content: delta });
            }
          }
        } else {
          const nonStreamingResponse = response as unknown as {
            choices: Array<{ message?: { content?: string } }>;
          };
          const fallback = nonStreamingResponse.choices[0]?.message?.content ?? '';
          content = fallback;
          if (content) {
            this.emitEvent({ type: 'message_delta', content });
          }
        }
        return content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `Model call failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  private streamFinalAnswer(content: string): string {
    // If the content is already provided (non-streaming mode), emit it as a delta and return.
    if (content) {
      this.emitEvent({ type: 'message_delta', content });
      return content;
    }
    return content;
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
    if (delta?.content && typeof delta.content === 'string') {
      return delta.content;
    }
    // Some compatibility endpoints wrap content in choices[0].delta.message.content
    const message = delta?.message as Record<string, unknown> | undefined;
    if (message?.content && typeof message.content === 'string') {
      return message.content;
    }
    // Fallback for non-streaming-like chunks
    const msg = first?.message as Record<string, unknown> | undefined;
    if (msg?.content && typeof msg.content === 'string') {
      return msg.content;
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

  private safeParseArgs(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
