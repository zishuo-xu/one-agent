import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('chat routes', () => {
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
});
