import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSharedConnection } from '@one-agent/agent-core';
import { buildServer } from '../src/server.js';

vi.mock('../../../packages/agent-core/dist/config.js', () => ({
  config: {
    port: 3000,
    host: '127.0.0.1',
    model: 'gpt-test',
    systemPrompt: 'You are a test assistant.',
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
    process.env.DATABASE_PATH = ':memory:';
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
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' });
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
