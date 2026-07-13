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
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  repoEnv?: string;
}): string {
  const argv = options?.argv ?? process.argv.slice(2);
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();

  const fromArg = parseWorkspaceArg(argv);
  if (fromArg) return fromArg;

  if (env.ONE_AGENT_WORKSPACE) {
    return path.resolve(env.ONE_AGENT_WORKSPACE);
  }

  if (fs.existsSync(path.join(cwd, '.env'))) {
    return cwd;
  }

  if (options?.repoEnv && fs.existsSync(options.repoEnv)) {
    return path.dirname(options.repoEnv);
  }

  return path.join(os.homedir(), '.one-agent');
}
