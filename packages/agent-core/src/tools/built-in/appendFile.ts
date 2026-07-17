import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

export function createAppendFileTool(sandbox: Sandbox): ToolDefinition {
  return {
    name: 'append_file',
    description:
      'Append content to a text file within the workspace. ' +
      'The path is relative to the workspace root. ' +
      'Creates the file and parent directories if they do not exist.',
    parameters: z.object({
      path: z.string().describe('Relative path to the file within the workspace (e.g. "REPORT.md" or "src/index.ts"); never an absolute path.'),
      content: z.string().describe('Content to append to the file.'),
    }),
    execute: async (args) => {
      const { path: filePath, content } = args as { path: string; content: string };
      const fullPath = sandbox.resolve(filePath);

      if (!sandbox.isTextFile(filePath)) {
        throw new Error(`Only text files are allowed: ${filePath}`);
      }

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.appendFileSync(fullPath, content, 'utf-8');
      return { path: filePath, bytes: Buffer.byteLength(content, 'utf-8') };
    },
  };
}

export default createAppendFileTool;
