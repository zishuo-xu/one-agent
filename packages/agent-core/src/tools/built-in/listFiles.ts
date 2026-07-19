import fs from 'node:fs';
import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

export function createListFilesTool(sandbox: Sandbox): ToolDefinition {
  return {
    name: 'list_files',
    readOnly: true,
    description:
      'List files and directories within a workspace directory. ' +
      'The path is relative to the workspace root. ' +
      'Returns names only (not recursive).',
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe('Relative path to the directory within the workspace (e.g. "src"); never an absolute path. Defaults to root.'),
    }),
    execute: (args) => {
      const { path: dirPath = '' } = args as { path?: string };
      const fullPath = sandbox.resolve(dirPath || '.');

      if (!fs.existsSync(fullPath)) {
        throw new Error(`Directory not found: ${dirPath || '.'}`);
      }

      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      return {
        path: dirPath || '',
        files: entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)),
      };
    },
  };
}

export default createListFilesTool;
