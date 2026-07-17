import { ToolCall, ToolResult } from '../../tools/types.js';
import type { ModelToolCall } from '../../model/types.js';
import type { AgentLoopEvent } from '../AgentLoop.js';
import { Plan, PlanStep, FailureAnalysis } from '../../planning/types.js';
import { ReasoningChain } from '../../planning/ReasoningChain.js';
import type { SubAgentTask, SubAgentResult } from '../SubAgentRunner.js';
import type { LoopInfrastructure, LoopRunInput, LoopStrategy } from './types.js';
import { safeParseArgs } from './utils.js';

/** Tools available to parallel sub-agents: read-only, so waves cannot conflict. */
const READ_ONLY_DELEGATION_TOOLS = ['read_file', 'list_files', 'search_files', 'web_search', 'get_time'];

type ExecutionUnit = { type: 'single'; step: PlanStep } | { type: 'wave'; steps: PlanStep[] };

/**
 * The planning loop: plan -> execute steps/waves -> judge -> retry/replan ->
 * finalize. Delegate+parallel steps run concurrently in isolated sub-agents
 * (read-only by construction, so waves cannot produce write conflicts).
 */
export class PlanningLoop implements LoopStrategy {
  private readonly contextManager: LoopInfrastructure['contextManager'];
  private readonly modelCaller: LoopInfrastructure['modelCaller'];
  private readonly recorder: LoopInfrastructure['recorder'];
  private readonly toolRegistry: LoopInfrastructure['toolRegistry'];
  private readonly toolExecutor: LoopInfrastructure['toolExecutor'];
  private readonly planner: LoopInfrastructure['planner'];
  private readonly taskJudge: LoopInfrastructure['taskJudge'];
  private readonly subAgentRunner: LoopInfrastructure['subAgentRunner'];
  private readonly maxReplanAttempts: number;
  private readonly maxRetryAttempts: number;
  private readonly checkSignal: () => void;
  private readonly persistToolCall: LoopInfrastructure['persistToolCall'];
  private reasoningChain!: ReasoningChain;
  private memories?: string;

  constructor(infra: LoopInfrastructure) {
    this.contextManager = infra.contextManager;
    this.modelCaller = infra.modelCaller;
    this.recorder = infra.recorder;
    this.toolRegistry = infra.toolRegistry;
    this.toolExecutor = infra.toolExecutor;
    this.planner = infra.planner;
    this.taskJudge = infra.taskJudge;
    this.subAgentRunner = infra.subAgentRunner;
    this.maxReplanAttempts = infra.maxReplanAttempts;
    this.maxRetryAttempts = infra.maxRetryAttempts;
    this.checkSignal = infra.checkSignal;
    this.persistToolCall = infra.persistToolCall;
  }

  async run(input: LoopRunInput): Promise<{ reply: string }> {
    const { message: userMessage, runId, memories } = input;
    this.reasoningChain = input.reasoningChain;
    this.memories = memories;
    let plan = await this.planner.createPlan(userMessage, this.toolRegistry!.list(), memories);
    this.recorder.record({ type: 'plan', plan });

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
            this.reasoningChain.addFailureAnalysis(failureAnalysis, step.id);
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
    this.reasoningChain.addFailureAnalysis(failureAnalysis, step.id);
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

    const allowedTools = step.parallel ? READ_ONLY_DELEGATION_TOOLS : undefined;

    const planSummary = plan.steps.map((s) => `${s.id}. ${s.description}`).join('; ');
    const result = await this.runSubAgent({
      task: step.description,
      context: `Executing one step of a larger plan: ${planSummary}`,
      expectedOutcome: step.expectedOutcome,
      allowedTools,
      stepId: step.id,
      memoryText: this.memories,
    });

    this.reasoningChain.addThought(
      result.success
        ? `Delegated step completed: ${result.reply.slice(0, 200)}`
        : `Delegated step failed: ${result.error ?? 'unknown'}`,
      step.id,
    );
    this.reasoningChain.commitStep(step.id);

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
    const response = await this.modelCaller.complete({ allowedTools: allowedToolNames });

    // Prefer real content; fall back to reasoning_content for endpoints that
    // return generated text there (provider surfaces both separately).
    const thought = (response.content.trim() ? response.content : (response.reasoning ?? '')).trim();
    if (thought) {
      this.reasoningChain.addThought(thought, step.id);
      this.recorder.record({ type: 'thought', content: thought });
      this.contextManager.addMessage({ role: 'assistant', content: thought, internal: true });
    }

    const responseToolCalls = response.toolCalls ?? [];
    if (responseToolCalls.length > 0) {
      const toolCalls = responseToolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: safeParseArgs(tc.arguments),
      }));

      // Record the model's tool calls before validating them so the trace is complete.
      this.contextManager.addMessage({
        role: 'assistant',
        content: thought,
        tool_calls: this.toWireToolCalls(responseToolCalls),
        internal: true,
      });

      for (const call of toolCalls) {
        this.reasoningChain.addAction(call, step.id);
        this.recorder.record({ type: 'tool_call', toolCall: call });
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
        this.reasoningChain.addFailureAnalysis(failureAnalysis, step.id);
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
        this.reasoningChain.addObservation(result, step.id);
        this.recorder.record({ type: 'tool_result', toolResult: result });
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
          this.reasoningChain.addFailureAnalysis(failureAnalysis, step.id);
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

    this.reasoningChain.commitStep(step.id);

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

  private async finalizeAnswer(): Promise<{ reply: string }> {
    this.contextManager.addMessage({
      role: 'user',
      content: 'Based on the above execution, provide a final answer to the user.',
      internal: true,
    });

    this.checkSignal();
    const { content } = await this.modelCaller.completeStreaming({ includeTools: false });

    this.contextManager.addMessage({ role: 'assistant', content });
    this.recorder.record({ type: 'message', content });

    return { reply: content };
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
    this.recorder.record({ type: 'reflection', content: reflection });

    const newPlan = await this.planner.createPlan(
      userMessage,
      this.toolRegistry!.list(),
      this.memories,
      currentPlan,
      failureAnalysis
    );
    this.recorder.record({ type: 'plan', plan: newPlan });
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
  async runSubAgent(task: SubAgentTask): Promise<SubAgentResult> {
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

    this.recorder.record({ type: 'sub_agent', task: task.task, status: 'started', stepId: task.stepId });
    const result = await this.subAgentRunner.run(task);
    if (result.tokenUsage) {
      // Roll the cost into the run totals, but never let the sub-agent's
      // (much smaller) prompt anchor this loop's context-size estimate —
      // that would understate the parent's size and skip summarization.
      this.recorder.accumulateUsage(result.tokenUsage, { trackPromptSize: false });
    }
    this.recorder.record({
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

}
