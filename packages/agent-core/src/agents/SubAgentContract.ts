import type { AgentEvent } from './events.js';
import { redactSensitiveText } from './traceSanitizer.js';

const MAX_EVIDENCE_ITEMS = 8;
const MAX_OBSERVATION_CHARS = 1200;

/** Caller-owned delegation request. Runtime-only correlation fields live on SubAgentTask. */
export interface SubAgentTaskContract {
  /** A self-contained objective for the isolated execution. */
  task: string;
  /** The parent goal this task contributes to. */
  context?: string;
  /** Hard requirements the sub-agent must not silently relax. */
  constraints?: string[];
  /** What a successful outcome should look like. */
  expectedOutcome?: string;
  /** Evidence the caller expects the sub-agent to collect where possible. */
  expectedEvidence?: string[];
  /** Optional narrowing of the inherited read-only tool set. */
  allowedTools?: string[];
}

export interface SubAgentEvidenceItem {
  toolCallId: string;
  toolName: string;
  /** Stable human-readable provenance when the call names a path or URL. */
  source?: string;
  /** Bounded observation copied from a successful tool result. */
  observation: string;
}

export interface SubAgentEvidencePacket {
  /** The sub-agent's own conclusion; the parent still decides whether to trust it. */
  conclusion: string;
  /** Independently observable tool results, linked to their original calls. */
  evidence: SubAgentEvidenceItem[];
  /** Known reasons the conclusion may be incomplete or weakly supported. */
  uncertainty: string[];
  /** Requested evidence that could not be collected. */
  unresolvedQuestions: string[];
}

/**
 * Build the parent-facing evidence contract from execution facts. This does
 * not make another model call and never upgrades an outcome to "verified".
 */
export function buildSubAgentEvidencePacket(
  contract: SubAgentTaskContract,
  conclusion: string,
  events: readonly AgentEvent[],
): SubAgentEvidencePacket {
  const calls = new Map<string, Extract<AgentEvent, { type: 'tool_call' }>['toolCall']>();
  const evidence: SubAgentEvidenceItem[] = [];
  const uncertainty: string[] = [];
  let successfulObservationCount = 0;

  for (const event of events) {
    if (event.type === 'tool_call') {
      calls.set(event.toolCall.id, event.toolCall);
      continue;
    }
    if (event.type !== 'tool_result') continue;

    const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
    const toolName = call?.name ?? 'unknown_tool';
    if (!event.toolResult.success) {
      uncertainty.push(
        `${toolName} failed${event.toolResult.error ? `: ${event.toolResult.error}` : ''}`,
      );
      continue;
    }
    successfulObservationCount++;
    if (!event.toolCallId || evidence.length >= MAX_EVIDENCE_ITEMS) continue;
    evidence.push({
      toolCallId: event.toolCallId,
      toolName,
      source: sourceFromArguments(call?.arguments),
      observation: compactObservation(event.toolResult.data),
    });
  }

  if (evidence.length === 0) {
    uncertainty.push('No successful tool observation was collected; the conclusion is model-only.');
  }
  if (successfulObservationCount > MAX_EVIDENCE_ITEMS) {
    uncertainty.push(`Evidence was capped at ${MAX_EVIDENCE_ITEMS} tool observations.`);
  }

  const unresolvedQuestions = evidence.length === 0
    ? (contract.expectedEvidence ?? []).map((item) => `Evidence not collected: ${item}`)
    : [];

  return {
    conclusion,
    evidence,
    uncertainty: unique(uncertainty),
    unresolvedQuestions,
  };
}

export function formatSubAgentEvidencePacket(packet: SubAgentEvidencePacket): string {
  return JSON.stringify(packet, null, 2);
}

function sourceFromArguments(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  for (const key of ['path', 'url', 'file', 'directory']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function compactObservation(value: unknown): string {
  let serialized: string;
  if (value === undefined) {
    serialized = '[success without returned data]';
  } else if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value) ?? String(value);
    } catch {
      serialized = String(value);
    }
  }
  const redacted = redactSensitiveText(serialized);
  if (redacted.length <= MAX_OBSERVATION_CHARS) return redacted;
  return `${redacted.slice(0, MAX_OBSERVATION_CHARS)}…[truncated]`;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
