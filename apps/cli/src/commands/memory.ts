import type { MemoryDocument } from '@one-agent/agent-core';
import { sanitizeTerminalText } from '../output.js';

export function formatMemoryDocuments(documents: MemoryDocument[]): string[] {
  return documents.flatMap((document, index) => {
    const lines = [
      `${document.scope === 'global' ? 'Global memory' : 'Workspace memory'}: ${document.path}`,
      sanitizeTerminalText(document.content).trimEnd(),
    ];
    if (index < documents.length - 1) lines.push('');
    return lines;
  });
}
