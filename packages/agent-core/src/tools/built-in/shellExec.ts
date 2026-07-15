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
 * Dangerous-command guardrail. This is a basic demonstration-level filter,
 * NOT a security boundary: a determined model can always construct commands
 * that evade pattern matching. The real trust model is "the agent acts with
 * the user's own permissions" — see docs/phase13-tool-ecosystem.md.
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
      { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, shell: '/bin/sh' },
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
