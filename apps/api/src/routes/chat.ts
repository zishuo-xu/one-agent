import { FastifyInstance } from 'fastify';
import { config } from '@one-agent/agent-core';
import type { UserInputRequest } from '@one-agent/agent-core';
import {
  beginRuntimeOperation,
  currentRuntime,
  type RuntimeRouteOptions,
} from '../runtime-provider.js';

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

export interface AsyncRunReply {
  status: 'running';
  threadId: string;
  runId: string;
}

function truncateTitle(text: string, maxLength = 50): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

function runInBackground(
  operation: Promise<unknown>,
  releaseOperation: () => void,
  logError: (error: unknown) => void,
): void {
  void operation
    .catch((error) => {
      logError(error);
    })
    .finally(releaseOperation);
}

export async function chatRoutes(
  fastify: FastifyInstance,
  options: RuntimeRouteOptions,
): Promise<void> {
  await currentRuntime(options).runtime.memory.recoverUnextracted();

  fastify.post<{ Body: ChatBody; Reply: ChatReply }>('/api/chat', async (request, reply) => {
    const { runtime } = currentRuntime(options);
    const threadStore = runtime.stores.threads;
    const { message, threadId: bodyThreadId } = request.body;

    if (!message || typeof message !== 'string') {
      return reply.status(400).send({ error: 'message is required and must be a string' });
    }

    let threadId: string;
    const releaseOperation = beginRuntimeOperation(runtime);
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
    } finally {
      releaseOperation();
    }
  });

  fastify.post<{ Body: ChatBody; Reply: AsyncRunReply | { error: string } }>(
    '/api/web/chat',
    async (request, reply) => {
      const { runtime } = currentRuntime(options);
      const threadStore = runtime.stores.threads;
      const runStore = runtime.stores.runs;
      const { message, threadId: bodyThreadId } = request.body;

      if (!message || typeof message !== 'string') {
        return reply.status(400).send({ error: 'message is required and must be a string' });
      }

      let threadId: string;
      if (bodyThreadId) {
        const existing = threadStore.getById(bodyThreadId);
        if (!existing) {
          return reply.status(404).send({ error: `Thread not found: ${bodyThreadId}` });
        }
        threadId = existing.id;
      } else {
        threadId = threadStore.create({ title: truncateTitle(message) }).id;
      }
      if (runStore.getWaitingByThread(threadId)) {
        return reply.status(409).send({
          error: 'Thread is waiting for user input. Continue or cancel it first.',
        });
      }
      if (runStore.getRunningByThread(threadId).length > 0) {
        return reply.status(409).send({ error: 'Thread already has a running operation.' });
      }

      const releaseOperation = beginRuntimeOperation(runtime);
      const agent = runtime.createAgent({ threadId });
      const operation = agent.chat(message);
      const run = runStore.getRunningByThread(threadId)[0];
      if (!run) {
        releaseOperation();
        try {
          await operation;
        } catch (error) {
          fastify.log.error(error);
          return reply.status(500).send({
            error: error instanceof Error ? error.message : 'Failed to start run',
          });
        }
        return reply.status(500).send({ error: 'Agent completed without creating a Run.' });
      }

      runInBackground(operation, releaseOperation, (error) => fastify.log.error(error));
      return reply.status(202).send({ status: 'running', threadId, runId: run.id });
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: ContinueRunBody;
    Reply: ChatReply;
  }>('/api/runs/:id/input', async (request, reply) => {
    const { runtime } = currentRuntime(options);
    const runStore = runtime.stores.runs;
    const run = runStore.getById(request.params.id);
    if (!run) return reply.status(404).send({ error: `Run not found: ${request.params.id}` });
    if (!request.body?.answer || typeof request.body.answer !== 'string') {
      return reply.status(400).send({ error: 'answer is required and must be a string' });
    }
    const releaseOperation = beginRuntimeOperation(runtime);
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
    } finally {
      releaseOperation();
    }
  });

  fastify.post<{
    Params: { id: string };
    Body: ContinueRunBody;
    Reply: AsyncRunReply | { error: string };
  }>('/api/web/runs/:id/input', async (request, reply) => {
    const { runtime } = currentRuntime(options);
    const runStore = runtime.stores.runs;
    const run = runStore.getById(request.params.id);
    if (!run) return reply.status(404).send({ error: `Run not found: ${request.params.id}` });
    if (!request.body?.answer || typeof request.body.answer !== 'string') {
      return reply.status(400).send({ error: 'answer is required and must be a string' });
    }
    if (run.status !== 'waiting_for_input') {
      return reply.status(409).send({ error: `Run ${run.id} is not waiting for user input.` });
    }
    if (runStore.getRunningByThread(run.threadId).length > 0) {
      return reply.status(409).send({ error: 'Thread already has a running operation.' });
    }

    const previousRunIds = new Set(
      runStore.getByThread(run.threadId).map((candidate) => candidate.id),
    );
    const releaseOperation = beginRuntimeOperation(runtime);
    const agent = runtime.createAgent({ threadId: run.threadId });
    const operation = agent.continueRun(run.id, request.body.answer);
    const continuation = runStore
      .getRunningByThread(run.threadId)
      .find((candidate) => !previousRunIds.has(candidate.id));
    if (!continuation) {
      releaseOperation();
      try {
        await operation;
      } catch (error) {
        return reply.status(409).send({
          error: error instanceof Error ? error.message : 'Failed to continue run',
        });
      }
      return reply.status(500).send({ error: 'Agent continued without creating a Run.' });
    }

    runInBackground(operation, releaseOperation, (error) => fastify.log.error(error));
    return reply.status(202).send({
      status: 'running',
      threadId: run.threadId,
      runId: continuation.id,
    });
  });

  fastify.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request, reply) => {
    const { runtime } = currentRuntime(options);
    const runStore = runtime.stores.runs;
    const run = runStore.getById(request.params.id);
    if (!run) return reply.status(404).send({ error: `Run not found: ${request.params.id}` });
    const agent = runtime.createAgent({ threadId: run.threadId });
    if (!agent.cancelWaitingRun(run.id)) {
      return reply.status(409).send({ error: `Run ${run.id} is not waiting for input` });
    }
    return { runId: run.id, status: 'cancelled' };
  });

  fastify.get('/api/health', async () => {
    const selected = currentRuntime(options);
    return {
      status: 'ok',
      model: config.model.model,
      loop: config.runtime.loop,
      workspace: selected.workspaceRoot,
    };
  });

  fastify.get('/api/threads', async () => {
    return currentRuntime(options).runtime.stores.threads.list();
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = currentRuntime(options).runtime.stores.runs.getById(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: `Run not found: ${request.params.id}` });
    }
    return run;
  });

  fastify.get<{ Params: { id: string } }>('/api/threads/:id/messages', async (request, reply) => {
    const runtime = currentRuntime(options).runtime;
    const threadStore = runtime.stores.threads;
    const messageStore = runtime.stores.messages;
    const { id } = request.params;
    const thread = threadStore.getById(id);
    if (!thread) {
      return reply.status(404).send({ error: `Thread not found: ${id}` });
    }
    return messageStore.getByThread(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/threads/:id/runs', async (request, reply) => {
    const runtime = currentRuntime(options).runtime;
    const threadStore = runtime.stores.threads;
    const runStore = runtime.stores.runs;
    const { id } = request.params;
    const thread = threadStore.getById(id);
    if (!thread) {
      return reply.status(404).send({ error: `Thread not found: ${id}` });
    }
    return runStore.getByThread(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id/tool-calls', async (request, reply) => {
    const runtime = currentRuntime(options).runtime;
    const runStore = runtime.stores.runs;
    const toolCallStore = runtime.stores.toolCalls;
    const { id } = request.params;
    const run = runStore.getById(id);
    if (!run) {
      return reply.status(404).send({ error: `Run not found: ${id}` });
    }
    return toolCallStore.getByRun(id);
  });
}
