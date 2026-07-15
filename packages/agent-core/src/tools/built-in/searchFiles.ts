import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_LIMIT = 200;
/** Directories never worth scanning for agent-authored files. */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist']);

interface SearchMatch {
  path: string;
  lines?: number[];
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(source, 'i');
}

function walkFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        results.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return results;
}

export function createSearchFilesTool(sandbox: Sandbox): ToolDefinition {
  return {
    name: 'search_files',
    description:
      'Search files in the workspace by filename pattern and/or content substring. ' +
      'The pattern supports * and ? wildcards and matches against workspace-relative paths. ' +
      'When contentPattern is given, only text files are scanned and matching line numbers are returned. ' +
      'Skips node_modules, .git and dist.',
    parameters: z.object({
      pattern: z.string().describe('Wildcard pattern matched against relative file paths, e.g. "*.md" or "src/*test*".'),
      contentPattern: z
        .string()
        .optional()
        .describe('Optional substring matched against file content (text files only).'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS_LIMIT)
        .optional()
        .describe(`Maximum number of matches to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_LIMIT}).`),
    }),
    execute: async (args) => {
      const { pattern, contentPattern, maxResults } = args as {
        pattern: string;
        contentPattern?: string;
        maxResults?: number;
      };
      const limit = maxResults ?? DEFAULT_MAX_RESULTS;
      const pathRegex = wildcardToRegExp(pattern);

      const matches: SearchMatch[] = [];
      for (const absolutePath of walkFiles(sandbox.rootPath)) {
        if (matches.length >= limit) break;
        const relativePath = path.relative(sandbox.rootPath, absolutePath);
        if (!pathRegex.test(relativePath)) continue;

        if (contentPattern === undefined) {
          matches.push({ path: relativePath });
          continue;
        }

        if (!sandbox.isTextFile(relativePath)) continue;
        const content = fs.readFileSync(absolutePath, 'utf-8');
        const lines: number[] = [];
        const rows = content.split('\n');
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].includes(contentPattern)) {
            lines.push(i + 1);
          }
        }
        if (lines.length > 0) {
          matches.push({ path: relativePath, lines });
        }
      }

      return { matches, count: matches.length, limit };
    },
  };
}

export default createSearchFilesTool;
