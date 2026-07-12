import { FastifyInstance } from 'fastify';
import { AgentLoop, config } from '@one-agent/agent-core';

export interface ChatBody {
  message: string;
}

export interface ChatReply {
  reply?: string;
  error?: string;
}

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ChatBody; Reply: ChatReply }>('/api/chat', async (request, reply) => {
    const { message } = request.body;

    if (!message || typeof message !== 'string') {
      return reply.status(400).send({ error: 'message is required and must be a string' });
    }

    try {
      const agent = new AgentLoop();
      const { reply } = await agent.chat(message);
      return { reply };
    } catch (error) {
      fastify.log.error(error);
      const errMessage =
        error instanceof Error ? error.message : 'An unexpected error occurred';
      return reply.status(500).send({ error: errMessage });
    }
  });

  fastify.get('/api/health', async () => {
    return { status: 'ok', model: config.model };
  });
}
