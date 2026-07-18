import type { Message } from '@one-agent/agent-core';
import { sanitizeTerminalText } from '../output.js';

export interface ContextDisplayInfo {
  messageCount: number;
  estimatedTokens: number;
  maxContextTokens?: number;
  hasSummary: boolean;
  recentTokenBudget?: number;
  tokenSource: 'real' | 'estimate';
}

export interface ContextDisplayInput {
  context: Message[];
  userFacingHistory: Message[];
  info: ContextDisplayInfo;
  verbose?: boolean;
}

function preview(content: string, limit = 200): string {
  return sanitizeTerminalText(content).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function roleLabel(message: Message): string {
  if (message.role === 'user') return 'You';
  if (message.role === 'assistant') return 'Assistant';
  if (message.role === 'tool') return 'Tool';
  return 'System';
}

/** Format /context without exposing internal messages unless explicitly requested. */
export function formatContextDisplay(input: ContextDisplayInput): string[] {
  const { context, userFacingHistory, info, verbose = false } = input;
  const lines: string[] = [];
  const budget = info.maxContextTokens ? ` / ${info.maxContextTokens} budget` : '';
  const summarized = info.hasSummary ? ' | summarized' : '';
  const tokenSource = info.tokenSource === 'real' ? 'real+est' : 'est';
  lines.push(
    `Context: ${userFacingHistory.length} visible message(s) | ~${info.estimatedTokens} tokens${budget}${summarized} | ${tokenSource}`,
  );

  const summary = context.find(
    (message) => message.role === 'system' && message.content.startsWith('Earlier conversation summary:'),
  );
  const memory = context.find(
    (message) => message.role === 'system' && message.content.startsWith('Relevant context from past conversations:'),
  );
  if (summary) lines.push(`Summary: ${preview(summary.content)}`);
  if (memory) lines.push(`Memory: ${preview(memory.content)}`);

  if (userFacingHistory.length > 0) {
    lines.push('Recent messages:');
    for (const message of userFacingHistory.slice(-4)) {
      lines.push(`  ${roleLabel(message)}: ${preview(message.content)}`);
    }
  }

  if (verbose) {
    const internalMessages = context.filter(
      (message) => message.role !== 'system' && !userFacingHistory.includes(message),
    );
    lines.push(`Internal context (verbose): ${internalMessages.length} message(s); ${info.messageCount} total.`);
    for (const message of internalMessages.slice(-4)) {
      const toolCalls = message.tool_calls?.map((call) => call.function.name).join(', ');
      const suffix = toolCalls ? ` [tool calls: ${toolCalls}]` : '';
      lines.push(`  ${roleLabel(message)}${suffix}: ${preview(message.content) || '(empty)'}`);
    }
  }

  return lines;
}
