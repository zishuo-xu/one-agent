import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE_NAME, loadSystemConfig } from '@one-agent/agent-core';
import { resolveWorkspaceRoot } from './workspace.js';

export const WORKSPACE_ROOT = resolveWorkspaceRoot();
export const CONFIG_PATH = path.join(WORKSPACE_ROOT, CONFIG_FILE_NAME);

if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

// --init/help/version must still start before a config exists. Chat and doctor
// perform their own required-config checks before using the model.
if (fs.existsSync(CONFIG_PATH)) {
  loadSystemConfig({ workspaceRoot: WORKSPACE_ROOT, configPath: CONFIG_PATH });
}
