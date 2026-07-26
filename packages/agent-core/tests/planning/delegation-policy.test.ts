import { describe, expect, it } from 'vitest';
import {
  DelegationPolicy,
  isDelegatedPlanStep,
} from '../../src/planning/DelegationPolicy.js';
import type { Plan } from '../../src/planning/types.js';

function workPackage(id: string, description: string) {
  return {
    id,
    description,
    status: 'pending' as const,
    executor: 'subagent' as const,
    delegate: true,
    parallel: true,
    delegationReason: `${description} is an independent investigation.`,
    expectedOutcome: `${description} report`,
    expectedEvidence: ['file paths and line numbers'],
    checklist: [
      { id: `${id}.1`, description: 'Inspect the relevant entry points' },
      { id: `${id}.2`, description: 'Collect concrete evidence' },
    ],
  };
}

describe('DelegationPolicy', () => {
  it('keeps one delegated container as one work package and absorbs its children into the checklist', () => {
    const plan: Plan = {
      version: 2,
      reasoning: 'review',
      steps: [{
        ...workPackage('1', 'Security review'),
        checklist: undefined,
        children: [
          { id: '1.1', description: 'Check command execution', status: 'pending' },
          { id: '1.2', description: 'Check path handling', status: 'pending' },
        ],
      }],
    };

    new DelegationPolicy().preparePlan(plan);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].children).toBeUndefined();
    expect(plan.steps[0].checklist?.map((item) => item.description)).toEqual([
      'Check command execution',
      'Check path handling',
    ]);
    expect(isDelegatedPlanStep(plan.steps[0])).toBe(true);
  });

  it('returns underspecified version-2 delegation to the main agent', () => {
    const plan: Plan = {
      version: 2,
      reasoning: 'too small',
      steps: [{
        id: '1',
        description: 'Read one file',
        status: 'pending',
        executor: 'subagent',
        delegate: true,
        parallel: true,
      }],
    };

    new DelegationPolicy().preparePlan(plan);

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      executor: 'main',
      delegate: false,
      parallel: false,
    }));
  });

  it('does not impose a count cap on distinct, well-defined work packages', () => {
    const plan: Plan = {
      version: 2,
      reasoning: 'broad independent review',
      steps: Array.from({ length: 9 }, (_, index) =>
        workPackage(String(index + 1), `Independent domain ${index + 1}`)),
    };

    new DelegationPolicy().preparePlan(plan);

    expect(plan.steps).toHaveLength(9);
    expect(plan.steps.every(isDelegatedPlanStep)).toBe(true);
  });

  it('keeps legacy plans unchanged for checkpoint recovery', () => {
    const plan: Plan = {
      reasoning: 'legacy',
      steps: [{
        id: '1',
        description: 'legacy container',
        status: 'pending',
        delegate: true,
        children: [{ id: '1.1', description: 'legacy leaf', status: 'pending', delegate: true }],
      }],
    };

    new DelegationPolicy().preparePlan(plan);

    expect(plan.steps[0].children).toHaveLength(1);
  });
});
