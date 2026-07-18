import type { Plan } from '../planning/types.js';
import type { ToolCall } from '../tools/types.js';
import type { UserInputRequest } from './requestUserInputTool.js';

export type ToolRecoveryPolicy = 'safe_retry' | 'verify_before_retry' | 'manual';

export interface ActiveToolCheckpoint {
  id: string;
  name: string;
  stepId: string;
  arguments: ToolCall['arguments'];
  status: 'prepared' | 'running';
  recoveryPolicy: ToolRecoveryPolicy;
}

/** Mutable latest-state snapshot. Trace events remain the immutable history. */
export interface PlanningRunCheckpoint {
  version: 1;
  updatedAt: string;
  originalMessage: string;
  loopMode: 'planning';
  plan: Plan;
  currentUnitIndex: number;
  replanAttempts: number;
  retryAttempts: number;
  recoveryCount: number;
  resumedFromRunId?: string;
  activeToolCall?: ActiveToolCheckpoint;
  pendingInput?: UserInputRequest;
}

export interface SimpleRunCheckpoint {
  version: 1;
  updatedAt: string;
  originalMessage: string;
  loopMode: 'simple';
  recoveryCount: number;
  resumedFromRunId?: string;
  pendingInput: UserInputRequest;
}

export type RunCheckpoint = PlanningRunCheckpoint | SimpleRunCheckpoint;

const SAFE_RETRY_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_files',
  'web_search',
  'get_time',
]);

const VERIFY_BEFORE_RETRY_TOOLS = new Set(['write_file', 'delete_file']);

export function recoveryPolicyForTool(name: string): ToolRecoveryPolicy {
  if (SAFE_RETRY_TOOLS.has(name)) return 'safe_retry';
  if (VERIFY_BEFORE_RETRY_TOOLS.has(name)) return 'verify_before_retry';
  return 'manual';
}

export function assessCheckpointRecovery(checkpoint: RunCheckpoint): {
  resumable: boolean;
  reason?: string;
} {
  if (checkpoint.loopMode === 'simple') return { resumable: true };
  const active = checkpoint.activeToolCall;
  if (!active || active.recoveryPolicy === 'safe_retry') return { resumable: true };
  return {
    resumable: false,
    reason:
      `Tool ${active.name} was ${active.status} when execution stopped. ` +
      `Its recovery policy is ${active.recoveryPolicy}, so it cannot be replayed automatically.`,
  };
}
