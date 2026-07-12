import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

export function createWriteFileTool(sandbox: Sandbox): ToolDefinition {
  return {
    name: 'write_file',
    description:
      'Write content to a text file within the workspace. ' +
      'The path is relative to the workspace root. ' +
      'Creates the file and parent directories if they do not exist.',
    parameters: z.object({
      path: z.string().describe('Relative path to the file within the workspace.'),
      content: z.string().describe('Content to write to the file.'),
    }),
    execute: (args) => {
      const { path: filePath, content } = args as { path: string; content: string };
      const fullPath = sandbox.resolve(filePath);

      if (!sandbox.isTextFile(filePath)) {
        throw new Error(`Only text files are allowed: ${filePath}`);
      }

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, content, 'utf-8');
      return { path: filePath, bytes: Buffer.byteLength(content, 'utf-8') };
    },
  };
}
