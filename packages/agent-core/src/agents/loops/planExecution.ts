import type { Plan, PlanStep } from '../../planning/types.js';
import {
  isDelegatedPlanStep,
  isDelegatedWorkPackage,
} from '../../planning/DelegationPolicy.js';

export type ExecutionUnit =
  | { type: 'single'; step: PlanStep }
  | { type: 'wave'; steps: PlanStep[] };

/** Children execute before their container step. */
export function flattenPlanPostOrder(plan: Plan): PlanStep[] {
  const order: PlanStep[] = [];
  const visit = (step: PlanStep) => {
    // Version-2 delegated nodes are complete work packages. Their checklist
    // belongs to one sub-agent and any compatibility children must not become
    // separately scheduled agents.
    if (isDelegatedWorkPackage(step)) {
      order.push(step);
      return;
    }
    for (const child of step.children ?? []) visit(child);
    order.push(step);
  };
  for (const step of plan.steps) visit(step);
  return order;
}

/** Consecutive delegate+parallel steps form one read-only execution wave. */
export function buildExecutionUnits(order: PlanStep[]): ExecutionUnit[] {
  order = stableDependencyOrder(order);
  const units: ExecutionUnit[] = [];
  let index = 0;
  while (index < order.length) {
    const step = order[index];
    // A container is structural even if an older persisted plan incorrectly
    // carries delegation flags. Only leaf steps may enter an execution wave.
    if (!step.children?.length && isDelegatedPlanStep(step) && step.parallel) {
      const steps: PlanStep[] = [];
      while (
        index < order.length &&
        !order[index].children?.length &&
        isDelegatedPlanStep(order[index]) &&
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

/**
 * Keep planner order when possible, but never schedule a step before a known
 * prerequisite. Invalid/cyclic references fall back to their original order
 * so the bounded judge/replan path can surface the bad plan instead of
 * deadlocking the run.
 */
function stableDependencyOrder(order: PlanStep[]): PlanStep[] {
  const knownIds = new Set(order.map((step) => step.id));
  const remaining = [...order];
  const resolved = new Set<string>();
  const output: PlanStep[] = [];

  while (remaining.length > 0) {
    const index = remaining.findIndex((step) =>
      (step.dependsOn ?? []).every((id) => !knownIds.has(id) || resolved.has(id))
    );
    if (index < 0) {
      output.push(...remaining);
      break;
    }
    const [step] = remaining.splice(index, 1);
    output.push(step);
    resolved.add(step.id);
  }
  return output;
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
