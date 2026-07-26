import fs from 'node:fs';
import path from 'node:path';
import { loadSystemConfig } from '@one-agent/agent-core';
import {
  getGlobalConfigPath,
  isWebCommand,
  resolveInitConfigPath,
  resolveStartupConfigPath,
  resolveWorkspaceRoot,
} from './workspace.js';

const argv = process.argv.slice(2);
const requestedWorkspaceRoot = resolveWorkspaceRoot({ argv });
const globalConfigPath = getGlobalConfigPath();
const webMode = isWebCommand(argv);

export const WORKSPACE_ROOT = webMode
  ? path.dirname(globalConfigPath)
  : requestedWorkspaceRoot;
export const CONFIG_PATH = resolveStartupConfigPath({
  argv,
  workspaceRoot: requestedWorkspaceRoot,
});
export const INIT_CONFIG_PATH = resolveInitConfigPath({
  argv,
  workspaceRoot: requestedWorkspaceRoot,
});

if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

// A local configuration is optional and takes precedence over the user's
// global configuration. --init/help/version must still work before either
// configuration exists.
if (fs.existsSync(CONFIG_PATH)) {
  loadSystemConfig({ workspaceRoot: WORKSPACE_ROOT, configPath: CONFIG_PATH });
}
