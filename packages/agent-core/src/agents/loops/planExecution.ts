import type { Plan, PlanStep } from '../../planning/types.js';

/** Parallel waves are deliberately limited to side-effect-free tools. */
export const READ_ONLY_DELEGATION_TOOLS = [
  'read_file',
  'list_files',
  'search_files',
  'web_search',
  'get_time',
];

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
    if (step.delegate && step.parallel) {
      const steps: PlanStep[] = [];
      while (index < order.length && order[index].delegate && order[index].parallel) {
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
