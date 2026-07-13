import { bold, cyan, dim } from './format.js';

interface RenderState {
  inCodeBlock: boolean;
  codeBlockLang: string;
  orderedListIndex: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderInline(text: string): string {
  // Bold: **text**
  let result = text.replace(/\*\*(.+?)\*\*/g, (_, content) => bold(content));
  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, (_, content) => cyan(content));
  return result;
}

function renderListItem(line: string, indent: number): string {
  const prefix = '  '.repeat(indent) + '• ';
  return prefix + renderInline(line.trim());
}

function renderOrderedListItem(line: string, indent: number, index: number): string {
  const prefix = '  '.repeat(indent) + `${index}. `;
  return prefix + renderInline(line.trim());
}

export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const state: RenderState = {
    inCodeBlock: false,
    codeBlockLang: '',
    orderedListIndex: 0,
  };

  let listIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block fences
    const codeFenceMatch = line.match(/^(\s*)```(\S*)/);
    if (codeFenceMatch) {
      if (!state.inCodeBlock) {
        state.inCodeBlock = true;
        state.codeBlockLang = codeFenceMatch[2];
        out.push(dim('─'.repeat(40)));
        if (state.codeBlockLang) {
          out.push(dim(state.codeBlockLang));
        }
      } else {
        state.inCodeBlock = false;
        state.codeBlockLang = '';
        out.push(dim('─'.repeat(40)));
      }
      continue;
    }

    if (state.inCodeBlock) {
      // Preserve code block content as-is with subtle coloring
      out.push(cyan(line));
      continue;
    }

    // Empty line resets list counters
    if (line.trim() === '') {
      state.orderedListIndex = 0;
      listIndent = 0;
      out.push('');
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = headerMatch[2];
      if (level === 1) {
        out.push(bold(content));
      } else {
        out.push('  '.repeat(level - 2) + bold(content));
      }
      continue;
    }

    // Unordered list
    const unorderedMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (unorderedMatch) {
      const indent = Math.floor(unorderedMatch[1].length / 2);
      out.push(renderListItem(unorderedMatch[2], indent));
      continue;
    }

    // Ordered list
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      const indent = Math.floor(orderedMatch[1].length / 2);
      state.orderedListIndex = Number(orderedMatch[2]);
      out.push(renderOrderedListItem(orderedMatch[3], indent, state.orderedListIndex));
      continue;
    }

    // Normal paragraph
    out.push(renderInline(line));
  }

  return out.join('\n');
}
