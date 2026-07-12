import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = {
  chat: vi.fn(),
  getHistory: vi.fn().mockReturnValue([]),
  getContext: vi.fn().mockReturnValue([]),
  getReasoningChain: vi.fn().mockReturnValue({ getSteps: () => [] }),
};

vi.mock('@one-agent/agent-core', () => ({
  config: {
    model: 'test-model',
    systemPrompt: 'You are a test assistant.',
  },
  AgentLoop: vi.fn().mockImplementation(() => mockAgent),
  ContextManager: vi.fn(),
  ToolRegistry: vi.fn().mockImplementation(() => ({
    registerMany: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  })),
  Sandbox: vi.fn().mockImplementation(() => ({
    rootPath: '/test/workspace',
  })),
  createBuiltInTools: vi.fn().mockReturnValue([]),
}));

import { printEvent, printMessages, runRepl } from '../src/repl.js';
import { AgentLoopEvent } from '@one-agent/agent-core';

describe('CLI repl helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent.chat.mockReset();
  });

  it('printEvent prints plan', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const event: AgentLoopEvent = {
      type: 'plan',
      plan: {
        reasoning: 'Test plan',
        steps: [
          { id: '1', description: 'Read file', status: 'pending' },
          { id: '2', description: 'Write summary', status: 'pending' },
        ],
      },
    };

    printEvent(event);

    expect(logSpy).toHaveBeenCalledWith('\n[计划]');
    expect(logSpy).toHaveBeenCalledWith('1. Read file');
    expect(logSpy).toHaveBeenCalledWith('2. Write summary');

    logSpy.mockRestore();
  });

  it('printEvent prints thought', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const event: AgentLoopEvent = { type: 'thought', content: 'I need to read the file' };

    printEvent(event);

    expect(logSpy).toHaveBeenCalledWith('[思考] I need to read the file');

    logSpy.mockRestore();
  });

  it('printEvent prints tool call', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const event: AgentLoopEvent = {
      type: 'tool_call',
      toolCall: { id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } },
    };

    printEvent(event);

    expect(logSpy).toHaveBeenCalledWith('[调用工具] read_file: {"path":"a.txt"}');

    logSpy.mockRestore();
  });

  it('printMessages prints all roles', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const messages = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
      { role: 'tool' as const, content: 'result', tool_call_id: 'call_1' },
    ];

    printMessages(messages);

    expect(logSpy).toHaveBeenCalledWith('📋 system: system prompt');
    expect(logSpy).toHaveBeenCalledWith('👤 user: hello');
    expect(logSpy).toHaveBeenCalledWith('🤖 assistant: hi');
    expect(logSpy).toHaveBeenCalledWith('🔧 tool: result');

    logSpy.mockRestore();
  });

  it('runRepl exits on /exit', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const question = vi.fn().mockResolvedValue('/exit');
    const onClose = vi.fn();

    await runRepl({ question, onClose });

    expect(question).toHaveBeenCalledWith('You: ');
    expect(onClose).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Bye!');

    logSpy.mockRestore();
  });

  it('runRepl processes a user message and shows reply', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const question = vi
      .fn()
      .mockResolvedValueOnce('hello')
      .mockResolvedValueOnce('/exit');
    mockAgent.chat.mockResolvedValue({ reply: 'Hi there', events: [] });

    await runRepl({ question });

    expect(mockAgent.chat).toHaveBeenCalledWith('hello');
    expect(logSpy).toHaveBeenCalledWith('\nAgent: Hi there\n');

    logSpy.mockRestore();
  });

  it('runRepl handles /history', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const question = vi
      .fn()
      .mockResolvedValueOnce('/history')
      .mockResolvedValueOnce('/exit');
    mockAgent.getHistory.mockReturnValue([{ role: 'user', content: 'hello' }]);

    await runRepl({ question });

    expect(mockAgent.getHistory).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('👤 user: hello');

    logSpy.mockRestore();
  });

  it('runRepl handles /context', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const question = vi
      .fn()
      .mockResolvedValueOnce('/context')
      .mockResolvedValueOnce('/exit');
    mockAgent.getContext.mockReturnValue([{ role: 'system', content: 'system prompt' }]);

    await runRepl({ question });

    expect(mockAgent.getContext).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('📋 system: system prompt');

    logSpy.mockRestore();
  });
});
