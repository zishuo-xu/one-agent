import type { ContextManager } from '../context/ContextManager.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolCall, ToolResult } from '../tools/types.js';
import type { RunRecorder } from './RunRecorder.js';
import {
  ToolApprovalRequiredError,
  type ToolPolicy,
} from '../tools/policy.js';

export interface ToolRunMetadata {
  runId?: string;
  stepId?: string;
  attempt?: number;
}

export interface ToolExecutionOptions extends ToolRunMetadata {
  onPhase?: (phase: 'prepared' | 'running', call: ToolCall) => void;
  onResult?: (result: ToolResult) => void;
  approvedFingerprint?: string;
  contextMode?: 'tool' | 'observation';
}

export interface ToolResultOptions extends ToolRunMetadata {
  status: 'succeeded' | 'failed' | 'rejected' | 'skipped' | 'awaiting_approval';
  durationMs?: number;
  persist?: boolean;
  onResult?: (result: ToolResult) => void;
  contextMode?: 'tool' | 'observation';
}

export interface ToolRunnerOptions {
  executor?: ToolExecutor;
  contextManager: ContextManager;
  recorder: RunRecorder;
  checkSignal: () => void;
  persist?: (runId: string | undefined, call: ToolCall, result: ToolResult) => void;
  policy?: ToolPolicy;
}

interface PreparedExecution {
  call: ToolCall;
  options: ToolExecutionOptions;
  startedAt: number;
  immediate?: ExecutionOutcome;
}

interface ExecutionOutcome {
  result: ToolResult;
  status: 'succeeded' | 'failed' | 'rejected';
  durationMs: number;
}

/**
 * The one protocol for turning a model ToolCall into durable execution facts.
 * Loops decide when and why a tool should run; ToolRunner owns the invariant
 * protocol: recordCalls announces model-selected calls; execute and
 * recordResult then execute or reject them, pair results in model context,
 * trace the outcome and persist final evidence.
 */
export class ToolRunner {
  constructor(private readonly options: ToolRunnerOptions) {}

  recordCalls(calls: ToolCall[], metadata: ToolRunMetadata = {}): void {
    for (const call of calls) {
      this.options.recorder.record({
        type: 'tool_call',
        toolCall: call,
        stepId: metadata.stepId,
        attempt: metadata.attempt,
      });
    }
  }

  /** Check a batch before any side effect starts, so mixed calls stay atomic. */
  preflight(calls: ToolCall[], metadata: ToolRunMetadata = {}): void {
    if (!this.options.policy) return;
    for (const call of calls) {
      const decision = this.options.policy.evaluate(call);
      if (decision.action === 'require_confirmation') {
        this.options.recorder.record({
          type: 'tool_policy',
          toolCallId: call.id,
          toolName: call.name,
          decision: decision.action,
          reason: decision.reason,
          stepId: metadata.stepId,
          attempt: metadata.attempt,
        });
        throw new ToolApprovalRequiredError(
          call,
          decision.fingerprint,
          decision.reason,
          metadata,
        );
      }
    }
  }

  async execute(call: ToolCall, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    const prepared = this.prepare(call, options);
    const outcome = await this.perform(prepared, true);
    this.commit(prepared, outcome);
    return outcome.result;
  }

  /**
   * Execute one model-selected batch. Parallelism is deliberately conservative:
   * every tool must explicitly declare itself read-only. Mixed, mutating and
   * unknown batches preserve the original sequential semantics.
   */
  async executeBatch(
    calls: ToolCall[],
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult[]> {
    if (calls.length === 0) return [];

    // Approval is checked for the entire batch before any tool starts.
    this.preflight(calls, options);

    const canRunConcurrently = calls.length > 1
      && Boolean(this.options.executor)
      && calls.every((call) => this.options.executor?.isReadOnly(call.name) === true);
    if (!canRunConcurrently) {
      const results: ToolResult[] = [];
      for (const call of calls) {
        results.push(await this.execute(call, options));
      }
      return results;
    }

    const prepared = calls.map((call) => this.prepare(call, options));
    if (prepared.some((execution) => !execution.immediate)) {
      this.options.checkSignal();
    }
    const outcomes = await Promise.all(
      prepared.map((execution) => this.perform(execution, false)),
    );

    // Execution may finish out of order, but durable facts and model context
    // always follow the model's original tool-call order.
    for (let index = 0; index < prepared.length; index++) {
      this.commit(prepared[index], outcomes[index]);
    }
    return outcomes.map((outcome) => outcome.result);
  }

  private prepare(call: ToolCall, options: ToolExecutionOptions): PreparedExecution {
    const startedAt = Date.now();
    const policyDecision = this.options.policy?.evaluate(call, {
      approvedFingerprint: options.approvedFingerprint,
    });
    if (policyDecision) {
      this.options.recorder.record({
        type: 'tool_policy',
        toolCallId: call.id,
        toolName: call.name,
        decision: policyDecision.action,
        reason: policyDecision.action === 'allow' ? undefined : policyDecision.reason,
        approved: policyDecision.action === 'allow' && Boolean(options.approvedFingerprint),
        stepId: options.stepId,
        attempt: options.attempt,
      });
    }
    if (policyDecision?.action === 'require_confirmation') {
      throw new ToolApprovalRequiredError(
        call,
        policyDecision.fingerprint,
        policyDecision.reason,
        options,
      );
    }
    if (policyDecision?.action === 'deny') {
      const result: ToolResult = { success: false, error: policyDecision.reason };
      return {
        call,
        options,
        startedAt,
        immediate: { result, status: 'rejected', durationMs: Date.now() - startedAt },
      };
    }
    options.onPhase?.('prepared', call);
    return { call, options, startedAt };
  }

  private async perform(
    execution: PreparedExecution,
    checkSignal: boolean,
  ): Promise<ExecutionOutcome> {
    if (execution.immediate) return execution.immediate;

    const { call, options } = execution;
    let result: ToolResult;
    if (!this.options.executor) {
      result = { success: false, error: 'No tool executor available' };
    } else {
      if (checkSignal) this.options.checkSignal();
      options.onPhase?.('running', call);
      result = await this.options.executor.execute(call);
    }

    return {
      result,
      status: result.success ? 'succeeded' : 'failed',
      durationMs: Date.now() - execution.startedAt,
    };
  }

  private commit(execution: PreparedExecution, outcome: ExecutionOutcome): void {
    this.recordResult(execution.call, outcome.result, {
      ...execution.options,
      status: outcome.status,
      durationMs: outcome.durationMs,
      persist: true,
    });
  }

  recordResult(call: ToolCall, result: ToolResult, options: ToolResultOptions): void {
    options.onResult?.(result);
    this.options.recorder.record({
      type: 'tool_result',
      toolResult: result,
      toolCallId: call.id,
      stepId: options.stepId,
      attempt: options.attempt,
      status: options.status,
      durationMs: options.durationMs ?? 0,
    });
    if (options.contextMode === 'observation') {
      this.options.contextManager.addMessage({
        role: 'user',
        content: `[Approved runtime execution result for ${call.name}]\n${JSON.stringify(result)}`,
        internal: true,
      });
    } else {
      this.options.contextManager.addMessage({
        role: 'tool',
        content: JSON.stringify(result),
        tool_call_id: call.id,
        internal: true,
      });
    }
    if (options.persist) {
      this.options.persist?.(options.runId, call, result);
    }
  }
}
