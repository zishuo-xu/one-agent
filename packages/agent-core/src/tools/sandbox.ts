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
    const basename = path.basename(normalized).toLowerCase();
    if (basename === 'one-agent.config.json' || basename === '.env' || basename.startsWith('.env.')) {
      throw new Error(`Protected configuration file is not accessible to Agent tools: ${relativePath}`);
    }
    return path.join(this.root, normalized);
  }

  isTextFile(relativePath: string): boolean {
    const ext = path.extname(relativePath).toLowerCase();
    const basename = path.basename(relativePath).toLowerCase();
    const allowed = new Set([
      '.txt', '.md', '.json', '.ts', '.js', '.mjs', '.cjs', '.jsx', '.tsx',
      '.yaml', '.yml', '.html', '.css', '.scss', '.sql', '.sh', '.py', '.go',
      '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
      '.csv', '.ini', '.log', '.conf', '.xml', '.toml',
    ]);

    // Extensionless files (for example Dockerfile and Makefile) and common
    // environment dotfiles are normally plain text. Rotated logs use a
    // numeric suffix, so path.extname alone would otherwise see only ".1".
    return ext === ''
      || allowed.has(ext)
      || /\.log\.\d+$/.test(basename);
  }

  get rootPath(): string {
    return this.root;
  }
}
