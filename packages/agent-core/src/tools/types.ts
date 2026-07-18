import { z } from 'zod';
import type { ModelToolDefinition } from '../model/types.js';

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

/** @deprecated Provider-facing schemas are now ModelToolDefinition. */
export type ToolSchema = ModelToolDefinition;
