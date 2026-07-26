import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { CONFIG_FILE_NAME } from '@one-agent/agent-core';

export function parseWorkspaceArg(argv: string[]): string | undefined {
  const index = argv.indexOf('--workspace');
  if (index >= 0 && argv[index + 1]) {
    return path.resolve(argv[index + 1]);
  }
  return undefined;
}

export function isWebCommand(argv: string[] = process.argv.slice(2)): boolean {
  const valueFlags = new Set(['--thread', '--workspace', '--loop']);
  const positional = argv.find(
    (arg, index) => !arg.startsWith('-') && !valueFlags.has(argv[index - 1] ?? ''),
  );
  return positional === 'web';
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

export function getGlobalConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.one-agent', CONFIG_FILE_NAME);
}

/**
 * A workspace-local configuration is an explicit per-project override.
 * Otherwise every workspace shares the user's global configuration.
 */
export function resolveConfigPath(options: {
  workspaceRoot: string;
  homeDir?: string;
}): string {
  const workspaceConfigPath = path.join(options.workspaceRoot, CONFIG_FILE_NAME);
  if (fs.existsSync(workspaceConfigPath)) {
    return workspaceConfigPath;
  }
  return getGlobalConfigPath(options.homeDir);
}

export function resolveStartupConfigPath(options: {
  argv?: string[];
  workspaceRoot: string;
  homeDir?: string;
}): string {
  const argv = options.argv ?? process.argv.slice(2);
  return isWebCommand(argv)
    ? getGlobalConfigPath(options.homeDir)
    : resolveConfigPath({
        workspaceRoot: options.workspaceRoot,
        homeDir: options.homeDir,
      });
}

/**
 * `--init` creates the global configuration by default. Passing
 * `--workspace <path>` explicitly opts into a workspace-local configuration.
 */
export function resolveInitConfigPath(options: {
  argv?: string[];
  workspaceRoot: string;
  homeDir?: string;
}): string {
  const argv = options.argv ?? process.argv.slice(2);
  return parseWorkspaceArg(argv)
    ? path.join(options.workspaceRoot, CONFIG_FILE_NAME)
    : getGlobalConfigPath(options.homeDir);
}
