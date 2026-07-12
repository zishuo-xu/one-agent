import { FastifyInstance } from 'fastify';
import {
  AgentLoop,
  config,
  ContextManager,
  createBuiltInTools,
  Sandbox,
  ToolRegistry,
} from '@one-agent/agent-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../workspace'
);

export interface ChatBody {
  message: string;
}

export interface ChatReply {
  reply?: string;
  events?: unknown[];
  error?: string;
}

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  const sandbox = new Sandbox(WORKSPACE_ROOT);
  const tools = new ToolRegistry();
  tools.registerMany(createBuiltInTools(sandbox));

  fastify.post<{ Body: ChatBody; Reply: ChatReply }>('/api/chat', async (request, reply) => {
    const { message } = request.body;

    if (!message || typeof message !== 'string') {
      return reply.status(400).send({ error: 'message is required and must be a string' });
    }

    try {
      const contextManager = new ContextManager({ systemPrompt: config.systemPrompt });
      const agent = new AgentLoop({ tools, contextManager });
      const { reply: response, events } = await agent.chat(message);
      return { reply: response, events };
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
