import { z } from 'zod';
import { ToolDefinition } from '../tools/types.js';
import type { SubAgentRunner, SubAgentTask } from './SubAgentRunner.js';

export const SPAWN_AGENT_TOOL_NAME = 'spawn_agent';

/**
 * The spawn_agent tool lets the main agent delegate a self-contained subtask
 * to an isolated sub-agent. The sub-agent runs with a fresh context and its
 * own tool loop; only its condensed result comes back as the tool result.
 */
export function createSpawnAgentTool(
  run: (task: SubAgentTask) => Promise<import('./SubAgentRunner.js').SubAgentResult>,
): ToolDefinition {
  return {
    name: SPAWN_AGENT_TOOL_NAME,
    readOnly: true,
    description:
      'Spawn one sub-agent for a complete, self-contained, read-only work package. ' +
      'Use it for a distinct investigation domain or outcome that benefits from context isolation or parallel work. ' +
      'Do not use it for one file read, one search, one keyword check, one tool call, sibling-result aggregation, or the final answer. ' +
      'Put related internal checks in checklist so they stay inside this one agent. ' +
      'The sub-agent cannot modify state or spawn further agents. ' +
      'Its result is unverified evidence for the parent agent, not proof that the parent task is complete.',
    parameters: z.object({
      task: z.string().describe('A clear, self-contained description of the subtask to execute.'),
      context: z
        .string()
        .optional()
        .describe('The overall goal this subtask contributes to, for the sub-agent\'s orientation.'),
      expectedOutcome: z
        .string()
        .min(1)
        .describe('The concrete, parent-facing deliverable this work package must return.'),
      delegationReason: z
        .string()
        .min(1)
        .describe('Why isolation or parallel execution materially improves this work.'),
      constraints: z
        .array(z.string().min(1))
        .optional()
        .describe('Hard requirements the sub-agent must preserve.'),
      expectedEvidence: z
        .array(z.string().min(1))
        .min(1)
        .describe('Concrete evidence or sources the sub-agent should collect.'),
      scope: z
        .array(z.string().min(1))
        .optional()
        .describe('Bounded areas included in the investigation.'),
      nonGoals: z
        .array(z.string().min(1))
        .optional()
        .describe('Areas explicitly excluded to avoid overlap with sibling agents.'),
      checklist: z
        .array(z.object({
          id: z.string().min(1),
          description: z.string().min(1),
        }))
        .optional()
        .describe('Related internal checks owned by this one sub-agent.'),
    }),
    execute: async (args) => {
      const {
        task,
        context,
        expectedOutcome,
        delegationReason,
        constraints,
        expectedEvidence,
        scope,
        nonGoals,
        checklist,
      } = args as {
        task: string;
        context?: string;
        expectedOutcome: string;
        delegationReason: string;
        constraints?: string[];
        expectedEvidence: string[];
        scope?: string[];
        nonGoals?: string[];
        checklist?: Array<{ id: string; description: string }>;
      };
      const result = await run({
        contractVersion: 2,
        task,
        context,
        expectedOutcome,
        delegationReason,
        constraints,
        expectedEvidence,
        scope,
        nonGoals,
        checklist,
      });
      if (result.executionStatus !== 'completed') {
        throw new Error(`Sub-agent failed: ${result.error ?? 'unknown error'}`);
      }
      return {
        executionStatus: result.executionStatus,
        outcomeStatus: result.outcomeStatus,
        evidencePacket: result.evidencePacket,
        toolCallCount: result.toolCalls.length,
        durationMs: result.durationMs,
      };
    },
  };
}
