import { FastifyInstance } from 'fastify';
import {
  currentRuntime,
  type RuntimeRouteOptions,
} from '../runtime-provider.js';

export async function traceRoutes(
  fastify: FastifyInstance,
  options: RuntimeRouteOptions,
): Promise<void> {
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/traces', async (request, reply) => {
    const stores = currentRuntime(options).runtime.stores;
    const { id } = request.params;
    const run = stores.runs.getById(id);
    if (!run) {
      return reply.status(404).send({ error: `Run not found: ${id}` });
    }
    return stores.traces.getByRun(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/tasks/:id/traces', async (request, reply) => {
    const stores = currentRuntime(options).runtime.stores;
    const { id } = request.params;
    const task = stores.tasks.get(id);
    if (!task) {
      return reply.status(404).send({ error: `Task not found: ${id}` });
    }
    return stores.traces.getByTask(id);
  });

  fastify.get<{ Params: { id: string } }>('/api/threads/:id/traces', async (request, reply) => {
    const stores = currentRuntime(options).runtime.stores;
    const { id } = request.params;
    const thread = stores.threads.getById(id);
    if (!thread) {
      return reply.status(404).send({ error: `Thread not found: ${id}` });
    }
    return stores.traces.getByThread(id);
  });
}
