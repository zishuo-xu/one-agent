import crypto from 'node:crypto';
import type { UserInputRequest } from '../agents/requestUserInputTool.js';
import type { ToolCall } from './types.js';

export type ToolPolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'require_confirmation'; reason: string; fingerprint: string };

export interface ToolPolicyContext {
  approvedFingerprint?: string;
}

export interface ToolPolicy {
  evaluate(call: ToolCall, context?: ToolPolicyContext): ToolPolicyDecision;
}

export interface DefaultToolPolicyOptions {
  confirmTools?: Iterable<string>;
  denyTools?: Iterable<string>;
}

const DEFAULT_CONFIRM_TOOLS = ['delete_file', 'run_command'];

/**
 * Runtime-owned tool policy. Loops and entrypoints never classify tool risk.
 * The default stays deliberately small: destructive deletion and arbitrary
 * command execution require confirmation; unavailable tools remain the
 * ToolRegistry's responsibility.
 */
export class DefaultToolPolicy implements ToolPolicy {
  private readonly confirmTools: Set<string>;
  private readonly denyTools: Set<string>;

  constructor(options: DefaultToolPolicyOptions = {}) {
    this.confirmTools = new Set(options.confirmTools ?? DEFAULT_CONFIRM_TOOLS);
    this.denyTools = new Set(options.denyTools ?? []);
  }

  evaluate(call: ToolCall, context: ToolPolicyContext = {}): ToolPolicyDecision {
    if (this.denyTools.has(call.name)) {
      return { action: 'deny', reason: `Tool ${call.name} is denied by runtime policy.` };
    }
    if (!this.confirmTools.has(call.name)) return { action: 'allow' };

    const fingerprint = fingerprintToolCall(call);
    if (context.approvedFingerprint === fingerprint) return { action: 'allow' };
    return {
      action: 'require_confirmation',
      reason: `Tool ${call.name} can change external state and requires confirmation.`,
      fingerprint,
    };
  }
}

export class ToolApprovalRequiredError extends Error {
  readonly request: UserInputRequest;

  constructor(
    readonly call: ToolCall,
    readonly fingerprint: string,
    reason: string,
    metadata: { stepId?: string; attempt?: number } = {},
  ) {
    super(reason);
    this.name = 'ToolApprovalRequiredError';
    this.request = {
      id: crypto.randomUUID(),
      kind: 'tool_approval',
      question: `Allow ${call.name} with these frozen arguments? ${formatArgumentsForDisplay(call.arguments)}`,
      options: ['approve', 'reject'],
      createdAt: new Date().toISOString(),
      approval: {
        toolCall: JSON.parse(JSON.stringify(call)) as ToolCall,
        fingerprint,
        stepId: metadata.stepId,
        attempt: metadata.attempt,
      },
    };
  }
}

const SENSITIVE_ARGUMENT_KEY = /(?:password|passwd|secret|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)/i;

function formatArgumentsForDisplay(argumentsValue: Record<string, unknown>): string {
  const safe = Object.fromEntries(Object.entries(argumentsValue).map(([key, value]) => [
    key,
    SENSITIVE_ARGUMENT_KEY.test(key) ? '[REDACTED]' : truncateDisplayValue(value),
  ]));
  return JSON.stringify(safe);
}

function truncateDisplayValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 500) {
    return `${value.slice(0, 500)}… [${value.length - 500} chars omitted]`;
  }
  return value;
}

export function fingerprintToolCall(call: ToolCall): string {
  return crypto
    .createHash('sha256')
    .update(stableStringify({ name: call.name, arguments: call.arguments }))
    .digest('hex');
}

export function parseToolApprovalAnswer(answer: string): 'approve' | 'reject' | undefined {
  const normalized = answer.trim().toLowerCase();
  if (['approve', 'approved', 'yes', 'y', '同意', '确认', '继续'].includes(normalized)) {
    return 'approve';
  }
  if (['reject', 'rejected', 'no', 'n', '拒绝', '取消'].includes(normalized)) {
    return 'reject';
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}
