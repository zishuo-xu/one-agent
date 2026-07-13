import { FastifyInstance } from 'fastify';
import {
  getSharedConnection,
  RunStore,
  SqliteTaskStore,
  ThreadStore,
  TraceEventStore,
} from '@one-agent/agent-core';

export async function traceRoutes(fastify: FastifyInstance): Promise<void> {
  const db = getSharedConnection();
  const runStore = new RunStore(db);
  const threadStore = new ThreadStore(db);
  const taskStore = new SqliteTaskStore(db);
  const traceEventStore = new TraceEventStore(db);

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
