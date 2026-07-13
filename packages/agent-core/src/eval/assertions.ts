import { AgentLoopEvent } from '../agents/AgentLoop.js';
import { ToolCall } from '../tools/types.js';

export function extractToolCalls(events: AgentLoopEvent[]): ToolCall[] {
  return events
    .filter((e): e is { type: 'tool_call'; toolCall: ToolCall } => e.type === 'tool_call')
    .map((e) => e.toolCall);
}

export function assertToolCalled(
  toolCalls: ToolCall[],
  name: string,
  expectedArgs?: Record<string, unknown>
): string | undefined {
  const found = toolCalls.find((c) => c.name === name);
  if (!found) {
    return `Expected tool ${name} to be called, but it was not`;
  }
  if (expectedArgs) {
    const actual = JSON.stringify(found.arguments);
    const expected = JSON.stringify(expectedArgs);
    if (actual !== expected) {
      return `Tool ${name} arguments mismatch: expected ${expected}, got ${actual}`;
    }
  }
  return undefined;
}

export function assertToolOrder(toolCalls: ToolCall[], expectedNames: string[]): string | undefined {
  const actualNames = toolCalls.map((c) => c.name);
  if (actualNames.length < expectedNames.length) {
    return `Expected ${expectedNames.length} tool call(s), got ${actualNames.length}`;
  }
  for (let i = 0; i < expectedNames.length; i++) {
    if (actualNames[i] !== expectedNames[i]) {
      return `Expected tool #${i + 1} to be ${expectedNames[i]}, got ${actualNames[i]}`;
    }
  }
  return undefined;
}

export function assertNoToolCalled(toolCalls: ToolCall[], name: string): string | undefined {
  const found = toolCalls.find((c) => c.name === name);
  if (found) {
    return `Tool ${name} should not have been called, but it was`;
  }
  return undefined;
}

export function assertFinalAnswer(reply: string, contains: string[]): string | undefined {
  if (contains.length === 0) return undefined;
  const normalized = reply.toLowerCase();
  const found = contains.some((phrase) => normalized.includes(phrase.toLowerCase()));
  if (!found) {
    return `Final answer missing any of the phrases: ${contains.join(', ')}`;
  }
  return undefined;
}

export function assertToolEventuallyCalled(
  toolCalls: ToolCall[],
  name: string,
  expectedArgs?: Record<string, unknown>
): string | undefined {
  const found = toolCalls.filter((c) => c.name === name);
  if (found.length === 0) {
    return `Expected tool ${name} to be called at least once, but it was not`;
  }
  if (expectedArgs) {
    const expected = JSON.stringify(expectedArgs);
    const matches = found.some((c) => JSON.stringify(c.arguments) === expected);
    if (!matches) {
      return `Tool ${name} was called but never with arguments ${expected}`;
    }
  }
  return undefined;
}

export function assertEventType(events: AgentLoopEvent[], type: AgentLoopEvent['type']): string | undefined {
  if (!events.some((e) => e.type === type)) {
    return `Expected event of type ${type}, but none found`;
  }
  return undefined;
}
