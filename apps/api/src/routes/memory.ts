import { FastifyInstance } from 'fastify';
import { AgentRuntime, type MemoryDocumentScope } from '@one-agent/agent-core';

export interface UpdateMemoryDocumentBody {
  content: string;
  expectedHash?: string;
}

function isScope(value: string): value is MemoryDocumentScope {
  return value === 'global' || value === 'workspace';
}

/** User-facing document API. Memory has no record-level CRUD surface. */
export async function memoryRoutes(
  fastify: FastifyInstance,
  options: { runtime: AgentRuntime },
): Promise<void> {
  const documents = options.runtime.memoryDocuments;

  fastify.get<{ Params: { scope: string } }>('/api/memory/:scope', async (request, reply) => {
    if (!isScope(request.params.scope)) {
      return reply.status(400).send({ error: 'scope must be global or workspace' });
    }
    return documents.read(request.params.scope);
  });

  fastify.put<{ Params: { scope: string }; Body: UpdateMemoryDocumentBody }>(
    '/api/memory/:scope',
    async (request, reply) => {
      const scope = request.params.scope;
      if (!isScope(scope)) {
        return reply.status(400).send({ error: 'scope must be global or workspace' });
      }
      const content = request.body?.content;
      if (typeof content !== 'string' || !content.trim()) {
        return reply.status(400).send({ error: 'content must be a non-empty Markdown string' });
      }
      const current = documents.read(scope);
      if (request.body.expectedHash && request.body.expectedHash !== current.hash) {
        return reply.status(409).send({
          error: 'Memory document changed; reload before saving',
          document: current,
        });
      }
      try {
        return await documents.write(scope, content, request.body.expectedHash);
      } catch (error) {
        return reply.status(409).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
