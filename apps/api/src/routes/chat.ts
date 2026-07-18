import { FastifyInstance } from 'fastify';
import {
  AgentRuntime,
  config,
} from '@one-agent/agent-core';
import type { UserInputRequest } from '@one-agent/agent-core';

export interface ChatBody {
  message: string;
  threadId?: string;
}

export interface ChatReply {
  status?: 'completed' | 'waiting_for_input';
  reply?: string;
  events?: unknown[];
  threadId?: string;
  runId?: string;
  inputRequest?: UserInputRequest;
  error?: string;
}

export interface ContinueRunBody {
  answer: string;
}

function truncateTitle(text: string, maxLength = 50): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

export async function chatRoutes(
  fastify: FastifyInstance,
  options: { runtime: AgentRuntime },
): Promise<void> {
  const { runtime } = options;
  const threadStore = runtime.stores.threads;
  const messageStore = runtime.stores.messages;
  const runStore = runtime.stores.runs;
  const toolCallStore = runtime.stores.toolCalls;
  void runtime.memory.recoverUnextracted();

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

      const agent = runtime.createAgent({ threadId });
      const result = await agent.chat(message);
      return {
        status: result.status,
        reply: result.reply,
        events: result.events,
        threadId,
        runId: result.runId,
        inputRequest: result.inputRequest,
      };
    } catch (error) {
      fastify.log.error(error);
      const errMessage =
        error instanceof Error ? error.message : 'An unexpected error occurred';
      return reply.status(500).send({ error: errMessage });
    }
  });

  fastify.post<{
    Params: { id: string };
    Body: ContinueRunBody;
    Reply: ChatReply;
  }>('/api/runs/:id/input', async (request, reply) => {
    const run = runStore.getById(request.params.id);
    if (!run) return reply.status(404).send({ error: `Run not found: ${request.params.id}` });
    if (!request.body?.answer || typeof request.body.answer !== 'string') {
      return reply.status(400).send({ error: 'answer is required and must be a string' });
    }
    try {
      const agent = runtime.createAgent({ threadId: run.threadId });
      const result = await agent.continueRun(run.id, request.body.answer);
      return {
        status: result.status,
        reply: result.reply,
        events: result.events,
        threadId: run.threadId,
        runId: result.runId,
        inputRequest: result.inputRequest,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to continue run';
      return reply.status(409).send({ error: message });
    }
  });

  fastify.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request, reply) => {
    const run = runStore.getById(request.params.id);
    if (!run) return reply.status(404).send({ error: `Run not found: ${request.params.id}` });
    const agent = runtime.createAgent({ threadId: run.threadId });
    if (!agent.cancelWaitingRun(run.id)) {
      return reply.status(409).send({ error: `Run ${run.id} is not waiting for input` });
    }
    return { runId: run.id, status: 'cancelled' };
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
