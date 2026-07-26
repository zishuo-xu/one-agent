import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSharedConnection } from '@one-agent/agent-core';
import { buildServer } from '../src/server.js';

vi.mock('../../../packages/agent-core/dist/config.js', () => ({
  config: {
    workspaceRoot: process.cwd(),
    api: { port: 3000, host: '127.0.0.1', logLevel: 'silent' },
    model: { model: 'gpt-test', timeoutMs: 30000, apiKey: 'test-key' },
    runtime: { systemPrompt: 'You are a test assistant.', maxRetries: 2, maxToolIterations: 5, maxReplanAttempts: 3, maxRetryAttempts: 2 },
    context: { maxTokens: 4096, recentTokenBudget: 2048 },
    budget: { mainAgentTokens: null, subAgentTokens: null },
    subAgent: { enabled: true, maxDepth: 1, maxConcurrency: 4, taskTimeoutMs: 60000, maxToolIterations: 5 },
    tools: { disabled: [], search: {} },
    trace: { contentMode: 'redacted' },
    taskQueue: { maxConcurrency: 2, taskTimeoutMs: 300000, maxRetries: 3, retryDelayMs: 1000 },
    databasePath: ':memory:',
    openai: {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    },
  },
}));

import { config } from '../../../packages/agent-core/dist/config.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

describe('chat routes', () => {
  beforeEach(() => {
    resetSharedConnection();
    mockCreate.mockReset();
  });

  afterEach(() => {
    resetSharedConnection();
  });

  it('GET /api/health returns ok', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'ok',
      model: 'gpt-test',
      workspace: process.cwd(),
    });
  });

  it('POST /api/chat rejects missing message', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toHaveProperty('error');
  });

  it('POST /api/chat creates a new thread and returns threadId', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello' } }],
    } as never);

    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Hi' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.reply).toBe('Hello');
    expect(body.threadId).toBeDefined();

    const threadsResponse = await server.inject({ method: 'GET', url: '/api/threads' });
    const thread = JSON.parse(threadsResponse.body).find((item: { id: string }) => item.id === body.threadId);
    expect(thread.memoryExtracted).toBe(false);
  });

  it('POST /api/chat continues an existing thread', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello' } }],
    } as never);

    const server = await buildServer();
    const first = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Hi' },
    });
    const { threadId } = JSON.parse(first.body);

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'I remember you.' } }],
    } as never);

    const second = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Do you remember me?', threadId },
    });

    expect(second.statusCode).toBe(200);
    const body = JSON.parse(second.body);
    expect(body.reply).toBe('I remember you.');
    expect(body.threadId).toBe(threadId);
  });

  it('POST /api/web/chat returns a running Run before the model finishes', async () => {
    let resolveModel: ((value: unknown) => void) | undefined;
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveModel = resolve;
        }) as never,
    );

    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/web/chat',
      payload: { message: 'Inspect asynchronously' },
    });

    expect(response.statusCode).toBe(202);
    const started = JSON.parse(response.body);
    expect(started).toMatchObject({
      status: 'running',
      threadId: expect.any(String),
      runId: expect.any(String),
    });

    const runningResponse = await server.inject({
      method: 'GET',
      url: `/api/runs/${started.runId}`,
    });
    expect(JSON.parse(runningResponse.body).status).toBe('running');

    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalled());
    resolveModel?.({
      choices: [{ message: { content: 'Finished asynchronously.' } }],
    });
    await vi.waitFor(async () => {
      const completedResponse = await server.inject({
        method: 'GET',
        url: `/api/runs/${started.runId}`,
      });
      expect(JSON.parse(completedResponse.body).status).toBe('completed');
    });
  });

  it('persists a clarification and accepts the answer through the run endpoint', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: {
        content: '',
        tool_calls: [{
          id: 'ask-target',
          type: 'function',
          function: {
            name: 'request_user_input',
            arguments: JSON.stringify({ question: 'Which target?' }),
          },
        }],
      } }],
    } as never);

    const server = await buildServer();
    const first = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Deploy it' },
    });
    const waiting = JSON.parse(first.body);
    expect(waiting).toMatchObject({
      status: 'waiting_for_input',
      reply: 'Which target?',
      inputRequest: { question: 'Which target?' },
    });

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Using staging.' } }],
    } as never);
    const continued = await server.inject({
      method: 'POST',
      url: `/api/runs/${waiting.runId}/input`,
      payload: { answer: 'staging' },
    });

    expect(continued.statusCode).toBe(200);
    expect(JSON.parse(continued.body)).toMatchObject({
      status: 'completed',
      reply: 'Using staging.',
      threadId: waiting.threadId,
    });
  });

  it('POST /api/web/runs/:id/input starts a continuation without waiting for it', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: {
        content: '',
        tool_calls: [{
          id: 'ask-target-async',
          type: 'function',
          function: {
            name: 'request_user_input',
            arguments: JSON.stringify({ question: 'Which async target?' }),
          },
        }],
      } }],
    } as never);

    const server = await buildServer();
    const first = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Deploy asynchronously' },
    });
    const waiting = JSON.parse(first.body);

    let resolveContinuation: ((value: unknown) => void) | undefined;
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveContinuation = resolve;
        }) as never,
    );
    const continued = await server.inject({
      method: 'POST',
      url: `/api/web/runs/${waiting.runId}/input`,
      payload: { answer: 'staging' },
    });

    expect(continued.statusCode).toBe(202);
    const started = JSON.parse(continued.body);
    expect(started).toMatchObject({
      status: 'running',
      threadId: waiting.threadId,
      runId: expect.any(String),
    });
    expect(started.runId).not.toBe(waiting.runId);

    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    resolveContinuation?.({
      choices: [{ message: { content: 'Async staging completed.' } }],
    });
    await vi.waitFor(async () => {
      const completedResponse = await server.inject({
        method: 'GET',
        url: `/api/runs/${started.runId}`,
      });
      expect(JSON.parse(completedResponse.body).status).toBe('completed');
    });
  });

  it('requires runtime approval for a dangerous tool and supports rejection', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: {
        content: '',
        tool_calls: [{
          id: 'delete-api',
          type: 'function',
          function: {
            name: 'delete_file',
            arguments: JSON.stringify({ path: 'must-not-be-deleted.txt' }),
          },
        }],
      } }],
    } as never);
    const server = await buildServer();
    const first = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Delete must-not-be-deleted.txt' },
    });
    const waiting = JSON.parse(first.body);

    expect(waiting).toMatchObject({
      status: 'waiting_for_input',
      inputRequest: {
        kind: 'tool_approval',
        approval: { toolCall: { name: 'delete_file' } },
      },
    });

    const rejected = await server.inject({
      method: 'POST',
      url: `/api/runs/${waiting.runId}/input`,
      payload: { answer: 'reject' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(rejected.body)).toMatchObject({
      status: 'completed',
      reply: 'Cancelled delete_file; the tool was not executed.',
    });
  });

  it('GET /api/threads lists threads', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello' } }],
    } as never);

    const server = await buildServer();
    await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'List me' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/threads',
    });

    expect(response.statusCode).toBe(200);
    const threads = JSON.parse(response.body);
    expect(threads.length).toBeGreaterThan(0);
  });

  it('GET /api/threads/:id/messages returns messages', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello' } }],
    } as never);

    const server = await buildServer();
    const chat = await server.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'Hi' },
    });
    const { threadId } = JSON.parse(chat.body);

    const response = await server.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/messages`,
    });

    expect(response.statusCode).toBe(200);
    const messages = JSON.parse(response.body);
    expect(messages.length).toBeGreaterThan(0);
  });
});
