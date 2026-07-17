import { exec } from 'node:child_process';
import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Per-stream cap for output returned to the model. */
const MAX_OUTPUT_CHARS = 10_000;
/** exec buffer ceiling; output beyond this is a tool error, well above the display cap. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Minimal environment for child processes. The agent's own environment
 * carries API keys (OPENAI_API_KEY, SEARCH_API_KEY, …); forwarding it would
 * make `run_command: env` a credential exfiltration channel. Only innocuous
 * vars commands genuinely need are passed through — secrets are excluded by
 * construction.
 */
const CHILD_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'PWD', 'OLDPWD',
  'TMPDIR', 'TEMP', 'TMP',
  'NODE_ENV', 'CI',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
];

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/**
 * Dangerous-command guardrail plus workspace containment. This is still NOT
 * a hard security boundary — shell expansion ($(), backticks, variables)
 * can smuggle paths past static inspection — but simple path references
 * must stay inside the workspace, closing the demonstrated bypass vectors
 * (cat ../x, cat /etc/passwd, cat ~/x). The real trust model is "the agent
 * acts with the user's own permissions" — see docs/phase13-tool-ecosystem.md.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~|\$HOME)(\s|$)/, reason: 'recursive delete of root/home' },
  { pattern: /\bsudo\b/, reason: 'privilege escalation via sudo' },
  { pattern: /\b(mkfs|fdisk|parted)\b/, reason: 'disk formatting/partitioning' },
  { pattern: /\bdd\b[^|]*\bof=\/dev\//, reason: 'raw write to device' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'system power control' },
  { pattern: /\bkill\s+-9\s+-1\b/, reason: 'kill all processes' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, reason: 'pipe remote script into shell' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: 'fork bomb' },
];

function assertCommandSafe(command: string): void {
  const normalized = command.replace(/\s+/g, ' ').trim();
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`Command blocked for safety (${reason}): ${command}`);
    }
  }
}

/**
 * Workspace containment: reject commands whose path-like tokens escape the
 * workspace root — `..` traversal segments, `~` home references, and
 * absolute paths outside the root. Relative paths (including `./x`) and
 * absolute paths inside the workspace are allowed.
 */
const PATH_TOKEN_PATTERN = /(?:^|[\s|;&(='"`])((?:\/|~|\.\.?\/)[^\s|;&()'"]*)/g;
/** A `..` path segment anywhere in the command (covers ../x, dir/../x, bare cd ..). */
const DOTDOT_SEGMENT_PATTERN = /(?:^|[\s|;&(='"`/])\.\.(?:[\s|;&)'"`/]|$)/;

function assertCommandContained(command: string, rootPath: string): void {
  const blocked = (token: string): Error =>
    new Error(
      `Command blocked: path '${token}' escapes the workspace. ` +
        'Use workspace-relative paths or the file tools instead.'
    );

  if (DOTDOT_SEGMENT_PATTERN.test(command)) {
    throw blocked('..');
  }
  for (const match of command.matchAll(PATH_TOKEN_PATTERN)) {
    const token = match[1];
    if (token === '~' || token.startsWith('~/')) {
      throw blocked(token);
    }
    if (token.startsWith('/')) {
      const rootWithSep = rootPath.endsWith('/') ? rootPath : rootPath + '/';
      if (token !== rootPath && !token.startsWith(rootWithSep)) {
        throw blocked(token);
      }
    }
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`,
    truncated: true,
  };
}

interface ShellOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellOutcome> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, shell: '/bin/sh', env: buildChildEnv() },
      (error, stdout, stderr) => {
        if (error) {
          // Timeout kills the child; surface that as a tool failure.
          if (error.killed) {
            reject(new Error(`Command timed out after ${timeoutMs}ms`));
            return;
          }
          // A non-zero exit code is a normal result the model should see
          // (failing test suites, missing files, etc.), not a tool failure.
          if (typeof error.code === 'number') {
            resolve({ exitCode: error.code, stdout, stderr });
            return;
          }
          reject(error);
          return;
        }
        resolve({ exitCode: 0, stdout, stderr });
      },
    );
  });
}

export function createRunCommandTool(sandbox: Sandbox): ToolDefinition {
  return {
    name: 'run_command',
    description:
      'Run a shell command in the workspace directory and return its exit code and output. ' +
      'Use it for builds, tests, package installs, git operations, and general development tasks. ' +
      'Commands run with /bin/sh from the workspace root and time out after 30s by default. ' +
      'Dangerous commands (sudo, rm -rf /, disk formatting, piping remote scripts into a shell) are rejected. ' +
      'Path references must stay inside the workspace: use relative paths; "..", "~", and absolute paths outside the workspace are rejected. ' +
      'Output longer than 10000 characters per stream is truncated.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute, e.g. "ls -la" or "npm test".'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
    }),
    execute: async (args) => {
      const { command, timeoutMs } = args as { command: string; timeoutMs?: number };
      assertCommandSafe(command);
      assertCommandContained(command, sandbox.rootPath);
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const startedAt = Date.now();
      const outcome = await runShell(command, sandbox.rootPath, timeout);
      const stdout = truncate(outcome.stdout);
      const stderr = truncate(outcome.stderr);
      return {
        exitCode: outcome.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

export default createRunCommandTool;
