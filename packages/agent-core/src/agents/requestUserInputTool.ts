import crypto from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../tools/types.js';

export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';

export const REQUEST_USER_INPUT_SYSTEM_INSTRUCTION =
  'If a task cannot be completed correctly without one critical piece of information, call request_user_input once with one concise question. Do not use it for permission or approval, do not combine it with other tool calls, and do not ask when a reasonable safe assumption is possible.';

export interface UserInputRequest {
  id: string;
  question: string;
  options?: string[];
  createdAt: string;
}

interface UserInputControlSignal {
  control: 'waiting_for_input';
  request: UserInputRequest;
}

export function createRequestUserInputTool(): ToolDefinition {
  return {
    name: REQUEST_USER_INPUT_TOOL_NAME,
    description:
      'Pause this task and ask the user for one critical missing piece of information. This is for clarification, not approval.',
    parameters: z.object({
      question: z.string().trim().min(1).describe('One concise question for the user'),
      options: z.array(z.string().trim().min(1)).max(5).optional()
        .describe('Optional short answer choices'),
    }),
    execute: (args): UserInputControlSignal => {
      const input = args as { question: string; options?: string[] };
      return {
        control: 'waiting_for_input',
        request: {
          id: crypto.randomUUID(),
          question: input.question.trim(),
          options: input.options?.map((option) => option.trim()),
          createdAt: new Date().toISOString(),
        },
      };
    },
  };
}

export function readUserInputRequest(result: ToolResult): UserInputRequest | undefined {
  if (!result.success || !result.data || typeof result.data !== 'object') return undefined;
  const signal = result.data as Partial<UserInputControlSignal>;
  if (signal.control !== 'waiting_for_input' || !signal.request?.question) return undefined;
  return signal.request;
}
