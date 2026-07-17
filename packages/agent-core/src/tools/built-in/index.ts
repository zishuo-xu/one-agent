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
  createWebSearchTool,
];

export function createBuiltInTools(sandbox: Sandbox): ToolDefinition[] {
  // Operators can disable tools by name (e.g. DISABLED_TOOLS=run_command,delete_file)
  // when exposing the agent over an API where shell access would be unsafe.
  const disabled = (process.env.DISABLED_TOOLS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return factories
    .map((factory) => factory(sandbox))
    .filter((tool) => !disabled.includes(tool.name));
}
