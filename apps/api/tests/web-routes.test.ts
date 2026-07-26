import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { webRoutes } from '../src/routes/web.js';

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web/src',
);

describe('Web interface routes', () => {
  it('serves the local Web interface at the root URL', async () => {
    const server = Fastify();
    await server.register(webRoutes, { webRoot });
    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.body).toContain('<title>One Agent Web</title>');
    expect(response.body).toContain('选择会话工作区');
    expect(response.body).toContain('工作区只在创建新会话时选择');
    expect(response.body).toContain('浏览…');
    expect(response.body).toContain('id="execution-panel"');
    expect(response.body).toContain('id="scroll-latest-button"');
    expect(response.body).toContain('id="dialogue-run-list"');
    expect(response.body).toContain('每条用户对话对应一行');
    expect(response.body).toContain('class="pending-scroll-region"');
    expect(response.body).toContain('id="pending-revise-button"');
    expect(response.body).toContain('id="message-list"');
    await server.close();
  });

  it.each([
    ['/styles.css', 'text/css'],
    ['/app.js', 'text/javascript'],
  ])('serves %s with the correct content type', async (url, type) => {
    const server = Fastify();
    await server.register(webRoutes, { webRoot });
    const response = await server.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(type);
    expect(response.body.length).toBeGreaterThan(100);
    await server.close();
  });

  it('keeps the application viewport fixed and scrolls long panes internally', async () => {
    const server = Fastify();
    await server.register(webRoutes, { webRoot });
    const response = await server.inject({ method: 'GET', url: '/styles.css' });

    expect(response.body).toContain('height: calc(100dvh - 16px)');
    expect(response.body).toContain('overflow-y: auto');
    expect(response.body).toContain('scrollbar-gutter: stable');
    expect(response.body).toContain('.execution-panel.is-open');
    expect(response.body).toContain('.message-list');
    await server.close();
  });

  it('returns an actionable error when Web assets are absent', async () => {
    const server = Fastify();
    await server.register(webRoutes, { webRoot: path.join(webRoot, 'missing') });
    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain('pnpm build:web');
    await server.close();
  });
});
