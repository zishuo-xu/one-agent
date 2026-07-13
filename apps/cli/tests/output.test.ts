import { describe, expect, it } from 'vitest';
import {
  isRenderableMessageDelta,
  sanitizeTerminalText,
  shouldPrintFinalReply,
} from '../src/output.js';

describe('CLI streamed output', () => {
  it('ignores empty or whitespace-only deltas', () => {
    expect(isRenderableMessageDelta('')).toBe(false);
    expect(isRenderableMessageDelta(' \n\t')).toBe(false);
  });

  it('renders deltas containing visible text', () => {
    expect(isRenderableMessageDelta('  你好  ')).toBe(true);
  });

  it('prints a final reply when streamed content differs', () => {
    expect(shouldPrintFinalReply('完整回答', '')).toBe(true);
    expect(shouldPrintFinalReply('完整回答', '完整回答')).toBe(false);
    expect(shouldPrintFinalReply('完整回答', '  完整回答  ')).toBe(false);
  });

  it('removes terminal control codes before rendering', () => {
    const value = '\u001b[2J\u001b[H你好\u001b[0m';
    expect(sanitizeTerminalText(value)).toBe('你好');
    expect(isRenderableMessageDelta('\u001b[2J\u001b[H')).toBe(false);
  });
});
