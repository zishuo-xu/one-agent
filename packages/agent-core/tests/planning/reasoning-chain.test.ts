import { describe, it, expect } from 'vitest';
import { ReasoningChain } from '../../src/planning/ReasoningChain.js';

describe('ReasoningChain', () => {
  it('records thought, action, observation', () => {
    const chain = new ReasoningChain();

    chain.addThought('I need to read the file');
    chain.addAction({ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } });
    chain.addObservation({ success: true, data: { content: 'hello' } });

    const steps = chain.getSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].thought).toBe('I need to read the file');
    expect(steps[0].action?.name).toBe('read_file');
    expect(steps[0].observation?.success).toBe(true);
  });

  it('converts steps to messages', () => {
    const chain = new ReasoningChain();

    chain.addThought('I need to read the file');
    chain.addAction({ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } });
    chain.addObservation({ success: true, data: { content: 'hello' } });

    const messages = chain.toMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain('Thought:');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].tool_calls).toBeDefined();
    expect(messages[2].role).toBe('tool');
  });

  it('commits partial steps', () => {
    const chain = new ReasoningChain();
    chain.addThought('I will think');
    chain.commitStep();
    chain.addReflection('Actually, reconsider');
    chain.commitStep();

    expect(chain.getSteps()).toHaveLength(2);
  });
});
