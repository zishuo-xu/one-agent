import Fastify from 'fastify';
import { chatRoutes } from './routes/chat.js';
import { taskRoutes } from './routes/tasks.js';
import { memoryRoutes } from './routes/memory.js';
import { traceRoutes } from './routes/traces.js';
import { AgentRuntime } from '@one-agent/agent-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../workspace',
);

process.env.DATABASE_PATH =
  process.env.DATABASE_PATH ?? path.join(WORKSPACE_ROOT, 'data.db');

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  const runtime = new AgentRuntime({ workspaceRoot: WORKSPACE_ROOT });
  await fastify.register(chatRoutes, { runtime });
  await fastify.register(taskRoutes, { runtime });
  await fastify.register(memoryRoutes, { runtime });
  await fastify.register(traceRoutes, { runtime });

  return fastify;
}
