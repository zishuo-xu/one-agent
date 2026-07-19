import fs from 'node:fs';
import os from 'node:os';
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

  if (
    fs.existsSync(path.join(cwd, 'one-agent.config.json')) ||
    fs.existsSync(path.join(cwd, 'one-agent.config.example.json'))
  ) {
    return cwd;
  }

  if (options?.repoConfig && fs.existsSync(options.repoConfig)) {
    return path.dirname(options.repoConfig);
  }

  return path.join(os.homedir(), '.one-agent');
}
