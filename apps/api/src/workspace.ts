import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const WORKSPACE_ROOT = path.join(REPOSITORY_ROOT, 'workspace');
