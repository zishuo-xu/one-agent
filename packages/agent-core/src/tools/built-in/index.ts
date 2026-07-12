import { Sandbox } from '../sandbox.js';
import { createReadFileTool } from './readFile.js';
import { createWriteFileTool } from './writeFile.js';
import { createListFilesTool } from './listFiles.js';

export function createBuiltInTools(sandbox: Sandbox) {
  return [createReadFileTool(sandbox), createWriteFileTool(sandbox), createListFilesTool(sandbox)];
}

export { createReadFileTool, createWriteFileTool, createListFilesTool };
