import { FastifyInstance } from 'fastify';
import { AgentRuntime } from '@one-agent/agent-core';

export interface CreateMemoryBody {
  key: string;
  value: string;
  source?: string;
  threadId?: string;
  scope?: 'global' | 'thread';
  sourceRunId?: string;
  confidence?: number;
  expiresAt?: string;
  kind?: 'user_profile' | 'user_preference' | 'project_rule' | 'durable_goal' | 'fact';
  explicit?: boolean;
  sourceMessageId?: string;
  observedAt?: string;
}

export interface UpdateMemoryBody {
  key?: string;
  value?: string;
  source?: string | null;
  threadId?: string | null;
  scope?: 'global' | 'thread';
  confidence?: number;
  status?: 'active' | 'superseded' | 'expired';
  expiresAt?: string | null;
  kind?: 'user_profile' | 'user_preference' | 'project_rule' | 'durable_goal' | 'fact';
  explicit?: boolean;
  sourceMessageId?: string | null;
  observedAt?: string;
}

export async function memoryRoutes(
  fastify: FastifyInstance,
  options: { runtime: AgentRuntime },
): Promise<void> {
  const memoryStore = options.runtime.stores.memories;

  fastify.post<{ Body: CreateMemoryBody }>('/api/memories', async (request, reply) => {
    const {
      key, value, source, threadId, scope, sourceRunId, confidence, expiresAt,
      kind, explicit, sourceMessageId, observedAt,
    } = request.body;

    if (!key || typeof key !== 'string' || !value || typeof value !== 'string') {
      return reply.status(400).send({ error: 'key and value are required strings' });
    }

    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      return reply.status(400).send({ error: 'confidence must be between 0 and 1' });
    }
    if (scope !== undefined && scope !== 'global' && scope !== 'thread') {
      return reply.status(400).send({ error: 'scope must be global or thread' });
    }
    if (scope === 'thread' && !threadId) {
      return reply.status(400).send({ error: 'thread-scoped memory requires threadId' });
    }

    try {
      const result = memoryStore.remember({
        key, value, source, threadId, scope, sourceRunId, confidence, expiresAt,
        kind, explicit, sourceMessageId, observedAt,
      });
      return reply.status(result.action === 'created' ? 201 : 200).send({
        ...result.memory,
        governanceAction: result.action,
        previousMemoryId: result.previousMemoryId,
      });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  fastify.get('/api/memories', async (request) => {
    const { query, status, scope, threadId } = request.query as {
      query?: string;
      status?: 'active' | 'superseded' | 'expired';
      scope?: 'global' | 'thread';
      threadId?: string;
    };
    if (query && typeof query === 'string') {
      return memoryStore.getRelevantMemories(query, { threadId });
    }
    return memoryStore.list({ status, scope, threadId });
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateMemoryBody }>(
    '/api/memories/:id',
    async (request, reply) => {
      const existing = memoryStore.getById(request.params.id);
      if (!existing) {
        return reply.status(404).send({ error: 'Memory not found' });
      }
      const updates = request.body ?? {};
      if (updates.confidence !== undefined &&
        (!Number.isFinite(updates.confidence) || updates.confidence < 0 || updates.confidence > 1)) {
        return reply.status(400).send({ error: 'confidence must be between 0 and 1' });
      }
      if (updates.scope !== undefined && updates.scope !== 'global' && updates.scope !== 'thread') {
        return reply.status(400).send({ error: 'scope must be global or thread' });
      }
      if (updates.status !== undefined &&
        !['active', 'superseded', 'expired'].includes(updates.status)) {
        return reply.status(400).send({ error: 'invalid memory status' });
      }
      try {
        return memoryStore.update(existing.id, updates);
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

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
