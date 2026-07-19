import fs from 'node:fs';
import path from 'node:path';
import { config, loadSystemConfig } from '@one-agent/agent-core';
import { resolveWorkspaceRoot } from './workspace.js';
import { startTraceWebServer } from './server.js';

function parseArgs(): { port: number; host: string } {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 && args[portIndex + 1] ? Number(args[portIndex + 1]) : config.trace.port;
  const hostIndex = args.indexOf('--host');
  const host = hostIndex >= 0 && args[hostIndex + 1] ? args[hostIndex + 1] : config.trace.host;
  return { port, host };
}

async function main(): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();

  if (!fs.existsSync(workspaceRoot)) {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }

  loadSystemConfig({ workspaceRoot });

  const { port, host } = parseArgs();
  await startTraceWebServer({ port, host });
}

main().catch((error) => {
  console.error('Failed to start trace web server:', error);
  process.exit(1);
});
