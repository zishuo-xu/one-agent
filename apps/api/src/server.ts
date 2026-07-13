import Fastify from 'fastify';
import { chatRoutes } from './routes/chat.js';
import { taskRoutes } from './routes/tasks.js';
import { memoryRoutes } from './routes/memory.js';
import { traceRoutes } from './routes/traces.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await fastify.register(chatRoutes);
  await fastify.register(taskRoutes);
  await fastify.register(memoryRoutes);
  await fastify.register(traceRoutes);

  return fastify;
}
