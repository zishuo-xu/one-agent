import { Sandbox } from '../sandbox.js';
import { ToolDefinition } from '../types.js';
import { createReadFileTool } from './readFile.js';
import { createWriteFileTool } from './writeFile.js';
import { createAppendFileTool } from './appendFile.js';
import { createDeleteFileTool } from './deleteFile.js';
import { createSearchFilesTool } from './searchFiles.js';
import { createListFilesTool } from './listFiles.js';
import { createGetTimeTool } from './getTime.js';
import { createRunCommandTool } from './shellExec.js';
import { createWebSearchTool } from './webSearch.js';

export { createReadFileTool } from './readFile.js';
export { createWriteFileTool } from './writeFile.js';
export { createAppendFileTool } from './appendFile.js';
export { createDeleteFileTool } from './deleteFile.js';
export { createSearchFilesTool } from './searchFiles.js';
export { createListFilesTool } from './listFiles.js';
export { createGetTimeTool } from './getTime.js';
export { createRunCommandTool } from './shellExec.js';
export { createWebSearchTool } from './webSearch.js';

/**
 * Explicit factory list: deterministic order, bundler-safe, and a new tool
 * is registered by adding one import + one line here (the previous
 * read-our-own-directory scan did implicit, order-unstable discovery with a
 * top-level await).
 */
const factories: Array<(sandbox: Sandbox) => ToolDefinition> = [
  createReadFileTool,
  createWriteFileTool,
  createAppendFileTool,
  createDeleteFileTool,
  createListFilesTool,
  createSearchFilesTool,
  createGetTimeTool,
  createRunCommandTool,
];

export interface BuiltInToolOptions {
  disabled?: string[];
  search?: { apiUrl?: string; apiKey?: string };
}

export function createBuiltInTools(sandbox: Sandbox, options: BuiltInToolOptions = {}): ToolDefinition[] {
  const disabled = options.disabled ?? [];
  return [...factories.map((factory) => factory(sandbox)), createWebSearchTool(sandbox, options.search)]
    .filter((tool) => !disabled.includes(tool.name));
}
