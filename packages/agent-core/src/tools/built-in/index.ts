import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Sandbox } from '../sandbox.js';
import { ToolDefinition } from '../types.js';

export { createReadFileTool } from './readFile.js';
export { createWriteFileTool } from './writeFile.js';
export { createListFilesTool } from './listFiles.js';
export { createGetTimeTool } from './getTime.js';

const BUILT_IN_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.extname(fileURLToPath(import.meta.url));

const factories = await loadBuiltInFactories();

export function createBuiltInTools(sandbox: Sandbox): ToolDefinition[] {
  return factories.map((factory) => factory(sandbox));
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
