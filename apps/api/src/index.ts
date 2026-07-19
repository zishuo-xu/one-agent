import './load-config.js';
import { buildServer } from './server.js';
import { config } from '@one-agent/agent-core';

async function main() {
  const server = await buildServer();

  try {
    await server.listen({ port: config.api.port, host: config.api.host });
    server.log.info(`API server listening on http://${config.api.host}:${config.api.port}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

main();
