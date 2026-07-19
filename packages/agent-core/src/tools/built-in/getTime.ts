import { z } from 'zod';
import { ToolDefinition } from '../types.js';

export function createGetTimeTool(): ToolDefinition {
  return {
    name: 'get_time',
    readOnly: true,
    description: 'Get the current date and time in ISO 8601 format.',
    parameters: z.object({}),
    execute: () => {
      return {
        now: new Date().toISOString(),
        timezone: 'UTC',
      };
    },
  };
}

export default createGetTimeTool;
