import { Sandbox } from '../sandbox.js';
import { createReadFileTool } from './readFile.js';
import { createWriteFileTool } from './writeFile.js';
import { createListFilesTool } from './listFiles.js';
import { createGetTimeTool } from './getTime.js';

export function createBuiltInTools(sandbox: Sandbox) {
  return [
    createReadFileTool(sandbox),
    createWriteFileTool(sandbox),
    createListFilesTool(sandbox),
    createGetTimeTool(),
  ];
}

export {
  createReadFileTool,
  createWriteFileTool,
  createListFilesTool,
  createGetTimeTool,
};
