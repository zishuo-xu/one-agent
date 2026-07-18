import { FastifyInstance } from 'fastify';
import {
  AgentRuntime,
} from '@one-agent/agent-core';

export async function traceRoutes(
  fastify: FastifyInstance,
  options: { runtime: AgentRuntime },
): Promise<void> {
  const runStore = options.runtime.stores.runs;
  const threadStore = options.runtime.stores.threads;
  const taskStore = options.runtime.stores.tasks;
  const traceEventStore = options.runtime.stores.traces;

  fastify.get<{ Params: { id: string } }>('/api/runs/:id/traces', async (request, reply) => {
    const { id } = request.params;
    const run = runStore.getById(id);
    if (!run) {
      return reply.status(404).send({ error: `Run not found: ${id}` });
    }
    return traceEventStore.getByRun(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/tasks/:id/traces', async (request, reply) => {
    const { id } = request.params;
    const task = taskStore.get(id);
    if (!task) {
      return reply.status(404).send({ error: `Task not found: ${id}` });
    }
    return traceEventStore.getByTask(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/threads/:id/traces', async (request, reply) => {
    const { id } = request.params;
    const thread = threadStore.getById(id);
    if (!thread) {
      return reply.status(404).send({ error: `Thread not found: ${id}` });
    }
    return traceEventStore.getByThread(id);
  });
}
