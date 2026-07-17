import fs from 'node:fs';
import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

export function createDeleteFileTool(sandbox: Sandbox): ToolDefinition {
  return {
    name: 'delete_file',
    description:
      'Delete a file within the workspace. The path is relative to the workspace root. ' +
      'Deletion is permanent; use with care. Directories cannot be deleted with this tool.',
    parameters: z.object({
      path: z.string().describe('Relative path to the file within the workspace (e.g. "REPORT.md" or "src/index.ts"); never an absolute path.'),
    }),
    execute: async (args) => {
      const { path: filePath } = args as { path: string };
      const fullPath = sandbox.resolve(filePath);

      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      if (!fs.statSync(fullPath).isFile()) {
        throw new Error(`Not a file (refusing to delete directories): ${filePath}`);
      }

      fs.unlinkSync(fullPath);
      return { path: filePath, deleted: true };
    },
  };
}

export default createDeleteFileTool;
