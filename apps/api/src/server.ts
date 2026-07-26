import Fastify from 'fastify';
import { chatRoutes } from './routes/chat.js';
import { taskRoutes } from './routes/tasks.js';
import { memoryRoutes } from './routes/memory.js';
import { traceRoutes } from './routes/traces.js';
import { webRoutes } from './routes/web.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { settingsRoutes } from './routes/settings.js';
import { AgentRuntime } from '@one-agent/agent-core';
import { config } from '@one-agent/agent-core';
import {
  FixedRuntimeProvider,
  WorkspaceRuntimeRegistry,
} from './runtime-provider.js';
import type { NativeWorkspacePicker } from './workspace-picker.js';

export interface BuildServerOptions {
  workspaceRoot?: string;
  webRoot?: string;
  workspaceMode?: 'fixed' | 'selectable';
  workspaceStatePath?: string;
  workspacePicker?: NativeWorkspacePicker;
  configPath?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const fastify = Fastify({
    logger: {
      level: config.api.logLevel,
    },
  });

  const workspaceRoot = options.workspaceRoot ?? config.workspaceRoot ?? process.cwd();
  const selectable = options.workspaceMode === 'selectable';
  const runtimes = selectable
    ? await WorkspaceRuntimeRegistry.create({
        initialWorkspaceRoot: options.workspaceRoot,
        statePath: options.workspaceStatePath,
      })
    : new FixedRuntimeProvider({
        workspaceRoot,
        runtime: new AgentRuntime({ workspaceRoot }),
      });

  await fastify.register(webRoutes, { webRoot: options.webRoot });
  await fastify.register(chatRoutes, { runtimes });
  await fastify.register(taskRoutes, { runtimes });
  await fastify.register(memoryRoutes, { runtimes });
  await fastify.register(traceRoutes, { runtimes });
  if (runtimes instanceof WorkspaceRuntimeRegistry) {
    await fastify.register(workspaceRoutes, {
      runtimes,
      workspacePicker: options.workspacePicker,
    });
    await fastify.register(settingsRoutes, {
      runtimes,
      configPath: options.configPath ?? config.configPath,
    });
    fastify.addHook('onClose', async () => runtimes.close());
  }

  return fastify;
}
