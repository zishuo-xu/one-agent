import path from 'node:path';
import fs from 'node:fs';

export interface SandboxOptions {
  root: string;
}

export class Sandbox {
  constructor(private root: string) {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    this.root = fs.realpathSync(root);
  }

  resolve(relativePath: string): string {
    const normalized = path.normalize(relativePath).replace(/^\//, '').replace(/^\\/, '');
    if (normalized.includes('..')) {
      throw new Error(`Path traversal is not allowed: ${relativePath}`);
    }
    return path.join(this.root, normalized);
  }

  isTextFile(relativePath: string): boolean {
    const ext = path.extname(relativePath).toLowerCase();
    const allowed = new Set([
      '.txt', '.md', '.json', '.ts', '.js', '.mjs', '.cjs', '.jsx', '.tsx',
      '.yaml', '.yml', '.html', '.css', '.scss', '.sql', '.sh', '.py', '.go',
      '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
    ]);
    return allowed.has(ext);
  }

  get rootPath(): string {
    return this.root;
  }
}
