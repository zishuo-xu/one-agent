import { describe, it, expect } from 'vitest';
import { createChatEventHandler } from '../src/chat-events.js';
import type { AgentLoopEvent } from '@one-agent/agent-core';

function makeTimeline(verbose = false) {
  const deltas: string[] = [];
  const reasoning: string[] = [];
  const infos: string[] = [];
  const labels: string[] = [];
  const flags = { stopped: false };
  return {
    deltas,
    reasoning,
    infos,
    labels,
    flags,
    verbose,
    onDelta: (t: string) => deltas.push(t),
    onReasoning: (t: string) => reasoning.push(t),
    onInfo: (t: string) => infos.push(t),
    progress: {
      setLabel: (l: string) => labels.push(l),
      stop: () => {
        flags.stopped = true;
      },
    },
  };
}

describe('createChatEventHandler streaming', () => {
  it('prints each message_delta live via onDelta', () => {
    const tl = makeTimeline();
    const { handler, result } = createChatEventHandler(tl);

    handler({ type: 'message_delta', content: 'Hel' } as AgentLoopEvent);
    handler({ type: 'message_delta', content: 'lo' } as AgentLoopEvent);

    expect(tl.deltas).toEqual(['Hel', 'lo']);
    expect(result.hasStreamedLive).toBe(true);
    expect(result.streamedContent).toBe('Hello');
    expect(tl.infos).toEqual([]);
  });

  it('stops progress on first live token and labels Answering', () => {
    const tl = makeTimeline();
    const { handler } = createChatEventHandler(tl);
    handler({ type: 'message_delta', content: 'x' } as AgentLoopEvent);
    expect(tl.flags.stopped).toBe(true);
    expect(tl.labels[tl.labels.length - 1]).toBe('Answering');
  });

  it('records first-delta time and answer window', () => {
    const tl = makeTimeline();
    const { handler, result } = createChatEventHandler(tl);
    const before = Date.now();
    handler({ type: 'message_delta', content: 'a' } as AgentLoopEvent);
    handler({ type: 'message_delta', content: 'b' } as AgentLoopEvent);
    expect(result.firstDeltaTime).toBeGreaterThanOrEqual(before);
    expect(result.answerStartTime).toBeGreaterThanOrEqual(before);
    expect(result.answerEndTime).toBeGreaterThanOrEqual(result.answerStartTime);
  });

  it('prints tool_call/tool_result via onInfo, not onDelta', () => {
    const tl = makeTimeline();
    const { handler } = createChatEventHandler(tl);
    handler({ type: 'tool_call', toolCall: { id: '1', name: 'read_file', arguments: {} } } as unknown as AgentLoopEvent);
    handler({
      type: 'tool_result',
      toolResult: { success: true, data: {} },
    } as unknown as AgentLoopEvent);
    expect(tl.deltas).toEqual([]);
    expect(tl.infos.join('')).toContain('[tool_call] read_file');
    expect(tl.infos.join('')).toContain('[tool_result]');
  });

  it('non-streamed message (no deltas) does not mark hasStreamedLive', () => {
    const tl = makeTimeline();
    const { handler, result } = createChatEventHandler(tl);
    handler({ type: 'message', content: 'full reply' } as AgentLoopEvent);
    expect(result.hasStreamedLive).toBe(false);
    expect(result.streamedContent).toBe('full reply');
  });

  it('colour/ANSI escapes in deltas are stripped via sanitizeTerminalText', () => {
    const tl = makeTimeline();
    const { handler, result } = createChatEventHandler(tl);
    handler({ type: 'message_delta', content: '\u001b[31mred\u001b[0m' } as AgentLoopEvent);
    expect(result.streamedContent).toBe('red');
    expect(tl.deltas).toEqual(['red']);
  });

  it('verbose mode prints thoughts; non-verbose does not', () => {
    const tlQuiet = makeTimeline(false);
    createChatEventHandler(tlQuiet).handler({ type: 'thought', content: 'thinking' } as AgentLoopEvent);
    expect(tlQuiet.infos).toEqual([]);

    const tlVerbose = makeTimeline(true);
    createChatEventHandler(tlVerbose).handler({ type: 'thought', content: 'thinking' } as AgentLoopEvent);
    expect(tlVerbose.infos.join('')).toContain('thinking');
  });

  it('empty deltas are not printed or counted', () => {
    const tl = makeTimeline();
    const { handler, result } = createChatEventHandler(tl);
    handler({ type: 'message_delta', content: '' } as AgentLoopEvent);
    handler({ type: 'message_delta', content: '   ' } as AgentLoopEvent);
    expect(result.hasStreamedLive).toBe(false);
    expect(tl.deltas).toEqual([]);
  });

  it('keeps reasoning_delta out of normal user output', () => {
    const tl = makeTimeline();
    const { handler, result } = createChatEventHandler(tl);

    handler({ type: 'reasoning_delta', content: 'The user said hello.' } as AgentLoopEvent);
    handler({ type: 'reasoning_delta', content: ' I should greet back.' } as AgentLoopEvent);

    expect(tl.deltas).toEqual([]);
    expect(tl.reasoning).toEqual([]);
    expect(tl.infos).toEqual([]);
    expect(result.hasStreamedLive).toBe(false);
    expect(result.streamedContent).toBe('');
  });

  it('does not count reasoning_delta as answer timing', () => {
    const tl = makeTimeline();
    const { handler, result } = createChatEventHandler(tl);
    handler({ type: 'reasoning_delta', content: 'thinking...' } as AgentLoopEvent);
    expect(result.firstDeltaTime).toBe(0);
    expect(result.answerStartTime).toBe(0);
    expect(result.answerEndTime).toBe(0);
  });

  it('shows reasoning in a separate verbose section without mixing it into the answer', () => {
    const tl = makeTimeline(true);
    const { handler, result } = createChatEventHandler(tl);

    handler({ type: 'reasoning_delta', content: 'Let me think...' } as AgentLoopEvent);
    handler({ type: 'message_delta', content: 'Hello!' } as AgentLoopEvent);

    expect(tl.reasoning).toEqual(['Let me think...']);
    expect(tl.infos.join('')).toContain('[reasoning]');
    expect(tl.infos.join('')).toContain('[answer]');
    expect(tl.deltas).toEqual(['Hello!']);
    expect(result.streamedContent).toBe('Hello!');
    expect(result.hasStreamedLive).toBe(true);
  });
});
