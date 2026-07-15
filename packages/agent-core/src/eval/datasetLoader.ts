import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EvalTask } from './types.js';

const mockResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.literal('function'),
              function: z.object({ name: z.string(), arguments: z.string() }),
            }),
          )
          .optional(),
      }),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});

const evalTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  prompt: z.string().min(1),
  initialWorkspace: z.record(z.string()).optional(),
  expectedTools: z
    .array(z.object({ name: z.string(), arguments: z.record(z.unknown()).optional() }))
    .optional(),
  requiredTools: z
    .array(z.object({ name: z.string(), arguments: z.record(z.unknown()).optional() }))
    .optional(),
  forbiddenTools: z.array(z.string()).optional(),
  expectedOutcome: z.enum(['success', 'failure']).optional(),
  finalAnswerContains: z.array(z.string()).optional(),
  expectedFiles: z
    .array(z.object({ path: z.string(), contains: z.string().optional() }))
    .optional(),
  mockResponses: z.array(mockResponseSchema).optional(),
  enablePlanning: z.boolean().optional(),
  timeoutMs: z.number().optional(),
});

/**
 * Load every `*.json` eval task from a directory (recursively, so datasets
 * can be organized into subdirectories like mock/ and real/). Files are
 * validated against the EvalTask schema; errors name the offending file.
 */
export function loadEvalDataset(dir: string): EvalTask[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Eval dataset directory not found: ${dir}`);
  }

  const jsonFiles: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        jsonFiles.push(full);
      }
    }
  };
  walk(dir);
  jsonFiles.sort();

  const tasks: EvalTask[] = [];
  for (const file of jsonFiles) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (error) {
      throw new Error(
        `Invalid JSON in eval dataset file ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = evalTaskSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid eval task in ${file}: ${parsed.error.message}`);
    }
    tasks.push(parsed.data as EvalTask);
  }

  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate eval task id "${task.id}" in dataset directory ${dir}`);
    }
    ids.add(task.id);
  }

  return tasks;
}

/**
 * Locate the bundled `eval-datasets/` directory shipped with the agent-core
 * package. Walks up from this module so both src (tsx/vitest) and dist
 * (compiled) layouts resolve correctly.
 */
export function resolveBundledDatasetDir(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(current, 'eval-datasets');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  throw new Error(
    'Could not locate the bundled eval-datasets directory (walked up from ' +
      fileURLToPath(import.meta.url) +
      ')',
  );
}
