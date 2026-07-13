import { FastifyInstance } from 'fastify';
import {
  AgentLoop,
  config,
  ContextManager,
  createBuiltInTools,
  Sandbox,
  ToolRegistry,
  ThreadStore,
  MessageStore,
  RunStore,
  ToolCallStore,
  MemoryStore,
  MemoryExtractor,
  getSharedConnection,
} from '@one-agent/agent-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../workspace'
);

process.env.DATABASE_PATH =
  process.env.DATABASE_PATH ?? path.join(WORKSPACE_ROOT, 'data.db');

export interface ChatBody {
  message: string;
  threadId?: string;
}

export interface ChatReply {
  reply?: string;
  events?: unknown[];
  threadId?: string;
  error?: string;
}

function truncateTitle(text: string, maxLength = 50): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  const sandbox = new Sandbox(WORKSPACE_ROOT);
  const tools = new ToolRegistry();
  tools.registerMany(createBuiltInTools(sandbox));

  const db = getSharedConnection();
  const threadStore = new ThreadStore(db);
  const messageStore = new MessageStore(db);
  const runStore = new RunStore(db);
  const toolCallStore = new ToolCallStore(db);
  const memoryStore = new MemoryStore(db);
  const memoryExtractor = new MemoryExtractor();

  fastify.post<{ Body: ChatBody; Reply: ChatReply }>('/api/chat', async (request, reply) => {
    const { message, threadId: bodyThreadId } = request.body;

    if (!message || typeof message !== 'string') {
      return reply.status(400).send({ error: 'message is required and must be a string' });
    }

    let threadId: string;
    try {
      if (bodyThreadId) {
        const existing = threadStore.getById(bodyThreadId);
        if (!existing) {
          return reply.status(404).send({ error: `Thread not found: ${bodyThreadId}` });
        }
        threadId = existing.id;
      } else {
        const thread = threadStore.create({ title: truncateTitle(message) });
        threadId = thread.id;
      }

      const agent = new AgentLoop({ tools, threadId, memoryStore, memoryExtractor });
      const { reply: response, events } = await agent.chat(message);
      return { reply: response, events, threadId };
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

  fastify.get('/api/threads', async () => {
    return threadStore.list();
  });

  fastify.get<{ Params: { id: string } }>('/api/threads/:id/messages', async (request, reply) => {
    const { id } = request.params;
    const thread = threadStore.getById(id);
    if (!thread) {
      return reply.status(404).send({ error: `Thread not found: ${id}` });
    }
    return messageStore.getByThread(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/threads/:id/runs', async (request, reply) => {
    const { id } = request.params;
    const thread = threadStore.getById(id);
    if (!thread) {
      return reply.status(404).send({ error: `Thread not found: ${id}` });
    }
    return runStore.getByThread(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id/tool-calls', async (request, reply) => {
    const { id } = request.params;
    const run = runStore.getById(id);
    if (!run) {
      return reply.status(404).send({ error: `Run not found: ${id}` });
    }
    return toolCallStore.getByRun(id);
  });
}
