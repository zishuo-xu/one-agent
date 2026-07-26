import crypto from 'node:crypto';
import type { UserInputRequest } from '../agents/requestUserInputTool.js';
import { runtimeSettings } from '../configAccess.js';
import { resolveDisplayLocale } from '../runtimePreferences.js';
import type { Plan, PlanStep } from './types.js';
import { isDelegatedPlanStep } from './DelegationPolicy.js';

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
  const sample = [plan.reasoning, ...plan.steps.map((step) => step.description)].join('\n');
  const zhCN = resolveDisplayLocale(runtimeSettings().locale, sample) === 'zh-CN';
  const revisionHint = remaining > 0
    ? zhCN
      ? '你也可以提交一次修改意见来调整计划。'
      : 'You may also provide one change request to revise the plan.'
    : zhCN
      ? '计划已经修改过一次，请选择批准或拒绝。'
      : 'The plan has already been revised once; reply approve or reject.';
  return {
    id: crypto.randomUUID(),
    kind: 'plan_approval',
    question: [
      zhCN ? '请在执行前确认以下计划：' : 'Review the proposed plan before execution:',
      ...formatPlanSteps(plan.steps, 0, zhCN),
      '',
      zhCN
        ? `选择“批准执行”开始，或选择“拒绝”取消。${revisionHint}`
        : `Reply approve to execute, or reject to cancel. ${revisionHint}`,
    ].join('\n'),
    options: ['approve', 'reject'],
    createdAt: new Date().toISOString(),
    planReview: {
      revision,
      maxRevisions: MAX_PLAN_REVISIONS,
    },
  };
}

function formatPlanSteps(steps: PlanStep[], depth = 0, zhCN = false): string[] {
  return steps.flatMap((step) => {
    const indent = '  '.repeat(depth);
    const tool = step.toolName ? ` [${step.toolName}]` : '';
    const delegation = isDelegatedPlanStep(step)
      ? step.parallel
        ? zhCN ? ' [并行子 Agent]' : ' [parallel sub-agent]'
        : zhCN ? ' [子 Agent]' : ' [sub-agent]'
      : '';
    const checklist = (step.checklist ?? []).map((item) =>
      `${'  '.repeat(depth + 1)}${item.id}. ${item.description} ${
        zhCN ? '[内部检查]' : '[internal check]'
      }`
    );
    return [
      `${indent}${step.id}. ${step.description}${tool}${delegation}`,
      ...checklist,
      ...formatPlanSteps(step.children ?? [], depth + 1, zhCN),
    ];
  });
}
