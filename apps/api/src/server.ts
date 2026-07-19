import Fastify from 'fastify';
import { chatRoutes } from './routes/chat.js';
import { taskRoutes } from './routes/tasks.js';
import { memoryRoutes } from './routes/memory.js';
import { traceRoutes } from './routes/traces.js';
import { AgentRuntime } from '@one-agent/agent-core';
import { config } from '@one-agent/agent-core';
import { WORKSPACE_ROOT } from './workspace.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.api.logLevel,
    },
  });

  const runtime = new AgentRuntime({ workspaceRoot: WORKSPACE_ROOT });
  await fastify.register(chatRoutes, { runtime });
  await fastify.register(taskRoutes, { runtime });
  await fastify.register(memoryRoutes, { runtime });
  await fastify.register(traceRoutes, { runtime });

  return fastify;
}
