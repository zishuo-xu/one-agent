import type { Plan, PlanStep } from '../../planning/types.js';

export type ExecutionUnit =
  | { type: 'single'; step: PlanStep }
  | { type: 'wave'; steps: PlanStep[] };

/** Children execute before their container step. */
export function flattenPlanPostOrder(plan: Plan): PlanStep[] {
  const order: PlanStep[] = [];
  const visit = (step: PlanStep) => {
    for (const child of step.children ?? []) visit(child);
    order.push(step);
  };
  for (const step of plan.steps) visit(step);
  return order;
}

/** Consecutive delegate+parallel steps form one read-only execution wave. */
export function buildExecutionUnits(order: PlanStep[]): ExecutionUnit[] {
  const units: ExecutionUnit[] = [];
  let index = 0;
  while (index < order.length) {
    const step = order[index];
    // A container is structural even if an older persisted plan incorrectly
    // carries delegation flags. Only leaf steps may enter an execution wave.
    if (!step.children?.length && step.delegate && step.parallel) {
      const steps: PlanStep[] = [];
      while (
        index < order.length &&
        !order[index].children?.length &&
        order[index].delegate &&
        order[index].parallel
      ) {
        steps.push(order[index]);
        index++;
      }
      units.push({ type: 'wave', steps });
    } else {
      units.push({ type: 'single', step });
      index++;
    }
  }
  return units;
}

export function allPlanStepsCompleted(steps: PlanStep[]): boolean {
  return steps.every(
    (step) =>
      step.status === 'completed' &&
      (!step.children || allPlanStepsCompleted(step.children)),
  );
}

export function findPlanStep(steps: PlanStep[], id: string): PlanStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    const child = step.children ? findPlanStep(step.children, id) : undefined;
    if (child) return child;
  }
  return undefined;
}
