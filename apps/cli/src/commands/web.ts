import { buildServer } from '@one-agent/api';
import { config } from '@one-agent/agent-core';
import { validateStartupConfiguration } from '../config-validation.js';
import { CONFIG_PATH, WORKSPACE_ROOT } from '../load-config.js';
import {
  removeWebProcessRecord,
  restartExistingWebProcess,
  writeWebProcessRecord,
} from '../web-process.js';
import { parseWorkspaceArg } from '../workspace.js';

export async function runWebCommand(): Promise<void> {
  if (!validateStartupConfiguration({
    apiKey: config.model.apiKey,
    configPath: CONFIG_PATH,
    workspaceRoot: WORKSPACE_ROOT,
  })) {
    process.exitCode = 1;
    return;
  }

  await restartExistingWebProcess({ port: config.api.port });

  const server = await buildServer({
    workspaceMode: 'selectable',
    workspaceRoot: parseWorkspaceArg(process.argv.slice(2)),
    configPath: CONFIG_PATH,
  });
  const address = `http://${config.api.host}:${config.api.port}`;

  await server.listen({ port: config.api.port, host: config.api.host });
  const processRecordPath = writeWebProcessRecord({
    pid: process.pid,
    host: config.api.host,
    port: config.api.port,
    workspaceRoot: WORKSPACE_ROOT,
    startedAt: new Date().toISOString(),
  });
  console.log(`One Agent Web 已启动：${address}`);
  console.log('工作区：在 Web 中新建会话时选择');
  console.log('按 Ctrl+C 停止。');

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } finally {
      removeWebProcessRecord(processRecordPath);
      process.exit(0);
    }
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.once('exit', () => removeWebProcessRecord(processRecordPath));
}
