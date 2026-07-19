import path from 'node:path';
import { loadSystemConfig } from '@one-agent/agent-core';
import { REPOSITORY_ROOT, WORKSPACE_ROOT } from './workspace.js';

loadSystemConfig({
  workspaceRoot: WORKSPACE_ROOT,
  configPath: path.join(REPOSITORY_ROOT, 'one-agent.config.json'),
});
