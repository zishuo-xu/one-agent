import { FastifyInstance } from 'fastify';
import {
  AgentRuntime,
  TaskQueue,
  QueueWorker,
} from '@one-agent/agent-core';
import type { TaskStatus } from '@one-agent/agent-core';
import { config } from '@one-agent/agent-core';
import {
  beginRuntimeOperation,
  currentRuntime,
  type RuntimeRouteOptions,
} from '../runtime-provider.js';

export interface CreateTaskBody {
  message: string;
  threadId?: string;
  idempotencyKey?: string;
}

export async function taskRoutes(
  fastify: FastifyInstance,
  options: RuntimeRouteOptions,
): Promise<void> {
  const managers = new Map<AgentRuntime, { queue: TaskQueue; worker: QueueWorker }>();

  function getManager(): { queue: TaskQueue; worker: QueueWorker } {
    const runtime = currentRuntime(options).runtime;
    const existing = managers.get(runtime);
    if (existing) return existing;
    const taskStore = runtime.stores.tasks;
    const queue = new TaskQueue({
      store: taskStore,
      maxConcurrency: config.taskQueue.maxConcurrency,
      taskTimeoutMs: config.taskQueue.taskTimeoutMs,
      maxRetries: config.taskQueue.maxRetries,
      retryDelayMs: config.taskQueue.retryDelayMs,
    });
    const taskOperations = new Map<string, () => void>();
    const trackTask = (task: { id: string }) => {
      if (!taskOperations.has(task.id)) {
        taskOperations.set(task.id, beginRuntimeOperation(runtime));
      }
    };
    const releaseTask = (task: { id: string }) => {
      taskOperations.get(task.id)?.();
      taskOperations.delete(task.id);
    };
    queue.on('enqueued', trackTask);
    queue.on('started', trackTask);
    queue.on('completed', releaseTask);
    queue.on('failed', releaseTask);
    queue.on('cancelled', releaseTask);
    queue.on('dead_letter', releaseTask);
    function createAgent(agentOptions: {
      threadId?: string;
      taskId?: string;
      signal?: AbortSignal;
    }) {
      return runtime.createAgent({
        threadId: agentOptions.threadId,
        taskId: agentOptions.taskId,
        signal: agentOptions.signal,
        userInput: false,
      });
    }

    // Rehydrate any tasks that survived an API restart.
    const survivingTasks = taskStore.listByStatus(['pending', 'running']);
    for (const task of survivingTasks) {
      trackTask(task);
      if (task.status === 'running') {
        taskStore.setStatus(task.id, 'pending');
      }
      queue.restore(taskStore.get(task.id)!);
    }

    const worker = new QueueWorker({ queue, createAgent });
    worker.start();
    const manager = { queue, worker };
    managers.set(runtime, manager);
    return manager;
  }

  fastify.addHook('onClose', async () => {
    for (const manager of managers.values()) manager.worker.stop();
  });

  fastify.post<{ Body: CreateTaskBody }>('/api/tasks', async (request, reply) => {
    const taskQueue = getManager().queue;
    const { message, threadId, idempotencyKey } = request.body;

    if (!message || typeof message !== 'string') {
      return reply.status(400).send({ error: 'message is required and must be a string' });
    }

    try {
      const task = taskQueue.enqueue({ message, threadId, idempotencyKey });
      return { taskId: task.id, status: task.status };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Failed to create task' });
    }
  });

  fastify.get('/api/tasks', async (request) => {
    const taskQueue = getManager().queue;
    const status = (request.query as { status?: string }).status;
    if (status && typeof status === 'string') {
      return taskQueue.listByStatus([status as TaskStatus]);
    }
    return taskQueue.list();
  });

  fastify.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const taskQueue = getManager().queue;
    const { id } = request.params;
    const task = taskQueue.get(id);
    if (!task) {
      return reply.status(404).send({ error: `Task not found: ${id}` });
    }
    return task;
  });

  fastify.get<{ Params: { id: string } }>('/api/tasks/:id/events', async (request, reply) => {
    const taskQueue = getManager().queue;
    const { id } = request.params;
    const task = taskQueue.get(id);
    if (!task) {
      return reply.status(404).send({ error: `Task not found: ${id}` });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const sse = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send current events first
    for (const event of task.events) {
      sse({ type: 'agent', event });
    }

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'dead_letter') {
      sse({ type: 'task', status: task.status, reply: task.reply, error: task.error });
      reply.raw.end();
      return;
    }

    const { promise, resolve } = (() => {
      let resolver: () => void = () => {};
      const p = new Promise<void>((resolve) => {
        resolver = resolve;
      });
      return { promise: p, resolve: resolver };
    })();

    const onEvent = (data: { taskId: string; event: unknown }) => {
      if (data.taskId !== id) return;
      sse({ type: 'agent', event: data.event });
    };

    const onCompleted = (completedTask: typeof task) => {
      if (completedTask.id !== id) return;
      sse({ type: 'task', status: completedTask.status, reply: completedTask.reply });
      cleanup();
      resolve();
    };

    const onFailed = (failedTask: typeof task, error: string) => {
      if (failedTask.id !== id) return;
      sse({ type: 'task', status: failedTask.status, error: error });
      cleanup();
      resolve();
    };

    const onCancelled = (cancelledTask: typeof task) => {
      if (cancelledTask.id !== id) return;
      sse({ type: 'task', status: cancelledTask.status });
      cleanup();
      resolve();
    };

    const onDeadLetter = (deadTask: typeof task, error: string) => {
      if (deadTask.id !== id) return;
      sse({ type: 'task', status: deadTask.status, error });
      cleanup();
      resolve();
    };

    const cleanup = () => {
      taskQueue.off('event', onEvent as never);
      taskQueue.off('completed', onCompleted as never);
      taskQueue.off('failed', onFailed as never);
      taskQueue.off('cancelled', onCancelled as never);
      taskQueue.off('dead_letter', onDeadLetter as never);
      request.raw.off('close', cleanup);
      clearInterval(heartbeat);
      reply.raw.end();
      resolve();
    };

    taskQueue.on('event', onEvent as never);
    taskQueue.on('completed', onCompleted as never);
    taskQueue.on('failed', onFailed as never);
    taskQueue.on('cancelled', onCancelled as never);
    taskQueue.on('dead_letter', onDeadLetter as never);
    request.raw.on('close', cleanup);

    // Keep idle connections alive and let the server notice dead peers:
    // SSE comment heartbeat (intermediaries often drop silent streams).
    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 25_000);

    // Defense in depth: re-check terminal state after listener registration.
    // Today the handler is synchronous between snapshot and registration, but
    // if a future edit introduces an await in that gap, a terminal event
    // could fire before the listeners exist — without this re-check the
    // client would hang forever with no terminal frame.
    const latest = taskQueue.get(id);
    if (
      latest &&
      (latest.status === 'completed' ||
        latest.status === 'failed' ||
        latest.status === 'cancelled' ||
        latest.status === 'dead_letter')
    ) {
      for (const event of latest.events.slice(task.events.length)) {
        sse({ type: 'agent', event });
      }
      sse({ type: 'task', status: latest.status, reply: latest.reply, error: latest.error });
      cleanup();
      return;
    }

    await promise;
  });

  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request, reply) => {
    const taskQueue = getManager().queue;
    const { id } = request.params;
    const cancelled = taskQueue.cancel(id);
    if (!cancelled) {
      return reply.status(400).send({ error: `Task cannot be cancelled or not found: ${id}` });
    }
    return { taskId: id, status: 'cancelled' };
  });

  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/retry', async (request, reply) => {
    const taskQueue = getManager().queue;
    const { id } = request.params;
    const retried = taskQueue.retry(id);
    if (!retried) {
      return reply.status(400).send({ error: `Task cannot be retried or not found: ${id}` });
    }
    return { taskId: id, status: 'pending' };
  });
}
