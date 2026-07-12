import Fastify from 'fastify';
import { chatRoutes } from './routes/chat.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await fastify.register(chatRoutes);

  return fastify;
}
