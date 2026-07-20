import fs from 'node:fs';
import path from 'node:path';

export function parseWorkspaceArg(argv: string[]): string | undefined {
  const index = argv.indexOf('--workspace');
  if (index >= 0 && argv[index + 1]) {
    return path.resolve(argv[index + 1]);
  }
  return undefined;
}

export function resolveWorkspaceRoot(options?: {
  argv?: string[];
  cwd?: string;
  repoConfig?: string;
}): string {
  const argv = options?.argv ?? process.argv.slice(2);
  const cwd = options?.cwd ?? process.cwd();

  const fromArg = parseWorkspaceArg(argv);
  if (fromArg) return fromArg;

  let candidate = path.resolve(cwd);
  while (true) {
    if (
      fs.existsSync(path.join(candidate, 'one-agent.config.json')) ||
      fs.existsSync(path.join(candidate, '.one-agent', 'MEMORY.md'))
    ) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  if (options?.repoConfig && fs.existsSync(options.repoConfig)) {
    return path.dirname(options.repoConfig);
  }

  return path.resolve(cwd);
}
