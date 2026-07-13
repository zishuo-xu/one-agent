import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltInTools } from '../../src/tools/built-in/index.js';
import { Sandbox } from '../../src/tools/sandbox.js';

function buildWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'one-agent-tools-'));
}

describe('createBuiltInTools', () => {
  it('auto-discovers all built-in tools', () => {
    const sandbox = new Sandbox(buildWorkspaceRoot());
    const tools = createBuiltInTools(sandbox);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_time', 'list_files', 'read_file', 'write_file']);
  });

  it('returns valid ToolDefinition objects', () => {
    const sandbox = new Sandbox(buildWorkspaceRoot());
    const tools = createBuiltInTools(sandbox);

    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });
});
