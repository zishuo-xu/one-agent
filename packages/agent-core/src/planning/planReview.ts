import crypto from 'node:crypto';
import type { UserInputRequest } from '../agents/requestUserInputTool.js';
import type { Plan, PlanStep } from './types.js';

export const MAX_PLAN_REVISIONS = 1;

export type PlanReviewAnswer =
  | { decision: 'approve' }
  | { decision: 'reject' }
  | { decision: 'revise'; feedback: string };

export function parsePlanReviewAnswer(answer: string): PlanReviewAnswer {
  const normalized = answer.trim().toLowerCase();
  if (['approve', 'approved', 'yes', 'y', '同意', '确认', '继续'].includes(normalized)) {
    return { decision: 'approve' };
  }
  if (['reject', 'rejected', 'no', 'n', '拒绝', '取消'].includes(normalized)) {
    return { decision: 'reject' };
  }
  return { decision: 'revise', feedback: answer.trim() };
}

export function createPlanReviewRequest(plan: Plan, revision: number): UserInputRequest {
  const remaining = MAX_PLAN_REVISIONS - revision;
  const revisionHint = remaining > 0
    ? 'You may also provide one change request to revise the plan.'
    : 'The plan has already been revised once; reply approve or reject.';
  return {
    id: crypto.randomUUID(),
    kind: 'plan_approval',
    question: [
      'Review the proposed plan before execution:',
      ...formatPlanSteps(plan.steps),
      '',
      `Reply approve to execute, or reject to cancel. ${revisionHint}`,
    ].join('\n'),
    options: ['approve', 'reject'],
    createdAt: new Date().toISOString(),
    planReview: {
      revision,
      maxRevisions: MAX_PLAN_REVISIONS,
    },
  };
}

function formatPlanSteps(steps: PlanStep[], depth = 0): string[] {
  return steps.flatMap((step) => {
    const indent = '  '.repeat(depth);
    const tool = step.toolName ? ` [${step.toolName}]` : '';
    const delegation = step.delegate ? (step.parallel ? ' [parallel sub-agent]' : ' [sub-agent]') : '';
    return [
      `${indent}${step.id}. ${step.description}${tool}${delegation}`,
      ...formatPlanSteps(step.children ?? [], depth + 1),
    ];
  });
}
