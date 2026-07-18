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
      this.recordResult(call, result, {
        ...options,
        status: 'rejected',
        durationMs: Date.now() - startedAt,
        persist: true,
      });
      return result;
    }
    options.onPhase?.('prepared', call);

    let result: ToolResult;
    if (!this.options.executor) {
      result = { success: false, error: 'No tool executor available' };
    } else {
      this.options.checkSignal();
      options.onPhase?.('running', call);
      result = await this.options.executor.execute(call);
    }

    this.recordResult(call, result, {
      ...options,
      status: result.success ? 'succeeded' : 'failed',
      durationMs: Date.now() - startedAt,
      persist: true,
    });
    return result;
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
