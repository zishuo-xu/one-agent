import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { resolveWorkspaceRoot } from './workspace.js';
import { startTraceWebServer } from './server.js';

function parseArgs(): { port: number; host: string } {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 && args[portIndex + 1] ? Number(args[portIndex + 1]) : 3001;
  const hostIndex = args.indexOf('--host');
  const host = hostIndex >= 0 && args[hostIndex + 1] ? args[hostIndex + 1] : '127.0.0.1';
  return { port, host };
}

async function main(): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();

  if (!fs.existsSync(workspaceRoot)) {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }

  const envPath = path.join(workspaceRoot, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  process.env.DATABASE_PATH = process.env.DATABASE_PATH ?? path.join(workspaceRoot, 'data.db');

  const { port, host } = parseArgs();
  await startTraceWebServer({ port, host });
}

main().catch((error) => {
  console.error('Failed to start trace web server:', error);
  process.exit(1);
});
