import type { FastifyInstance } from 'fastify';
import { config } from '@one-agent/agent-core';
import {
  validateWorkspacePath,
  WorkspaceRuntimeRegistry,
} from '../runtime-provider.js';
import {
  pickNativeWorkspaceDirectory,
  type NativeWorkspacePicker,
} from '../workspace-picker.js';

export async function workspaceRoutes(
  fastify: FastifyInstance,
  options: {
    runtimes: WorkspaceRuntimeRegistry;
    workspacePicker?: NativeWorkspacePicker;
  },
): Promise<void> {
  fastify.get('/api/workspaces', async () => ({
    ...options.runtimes.state(),
    databaseMode:
      config.storage.databasePath === ':memory:'
        ? 'memory'
        : 'workspace-relative',
  }));

  fastify.post('/api/workspaces/pick', async (_request, reply) => {
    try {
      const picked = await (
        options.workspacePicker ?? pickNativeWorkspaceDirectory
      )();
      if (!picked) return reply.status(204).send();
      return { path: validateWorkspacePath(picked) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: message });
    }
  });

  fastify.post<{ Body: { path?: string } }>(
    '/api/workspaces/select',
    async (request, reply) => {
      if (!request.body?.path || typeof request.body.path !== 'string') {
        return reply.status(400).send({ error: 'path is required and must be a string' });
      }
      try {
        const selected = await options.runtimes.select(request.body.path);
        return {
          ...options.runtimes.state(),
          workspace: selected.workspaceRoot,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes('正在执行') ? 409 : 400;
        return reply.status(status).send({ error: message });
      }
    },
  );
}
