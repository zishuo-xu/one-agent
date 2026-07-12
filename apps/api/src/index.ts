import { buildServer } from './server.js';
import { config } from '@one-agent/agent-core';

async function main() {
  const server = await buildServer();

  try {
    await server.listen({ port: config.port, host: config.host });
    server.log.info(`API server listening on http://${config.host}:${config.port}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

main();
