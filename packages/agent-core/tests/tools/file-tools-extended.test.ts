import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../../src/tools/sandbox.js';
import { createAppendFileTool } from '../../src/tools/built-in/appendFile.js';
import { createDeleteFileTool } from '../../src/tools/built-in/deleteFile.js';
import { createSearchFilesTool } from '../../src/tools/built-in/searchFiles.js';

describe('extended file tools', () => {
  let workspaceRoot: string;
  let sandbox: Sandbox;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'one-agent-filext-'));
    sandbox = new Sandbox(workspaceRoot);
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  describe('append_file', () => {
    it('creates the file when it does not exist', async () => {
      const tool = createAppendFileTool(sandbox);
      await tool.execute({ path: 'notes/todo.md', content: 'first line\n' });
      expect(readFileSync(join(workspaceRoot, 'notes/todo.md'), 'utf-8')).toBe('first line\n');
    });

    it('appends to an existing file', async () => {
      writeFileSync(join(workspaceRoot, 'log.txt'), 'line1\n');
      const tool = createAppendFileTool(sandbox);
      const result = (await tool.execute({ path: 'log.txt', content: 'line2\n' })) as {
        bytes: number;
      };
      expect(readFileSync(join(workspaceRoot, 'log.txt'), 'utf-8')).toBe('line1\nline2\n');
      expect(result.bytes).toBe(Buffer.byteLength('line2\n', 'utf-8'));
    });

    it('rejects non-text file extensions', async () => {
      const tool = createAppendFileTool(sandbox);
      await expect(tool.execute({ path: 'data.bin', content: 'x' })).rejects.toThrow(
        /Only text files/,
      );
    });
  });

  describe('delete_file', () => {
    it('deletes an existing file', async () => {
      writeFileSync(join(workspaceRoot, 'scratch.txt'), 'bye');
      const tool = createDeleteFileTool(sandbox);
      const result = (await tool.execute({ path: 'scratch.txt' })) as { deleted: boolean };
      expect(result.deleted).toBe(true);
      expect(existsSync(join(workspaceRoot, 'scratch.txt'))).toBe(false);
    });

    it('errors when the file does not exist', async () => {
      const tool = createDeleteFileTool(sandbox);
      await expect(tool.execute({ path: 'missing.txt' })).rejects.toThrow(/not found/i);
    });

    it('refuses to delete directories', async () => {
      mkdirSync(join(workspaceRoot, 'subdir'));
      const tool = createDeleteFileTool(sandbox);
      await expect(tool.execute({ path: 'subdir' })).rejects.toThrow(/Not a file/);
    });

    it('rejects path traversal', async () => {
      const tool = createDeleteFileTool(sandbox);
      await expect(tool.execute({ path: '../outside.txt' })).rejects.toThrow(/traversal/i);
    });
  });

  describe('search_files', () => {
    beforeEach(() => {
      writeFileSync(join(workspaceRoot, 'readme.md'), 'hello world\nsecond line\n');
      mkdirSync(join(workspaceRoot, 'src'));
      writeFileSync(join(workspaceRoot, 'src/app.ts'), 'const hello = 1;\n');
      writeFileSync(join(workspaceRoot, 'src/util.ts'), 'export const x = 2;\n');
      mkdirSync(join(workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'node_modules', 'pkg', 'hello.js'), 'module.exports = 1;\n');
    });

    it('matches files by wildcard pattern', async () => {
      const tool = createSearchFilesTool(sandbox);
      const result = (await tool.execute({ pattern: '*.md' })) as {
        matches: Array<{ path: string }>;
      };
      expect(result.matches.map((m) => m.path)).toEqual(['readme.md']);
    });

    it('matches files in subdirectories and skips node_modules', async () => {
      const tool = createSearchFilesTool(sandbox);
      const result = (await tool.execute({ pattern: '*hello*' })) as {
        matches: Array<{ path: string }>;
      };
      // node_modules/pkg/hello.js must NOT appear even though its name matches.
      expect(result.matches.map((m) => m.path)).toEqual([]);
    });

    it('searches content and returns matching line numbers', async () => {
      const tool = createSearchFilesTool(sandbox);
      const result = (await tool.execute({ pattern: '*', contentPattern: 'hello' })) as {
        matches: Array<{ path: string; lines: number[] }>;
      };
      const byPath = Object.fromEntries(result.matches.map((m) => [m.path, m.lines]));
      expect(byPath['readme.md']).toEqual([1]);
      expect(byPath['src/app.ts']).toEqual([1]);
      expect(byPath['src/util.ts']).toBeUndefined();
    });

    it('respects maxResults', async () => {
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(workspaceRoot, `f${i}.txt`), 'x');
      }
      const tool = createSearchFilesTool(sandbox);
      const result = (await tool.execute({ pattern: '*.txt', maxResults: 3 })) as {
        matches: Array<{ path: string }>;
        count: number;
      };
      expect(result.count).toBe(3);
    });
  });
});
