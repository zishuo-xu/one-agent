import fs from 'node:fs';
import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

export function createReadFileTool(sandbox: Sandbox): ToolDefinition {
  return {
    name: 'read_file',
    description:
      'Read the content of a text file within the workspace. ' +
      'The path is relative to the workspace root. ' +
      'Only allows text files such as .txt, .md, .json, .ts, .js.',
    parameters: z.object({
      path: z.string().describe('Relative path to the file within the workspace.'),
    }),
    execute: (args) => {
      const { path } = args as { path: string };
      const fullPath = sandbox.resolve(path);

      if (!sandbox.isTextFile(path)) {
        throw new Error(`Only text files are allowed: ${path}`);
      }

      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${path}`);
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      return { content };
    },
  };
}

export default createReadFileTool;
