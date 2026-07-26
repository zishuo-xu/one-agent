import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const ASSETS = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
} as const;

export interface WebRoutesOptions {
  webRoot?: string;
}

function resolveDefaultWebRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../web'),
    path.resolve(currentDir, '../../../web/dist'),
    path.resolve(currentDir, '../../../web/src'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html')))
    ?? candidates[0];
}

export async function webRoutes(
  fastify: FastifyInstance,
  options: WebRoutesOptions,
): Promise<void> {
  const webRoot = path.resolve(options.webRoot ?? resolveDefaultWebRoot());

  for (const [url, asset] of Object.entries(ASSETS)) {
    fastify.get(url, async (_request, reply) => {
      const assetPath = path.join(webRoot, asset.file);
      if (!fs.existsSync(assetPath)) {
        return reply.status(503).type('text/plain').send(
          'One Agent Web assets are missing. Run pnpm build:web and restart the server.',
        );
      }
      reply
        .header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        )
        .header('Cache-Control', 'no-store')
        .type(asset.type);
      return fs.readFileSync(assetPath);
    });
  }
}
