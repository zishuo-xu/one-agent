import { describe, it, expect } from 'vitest';
import { ReasoningChain } from '../../src/planning/ReasoningChain.js';

describe('ReasoningChain', () => {
  it('records thought, action, observation', () => {
    const chain = new ReasoningChain();
    chain.setCurrentPlanStepId('step-1');

    chain.addThought('I need to read the file');
    chain.addAction({ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } });
    chain.addObservation({ success: true, data: { content: 'hello' } });

    const steps = chain.getSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].thought).toBe('I need to read the file');
    expect(steps[0].action?.name).toBe('read_file');
    expect(steps[0].observation?.success).toBe(true);
    expect(steps[0].planStepId).toBe('step-1');
  });

  it('filters steps by plan step id', () => {
    const chain = new ReasoningChain();

    chain.setCurrentPlanStepId('step-1');
    chain.addThought('first');
    chain.addObservation({ success: true });

    chain.setCurrentPlanStepId('step-2');
    chain.addThought('second');
    chain.addObservation({ success: true });

    expect(chain.getStepsByPlanStep('step-1')).toHaveLength(1);
    expect(chain.getStepsByPlanStep('step-1')[0].thought).toBe('first');
    expect(chain.getStepsByPlanStep('step-2')[0].thought).toBe('second');
  });

  it('commits partial steps with plan step id', () => {
    const chain = new ReasoningChain();
    chain.setCurrentPlanStepId('step-1');
    chain.addThought('I will think');
    chain.commitStep();
    chain.addReflection('Actually, reconsider');
    chain.commitStep();

    expect(chain.getSteps()).toHaveLength(2);
    expect(chain.getSteps().every((s) => s.planStepId === 'step-1')).toBe(true);
  });

  it('records failure analysis', () => {
    const chain = new ReasoningChain();
    chain.setCurrentPlanStepId('step-1');
    chain.addFailureAnalysis({
      category: 'plan_mismatch',
      affectedStepIds: ['step-1'],
      rootCause: 'Wrong tool',
      recommendation: 'Retry',
    });
    chain.commitStep();

    const steps = chain.getSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].failureAnalysis?.category).toBe('plan_mismatch');
    expect(steps[0].failureAnalysis?.recommendation).toBe('Retry');
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
});
