import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Sandbox } from '../sandbox.js';
import { ToolDefinition } from '../types.js';

export { createReadFileTool } from './readFile.js';
export { createWriteFileTool } from './writeFile.js';
export { createAppendFileTool } from './appendFile.js';
export { createDeleteFileTool } from './deleteFile.js';
export { createSearchFilesTool } from './searchFiles.js';
export { createListFilesTool } from './listFiles.js';
export { createGetTimeTool } from './getTime.js';
export { createRunCommandTool } from './shellExec.js';

const BUILT_IN_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.extname(fileURLToPath(import.meta.url));

const factories = await loadBuiltInFactories();

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

async function loadBuiltInFactories(): Promise<Array<(sandbox: Sandbox) => ToolDefinition>> {
  const entries = await readdir(BUILT_IN_DIR);
  const factories: Array<(sandbox: Sandbox) => ToolDefinition> = [];

  for (const entry of entries) {
    if (entry === `index${EXTENSION}`) continue;
    if (!entry.endsWith(EXTENSION)) continue;

    const moduleUrl = new URL(`./${entry}`, import.meta.url).href;
    const mod = (await import(moduleUrl)) as { default?: (sandbox: Sandbox) => ToolDefinition };
    if (typeof mod.default === 'function') {
      factories.push(mod.default);
    }
  }

  return factories;
}
