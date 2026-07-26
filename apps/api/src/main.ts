import './load-config.js';
import { config } from '@one-agent/agent-core';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const server = await buildServer();
  await server.listen({ port: config.api.port, host: config.api.host });
  server.log.info(`One Agent Web listening on http://${config.api.host}:${config.api.port}`);
}

main().catch((error) => {
  console.error('Failed to start One Agent Web:', error);
  process.exit(1);
});
