import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { resolveWorkspaceRoot } from './workspace.js';

export const WORKSPACE_ROOT = resolveWorkspaceRoot();

if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

dotenv.config({
  path: path.join(WORKSPACE_ROOT, '.env'),
});
