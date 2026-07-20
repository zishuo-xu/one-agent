import { describe, expect, it } from 'vitest';
import {
  allPlanStepsCompleted,
  buildExecutionUnits,
  findPlanStep,
  flattenPlanPostOrder,
} from '../../src/agents/loops/planExecution.js';
import type { Plan } from '../../src/planning/types.js';

describe('plan execution helpers', () => {
  const plan: Plan = {
    reasoning: 'test plan',
    steps: [
      {
        id: 'parent',
        description: 'parent',
        status: 'pending',
        children: [
          { id: 'a', description: 'a', status: 'completed', delegate: true, parallel: true },
          { id: 'b', description: 'b', status: 'completed', delegate: true, parallel: true },
        ],
      },
    ],
  };

  it('keeps tree traversal and wave grouping as deterministic pure logic', () => {
    const order = flattenPlanPostOrder(plan);
    expect(order.map((step) => step.id)).toEqual(['a', 'b', 'parent']);
    expect(buildExecutionUnits(order).map((unit) => unit.type)).toEqual(['wave', 'single']);
    expect(findPlanStep(plan.steps, 'b')?.description).toBe('b');
  });

  it('requires containers and children to complete', () => {
    expect(allPlanStepsCompleted(plan.steps)).toBe(false);
    plan.steps[0].status = 'completed';
    expect(allPlanStepsCompleted(plan.steps)).toBe(true);
  });

  it('never executes a flagged container as a delegated wave step', () => {
    const legacyPlan: Plan = {
      reasoning: 'legacy malformed plan',
      steps: [{
        id: 'container',
        description: 'container',
        status: 'pending',
        delegate: true,
        parallel: true,
        children: [
          { id: 'a', description: 'a', status: 'pending', delegate: true, parallel: true },
          { id: 'b', description: 'b', status: 'pending', delegate: true, parallel: true },
        ],
      }],
    };

    const units = buildExecutionUnits(flattenPlanPostOrder(legacyPlan));
    expect(units.map((unit) => unit.type)).toEqual(['wave', 'single']);
    expect(units[1]).toMatchObject({ type: 'single', step: { id: 'container' } });
  });
});
