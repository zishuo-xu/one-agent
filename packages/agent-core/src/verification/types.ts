import type { AgentEvent } from '../agents/events.js';

export type CompletionStatus =
  | 'verified'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'unverified';

export interface CompletionEvidence {
  kind: 'tool' | 'artifact' | 'plan' | 'response';
  description: string;
  success: boolean;
  toolName?: string;
  path?: string;
}

export interface CompletionOutcome {
  status: CompletionStatus;
  reason: string;
  evidence: CompletionEvidence[];
}

/** Deterministic acceptance conditions supplied by the runtime caller. */
export type CompletionRequirement =
  | {
      kind: 'artifact';
      path: string;
      /** Defaults to true. Set false for a file that must be absent. */
      shouldExist?: boolean;
      containsAll?: string[];
      notContains?: string[];
    }
  | {
      kind: 'response';
      containsAny?: string[];
      containsAll?: string[];
      notContains?: string[];
    };

export interface CompletionVerificationInput {
  request: string;
  reply: string;
  events: AgentEvent[];
}

export interface CompletionVerifier {
  verify(input: CompletionVerificationInput): Promise<CompletionOutcome>;
}
