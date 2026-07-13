import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/context/ContextManager.js';

describe('ContextManager with memory context', () => {
  it('injects memory context after system prompt when buildContext is short', async () => {
    const manager = new ContextManager({ systemPrompt: 'You are a helpful assistant', summaryTrigger: 100 });
    manager.addMessage({ role: 'user', content: 'Hello' });
    manager.setMemoryContext('User prefers Chinese.');

    const context = await manager.buildContext();
    expect(context[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
    expect(context[1]).toEqual({
      role: 'system',
      content: 'Relevant context from past conversations: User prefers Chinese.',
    });
    expect(context[2]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('includes memory context in getContextForDisplay', () => {
    const manager = new ContextManager({ systemPrompt: 'You are a helpful assistant', maxRecentMessages: 5 });
    manager.addMessage({ role: 'user', content: 'Hello' });
    manager.setMemoryContext('User prefers Chinese.');

    const context = manager.getContextForDisplay();
    expect(context[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
    expect(context[1]).toEqual({
      role: 'system',
      content: 'Relevant context from past conversations: User prefers Chinese.',
    });
  });

  it('does not include memory when no context is set', async () => {
    const manager = new ContextManager({ systemPrompt: 'You are a helpful assistant', summaryTrigger: 100 });
    manager.addMessage({ role: 'user', content: 'Hello' });

    const context = await manager.buildContext();
    expect(context).toHaveLength(2);
    expect(context[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
    expect(context[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('clears memory context along with messages', () => {
    const manager = new ContextManager({ systemPrompt: 'You are a helpful assistant' });
    manager.setMemoryContext('User prefers Chinese.');
    manager.clear();

    const context = manager.getContextForDisplay();
    expect(context).toHaveLength(1);
    expect(context[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
  });
});
