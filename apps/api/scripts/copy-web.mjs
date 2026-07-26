import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(apiRoot, '../web/dist');
const destination = path.join(apiRoot, 'dist/web');

if (!fs.existsSync(source)) {
  throw new Error(`Web build not found at ${source}. Run pnpm build:web first.`);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });
