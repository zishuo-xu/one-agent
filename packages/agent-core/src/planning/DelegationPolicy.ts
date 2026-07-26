import type {
  Plan,
  PlanChecklistItem,
  PlanExecutor,
  PlanStep,
} from './types.js';
import type { SubAgentTaskContract } from '../agents/SubAgentContract.js';

const SYNTHESIS_TASK =
  /\b(aggregate|synthesi[sz]e|final answer|respond to (the )?user|write the final)\b|汇总|综合结论|最终回答|回复用户/i;

export interface DelegationAssessment {
  allowed: boolean;
  reason: string;
}

/**
 * Shared delegation rules for every interaction surface and loop mode.
 *
 * The policy deliberately does not impose an agent-count cap. It validates
 * the quality and shape of each work package while the existing runtime
 * budgets, concurrency, timeout and depth controls remain the safety rails.
 */
export class DelegationPolicy {
  /**
   * Normalize a plan in place so injected planners and recovered checkpoints
   * follow the same runtime rules as Planner-produced plans.
   */
  preparePlan(plan: Plan): Plan {
    if (plan.version !== 2) return plan;
    plan.steps = this.prepareSiblings(plan.steps);
    return plan;
  }

  assessTask(task: SubAgentTaskContract): DelegationAssessment {
    if (!task.task.trim()) {
      return { allowed: false, reason: 'A delegated work package must have a non-empty objective.' };
    }
    if (SYNTHESIS_TASK.test(task.task)) {
      return {
        allowed: false,
        reason: 'Synthesis and the final user-facing answer must remain with the main agent.',
      };
    }

    // Persisted version-1 plans did not carry a structured contract. Keep
    // them resumable while enforcing the stronger rules for all new work.
    if (task.contractVersion !== 2) {
      return {
        allowed: true,
        reason: 'Legacy delegation contract accepted for checkpoint compatibility.',
      };
    }

    const hasDeliverable = Boolean(task.expectedOutcome?.trim());
    const hasMeaningfulScope =
      (task.checklist?.length ?? 0) >= 2 ||
      (task.expectedEvidence?.length ?? 0) > 0 ||
      (task.scope?.length ?? 0) > 0;
    if (!hasDeliverable || !hasMeaningfulScope) {
      return {
        allowed: false,
        reason:
          'Delegation requires a clear expected outcome and a meaningful scope, checklist, or evidence contract.',
      };
    }
    return {
      allowed: true,
      reason: task.delegationReason?.trim() || 'The task is a bounded, evidence-producing work package.',
    };
  }

  private prepareSiblings(steps: PlanStep[]): PlanStep[] {
    const seenDelegated = new Set<string>();
    const prepared: PlanStep[] = [];

    for (const step of steps) {
      this.prepareStep(step);
      const delegated = step.executor === 'subagent';
      if (delegated) {
        const signature = this.signature(step);
        if (seenDelegated.has(signature)) continue;
        seenDelegated.add(signature);
      }
      prepared.push(step);
    }
    return prepared;
  }

  private prepareStep(step: PlanStep): void {
    const executor: PlanExecutor =
      step.executor ?? (step.delegate ? 'subagent' : 'main');
    step.executor = executor;
    step.delegate = executor === 'subagent';
    step.constraints = uniqueText(step.constraints);
    step.scope = uniqueText(step.scope);
    step.nonGoals = uniqueText(step.nonGoals);
    step.expectedEvidence = uniqueText(step.expectedEvidence);
    step.dependsOn = uniqueText(step.dependsOn)?.filter((id) => id !== step.id);

    if (executor === 'subagent') {
      const childChecklist = checklistFromChildren(step.children);
      step.checklist = uniqueChecklist([
        ...(step.checklist ?? []),
        ...childChecklist,
      ]);
      step.children = undefined;
      if (step.dependsOn?.length) step.parallel = false;

      const assessment = this.assessTask({
        contractVersion: 2,
        task: step.description,
        expectedOutcome: step.expectedOutcome,
        expectedEvidence: step.expectedEvidence,
        constraints: step.constraints,
        scope: step.scope,
        nonGoals: step.nonGoals,
        checklist: step.checklist,
        delegationReason: step.delegationReason,
      });
      if (!assessment.allowed) {
        step.executor = 'main';
        step.delegate = false;
        step.parallel = false;
      }
      return;
    }

    step.delegate = false;
    step.parallel = false;
    if (step.children?.length) {
      step.children = this.prepareSiblings(step.children);
    }
  }

  private signature(step: PlanStep): string {
    return [
      normalize(step.description),
      normalize(step.expectedOutcome ?? ''),
      ...(step.checklist ?? []).map((item) => normalize(item.description)),
    ].join('|');
  }
}

export function isDelegatedPlanStep(step: PlanStep): boolean {
  return step.executor === 'subagent' || (step.executor === undefined && step.delegate === true);
}

export function isDelegatedWorkPackage(step: PlanStep): boolean {
  return step.executor === 'subagent';
}

function checklistFromChildren(children?: PlanStep[]): PlanChecklistItem[] {
  const items: PlanChecklistItem[] = [];
  const visit = (step: PlanStep) => {
    items.push({ id: step.id, description: step.description });
    for (const child of step.children ?? []) visit(child);
  };
  for (const child of children ?? []) visit(child);
  return items;
}

function uniqueChecklist(items: PlanChecklistItem[]): PlanChecklistItem[] | undefined {
  const seen = new Set<string>();
  const output: PlanChecklistItem[] = [];
  for (const item of items) {
    const description = item.description.trim();
    if (!description) continue;
    const key = normalize(description);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ id: item.id.trim() || String(output.length + 1), description });
  }
  return output.length ? output : undefined;
}

function uniqueText(items?: string[]): string[] | undefined {
  if (!items) return undefined;
  const output = [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  return output.length ? output : undefined;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
