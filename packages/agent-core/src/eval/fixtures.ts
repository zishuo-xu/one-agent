import { ToolCall } from '../tools/types.js';

export interface MockToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export function createToolCallResponse(toolCalls: MockToolCall[]) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        },
      },
    ],
  };
}

export function createTextResponse(content: string) {
  return {
    choices: [
      {
        message: {
          content,
        },
      },
    ],
  };
}

export function createToolResultResponse(toolCall: ToolCall, result: unknown) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: toolCall.id,
              type: 'function' as const,
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              },
            },
          ],
        },
      },
    ],
  };
}
