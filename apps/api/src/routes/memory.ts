import { FastifyInstance } from 'fastify';
import { MemoryStore, getSharedConnection } from '@one-agent/agent-core';

export interface CreateMemoryBody {
  key: string;
  value: string;
  source?: string;
  threadId?: string;
}

export async function memoryRoutes(fastify: FastifyInstance): Promise<void> {
  const db = getSharedConnection();
  const memoryStore = new MemoryStore(db);

  fastify.post<{ Body: CreateMemoryBody }>('/api/memories', async (request, reply) => {
    const { key, value, source, threadId } = request.body;

    if (!key || typeof key !== 'string' || !value || typeof value !== 'string') {
      return reply.status(400).send({ error: 'key and value are required strings' });
    }

    const memory = memoryStore.create({ key, value, source, threadId });
    return reply.status(201).send(memory);
  });

  fastify.get('/api/memories', async (request) => {
    const query = (request.query as { query?: string }).query;
    if (query && typeof query === 'string') {
      return memoryStore.getRelevantMemories(query);
    }
    return memoryStore.list();
  });

  fastify.get<{ Params: { id: string } }>('/api/memories/:id', async (request, reply) => {
    const memory = memoryStore.getById(request.params.id);
    if (!memory) {
      return reply.status(404).send({ error: 'Memory not found' });
    }
    return memory;
  });

  fastify.delete<{ Params: { id: string } }>('/api/memories/:id', async (request, reply) => {
    memoryStore.deleteById(request.params.id);
    return reply.status(204).send();
  });
}
