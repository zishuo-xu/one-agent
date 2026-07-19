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
    description:
      'Spawn a sub-agent to execute a self-contained subtask in an isolated context. ' +
      'Use it for independent read-only research or analysis that benefits from ' +
      'a focused agent loop. The sub-agent cannot modify state or spawn further agents. ' +
      'Its result is unverified evidence for the parent agent, not proof that the parent task is complete.',
    parameters: z.object({
      task: z.string().describe('A clear, self-contained description of the subtask to execute.'),
      context: z
        .string()
        .optional()
        .describe('The overall goal this subtask contributes to, for the sub-agent\'s orientation.'),
      expectedOutcome: z
        .string()
        .optional()
        .describe('What a successful result should look like.'),
    }),
    execute: async (args) => {
      const { task, context, expectedOutcome } = args as {
        task: string;
        context?: string;
        expectedOutcome?: string;
      };
      const result = await run({ task, context, expectedOutcome });
      if (result.executionStatus !== 'completed') {
        throw new Error(`Sub-agent failed: ${result.error ?? 'unknown error'}`);
      }
      return {
        executionStatus: result.executionStatus,
        outcomeStatus: result.outcomeStatus,
        summary: result.summary,
        toolCallCount: result.toolCalls.length,
        durationMs: result.durationMs,
      };
    },
  };
}
