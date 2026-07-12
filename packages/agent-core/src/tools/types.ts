import { z } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: unknown) => Promise<unknown> | unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
