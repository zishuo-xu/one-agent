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
});
