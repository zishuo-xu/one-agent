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
import { JudgeResult, Plan, PlanStep } from '../planning/types.js';
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
  private readonly signal?: AbortSignal;
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
    this.enablePlanning = options.enablePlanning ?? true;
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

  async chat(message: string): Promise<{ reply: string; events: AgentLoopEvent[]; runId?: string }> {
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

    let currentStepIndex = 0;
    let replanAttempts = 0;
    let retryAttempts = 0;

    while (true) {
      this.checkSignal();
      const step = plan.steps[currentStepIndex];

      if (!step) {
        const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());
        if (judge.complete || judge.nextAction === 'finalize') {
          return this.finalizeAnswer();
        }
        if (judge.nextAction === 'replan' && replanAttempts < this.maxReplanAttempts) {
          plan = await this.replan(userMessage, plan);
          replanAttempts++;
          currentStepIndex = 0;
          retryAttempts = 0;
          continue;
        }
        return this.finalizeAnswer();
      }

      step.status = 'running';

      const executionResult = await this.executeStep(step, plan, runId);

      if (executionResult.next === 'final') {
        return this.finalizeAnswer();
      }

      if (executionResult.next === 'retry' && retryAttempts < this.maxRetryAttempts) {
        step.status = 'pending';
        retryAttempts++;
        continue;
      }

      if (executionResult.next === 'replan' && replanAttempts < this.maxReplanAttempts) {
        plan = await this.replan(userMessage, plan);
        replanAttempts++;
        currentStepIndex = 0;
        retryAttempts = 0;
        continue;
      }

      step.status = 'completed';
      retryAttempts = 0;
      currentStepIndex++;
    }
  }

  private async executeStep(
    step: PlanStep,
    plan: Plan,
    runId?: string
  ): Promise<{ next: 'continue' | 'retry' | 'replan' | 'final' }> {
    this.contextManager.addMessage({
      role: 'user',
      content: this.buildStepPrompt(step, plan),
    });

    this.checkSignal();
    const response = await this.callModel();
    const assistantMessage = response.choices[0]?.message;

    const thought = assistantMessage?.content?.trim() ?? '';
    if (thought) {
      this.reasoningChain.addThought(thought);
      this.emitEvent({ type: 'thought', content: thought });
      this.contextManager.addMessage({ role: 'assistant', content: thought });
    }

    if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
      const toolCalls = assistantMessage.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: this.safeParseArgs(tc.function.arguments),
      }));

      this.contextManager.addMessage({
        role: 'assistant',
        content: thought,
        tool_calls: assistantMessage.tool_calls,
      });

      for (const call of toolCalls) {
        this.reasoningChain.addAction(call);
        this.emitEvent({ type: 'tool_call', toolCall: call });

        if (!this.toolExecutor) {
          const result: ToolResult = { success: false, error: 'No tool executor available' };
          this.reasoningChain.addObservation(result);
          this.emitEvent({ type: 'tool_result', toolResult: result });
          this.contextManager.addMessage({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: call.id,
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
            return { next: 'retry' };
          }
          if (judge.nextAction === 'replan') {
            return { next: 'replan' };
          }
        }
      }
    }

    this.reasoningChain.commitStep();
    const judge = await this.taskJudge.judge(plan, this.reasoningChain.getSteps());

    if (judge.complete || judge.nextAction === 'finalize') {
      return { next: 'final' };
    }
    if (judge.nextAction === 'replan') {
      return { next: 'replan' };
    }
    return { next: 'continue' };
  }

  private async finalizeAnswer(): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    this.contextManager.addMessage({
      role: 'user',
      content: 'Based on the above execution, provide a final answer to the user.',
    });

    this.checkSignal();
    const content = await this.streamModel(false);

    this.contextManager.addMessage({ role: 'assistant', content });
    this.emitEvent({ type: 'message', content });

    return { reply: content, events: this.events };
  }

  private async replan(userMessage: string, currentPlan: Plan): Promise<Plan> {
    const reflection = `The previous plan did not succeed. Plan: ${currentPlan.steps
      .map((s) => s.description)
      .join('; ')}`;
    this.reasoningChain.addReflection(reflection);
    this.emitEvent({ type: 'reflection', content: reflection });

    const newPlan = await this.planner.createPlan(userMessage, this.toolRegistry!.list());
    this.emitEvent({ type: 'plan', plan: newPlan });
    return newPlan;
  }

  private buildStepPrompt(step: PlanStep, plan: Plan): string {
    const steps = plan.steps
      .map((s) => `${s.id}. ${s.description} ${s.status === 'completed' ? '✓' : ''}`)
      .join('\n');

    return [
      'Execute the following step from the plan.',
      '',
      'Plan:',
      steps,
      '',
      `Current step: ${step.description}`,
      step.expectedOutcome ? `Expected outcome: ${step.expectedOutcome}` : '',
      '',
      'Think step by step. If you need a tool, call it. If the step can be completed without a tool, just explain.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async callModel(includeTools = true) {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkSignal();
      try {
        const messages = await this.contextManager.buildContext();
        return await config.openai.chat.completions.create(
          {
            model: config.model,
            messages: messages as never,
            tools: includeTools ? this.toolRegistry?.getSchemas() : undefined,
          },
          { timeout: this.timeoutMs }
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `Model call failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  private async streamModel(includeTools = false): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkSignal();
      try {
        const messages = await this.contextManager.buildContext();
        const response = await config.openai.chat.completions.create(
          {
            model: config.model,
            messages: messages as never,
            stream: true,
            tools: includeTools ? this.toolRegistry?.getSchemas() : undefined,
          },
          { timeout: this.timeoutMs }
        );

        let content = '';
        if (Symbol.asyncIterator in response) {
          for await (const chunk of response) {
            this.checkSignal();
            const delta = (chunk.choices[0]?.delta?.content ?? '') as string;
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
