import { describe, expect, it } from 'vitest';
import type { Message } from '@one-agent/agent-core';
import { formatContextDisplay } from '../src/commands/context.js';

const info = {
  messageCount: 4,
  estimatedTokens: 321,
  maxContextTokens: 4096,
  hasSummary: false,
  tokenSource: 'real' as const,
};

function fixture() {
  const user: Message = { role: 'user', content: 'Read package.json' };
  const toolCall: Message = {
    role: 'assistant',
    content: 'I will inspect the file',
    internal: true,
    tool_calls: [{
      id: 'call-1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"package.json"}' },
    }],
  };
  const toolResult: Message = {
    role: 'tool',
    content: 'SECRET_FILE_CONTENT',
    internal: true,
    tool_call_id: 'call-1',
  };
  const answer: Message = { role: 'assistant', content: 'one-agent' };
  const context: Message[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'system', content: 'Relevant context from past conversations: prefers concise answers' },
    user,
    toolCall,
    toolResult,
    answer,
  ];
  return { context, userFacingHistory: [user, answer] };
}

describe('/context display', () => {
  it('shows only user-facing messages by default', () => {
    const lines = formatContextDisplay({ ...fixture(), info });
    const output = lines.join('\n');

    expect(output).toContain('2 visible message(s)');
    expect(output).toContain('You: Read package.json');
    expect(output).toContain('Assistant: one-agent');
    expect(output).toContain('Memory: Relevant context');
    expect(output).not.toContain('I will inspect the file');
    expect(output).not.toContain('SECRET_FILE_CONTENT');
  });

  it('shows bounded internal details only with --verbose', () => {
    const lines = formatContextDisplay({ ...fixture(), info, verbose: true });
    const output = lines.join('\n');

    expect(output).toContain('Internal context (verbose): 2 message(s)');
    expect(output).toContain('[tool calls: read_file]');
    expect(output).toContain('SECRET_FILE_CONTENT');
  });
});
