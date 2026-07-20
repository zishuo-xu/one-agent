import { describe, expect, it } from 'vitest';
import type { MemoryDocument } from '@one-agent/agent-core';
import { formatMemoryDocuments } from '../src/commands/memory.js';

describe('memory CLI formatting', () => {
  it('shows the scope, local path and complete Markdown content', () => {
    const document: MemoryDocument = {
      scope: 'workspace',
      path: '/tmp/project/.one-agent/MEMORY.md',
      content: '# Workspace Memory\n\n- Use pnpm.\n',
      hash: 'abc',
    };
    const output = formatMemoryDocuments([document]).join('\n');
    expect(output).toContain('Workspace memory');
    expect(output).toContain(document.path);
    expect(output).toContain('- Use pnpm.');
    expect(output).not.toContain('confidence');
  });
});
