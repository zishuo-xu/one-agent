import { config } from '../config.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolCall, ToolResult } from '../tools/types.js';
import { Message } from './types.js';
import { ContextManager } from '../context/ContextManager.js';
import { Planner } from '../planning/Planner.js';
import { ReasoningChain } from '../planning/ReasoningChain.js';
import { TaskJudge } from '../planning/TaskJudge.js';
import { JudgeResult, Plan, PlanStep } from '../planning/types.js';

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
}

export type AgentLoopEvent =
  | { type: 'plan'; plan: Plan }
  | { type: 'thought'; content: string }
  | { type: 'reflection'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'message'; content: string };

export class AgentLoop {
  private readonly systemPrompt: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxToolIterations: number;
  private readonly maxReplanAttempts: number;
  private readonly maxRetryAttempts: number;
  private readonly enablePlanning: boolean;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly contextManager: ContextManager;
  private readonly planner: Planner;
  private readonly taskJudge: TaskJudge;
  private reasoningChain: ReasoningChain;
  private events: AgentLoopEvent[] = [];

  constructor(options: AgentLoopOptions = {}) {
    this.systemPrompt = options.systemPrompt ?? config.systemPrompt;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxToolIterations = options.maxToolIterations ?? 5;
    this.maxReplanAttempts = options.maxReplanAttempts ?? 3;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 2;
    this.enablePlanning = options.enablePlanning ?? true;
    this.toolRegistry = options.tools;
    this.toolExecutor = this.toolRegistry ? new ToolExecutor(this.toolRegistry) : undefined;
    this.contextManager =
      options.contextManager ??
      new ContextManager({
        systemPrompt: this.systemPrompt,
      });
    this.planner = options.planner ?? new Planner();
    this.taskJudge = options.taskJudge ?? new TaskJudge();
    this.reasoningChain = new ReasoningChain();
  }

  async chat(message: string): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    this.contextManager.addMessage({ role: 'user', content: message });
    this.events = [];
    this.reasoningChain = new ReasoningChain();
    this.taskJudge.reset();

    if (!this.enablePlanning || !this.toolRegistry) {
      return this.runSimpleLoop();
    }

    return this.runPlanningLoop(message);
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

  private async runSimpleLoop(): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    let toolIterations = 0;

    while (toolIterations <= this.maxToolIterations) {
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
          this.events.push({ type: 'tool_call', toolCall: call });

          if (!this.toolExecutor) {
            const result: ToolResult = {
              success: false,
              error: 'No tool executor available',
            };
            this.events.push({ type: 'tool_result', toolResult: result });
            this.contextManager.addMessage({
              role: 'tool',
              content: JSON.stringify(result),
              tool_call_id: call.id,
            });
            continue;
          }

          const result = await this.toolExecutor.execute(call);
          this.events.push({ type: 'tool_result', toolResult: result });
          this.contextManager.addMessage({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: call.id,
          });
        }

        toolIterations++;
        continue;
      }

      const content = assistantMessage?.content ?? '';
      this.contextManager.addMessage({ role: 'assistant', content });
      this.events.push({ type: 'message', content });
      return { reply: content, events: this.events };
    }

    throw new Error(
      `AgentLoop stopped after ${this.maxToolIterations + 1} tool iteration(s) without a final answer`
    );
  }

  private async runPlanningLoop(userMessage: string): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    let plan = await this.planner.createPlan(userMessage, this.toolRegistry!.list());
    this.events.push({ type: 'plan', plan });

    let currentStepIndex = 0;
    let replanAttempts = 0;
    let retryAttempts = 0;

    while (true) {
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

      const executionResult = await this.executeStep(step, plan);

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
    plan: Plan
  ): Promise<{ next: 'continue' | 'retry' | 'replan' | 'final' }> {
    this.contextManager.addMessage({
      role: 'user',
      content: this.buildStepPrompt(step, plan),
    });

    const response = await this.callModel();
    const assistantMessage = response.choices[0]?.message;

    const thought = assistantMessage?.content?.trim() ?? '';
    if (thought) {
      this.reasoningChain.addThought(thought);
      this.events.push({ type: 'thought', content: thought });
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
        this.events.push({ type: 'tool_call', toolCall: call });

        if (!this.toolExecutor) {
          const result: ToolResult = { success: false, error: 'No tool executor available' };
          this.reasoningChain.addObservation(result);
          this.events.push({ type: 'tool_result', toolResult: result });
          this.contextManager.addMessage({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: call.id,
          });
          continue;
        }

        const result = await this.toolExecutor.execute(call);
        this.reasoningChain.addObservation(result);
        this.events.push({ type: 'tool_result', toolResult: result });
        this.contextManager.addMessage({
          role: 'tool',
          content: JSON.stringify(result),
          tool_call_id: call.id,
        });

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

    const response = await this.callModel(false);
    const content = response.choices[0]?.message?.content ?? '';

    this.contextManager.addMessage({ role: 'assistant', content });
    this.events.push({ type: 'message', content });

    return { reply: content, events: this.events };
  }

  private async replan(userMessage: string, currentPlan: Plan): Promise<Plan> {
    const reflection = `The previous plan did not succeed. Plan: ${currentPlan.steps
      .map((s) => s.description)
      .join('; ')}`;
    this.reasoningChain.addReflection(reflection);
    this.events.push({ type: 'reflection', content: reflection });

    const newPlan = await this.planner.createPlan(userMessage, this.toolRegistry!.list());
    this.events.push({ type: 'plan', plan: newPlan });
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

  private safeParseArgs(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
