import fs from 'node:fs';
import type { AgentEvent } from '../agents/events.js';
import type { Plan, PlanStep } from '../planning/types.js';
import type { Sandbox } from '../tools/sandbox.js';
import type { ToolCall, ToolResult } from '../tools/types.js';
import type {
  CompletionEvidence,
  CompletionOutcome,
  CompletionRequirement,
  CompletionVerifier,
  CompletionVerificationInput,
} from './types.js';

export interface EvidenceCompletionVerifierOptions {
  /** Enables deterministic existence checks for explicitly named deliverables. */
  sandbox?: Sandbox;
  /** Caller-supplied, deterministic goal acceptance conditions. */
  requirements?: CompletionRequirement[];
}

interface ToolExecution {
  call?: ToolCall;
  result: ToolResult;
}

const DELIVERABLE_PATTERNS = [
  /(?:写入|写到|写成|写(?:一个|个)?|生成|创建|保存到|保存为|输出到|整理成|汇总成|产出)(?:[^。；;\n]{0,50}?)([a-zA-Z0-9_.\/-]+\.[a-zA-Z0-9]{1,12})/gi,
  /(?:write|create|generate|save|output|produce)(?:[^.;\n]{0,50}?)([a-zA-Z0-9_.\/-]+\.[a-zA-Z0-9]{1,12})/gi,
];

const MUTATION_INTENT_PATTERN =
  /(?:写入|写到|生成|创建|保存|输出|整理|汇总|修改|更新|修复|迁移|删除|移动|重命名|替换|改一下|跑到成功|write|create|generate|save|output|produce|modify|update|fix|migrate|delete|move|rename|replace|build)/i;

const SELF_REPORTED_INCOMPLETE_PATTERNS = [
  /(?:并未|尚未|还未|没有|无法|未)(?:真正)?完成/i,
  /(?:未创建|未生成|未写入|未修改|未更新|未迁移|未修复)/i,
  /仍(?:然)?(?:失败|报错|未解决)/i,
  /需要(?:重新|继续).{0,30}(?:完成|执行|修复|修改|转换|迁移)/i,
  /\b(?:incomplete|not completed|not finished|could not complete|still fails?|still failing)\b/i,
];

const MUTATING_COMMAND_PATTERN =
  /(?:^|[;&|]\s*|\b)(?:cp|mv|rm|mkdir|touch|install|patch|tee|sed\s+-i|perl\s+-i|sh|bash|python\d*|node|npm|pnpm|yarn)\b/i;

/**
 * Evidence-first completion policy. It never asks a model whether its own
 * answer is correct: only observable tool results, plan state and workspace
 * artifacts can produce a verified outcome.
 */
export class EvidenceCompletionVerifier implements CompletionVerifier {
  constructor(private readonly options: EvidenceCompletionVerifierOptions = {}) {}

  async verify(input: CompletionVerificationInput): Promise<CompletionOutcome> {
    const evidence: CompletionEvidence[] = [];
    const executions = this.collectToolExecutions(input.events);
    const successfulTools = executions.filter((item) => item.result.success);
    const hasUnresolvedToolFailure = executions.some(
      (execution, index) =>
        !execution.result.success &&
        !executions
          .slice(index + 1)
          .some(
            (later) =>
              later.result.success && this.recoveryKey(later.call) === this.recoveryKey(execution.call),
          ),
    );

    for (const execution of executions) {
      evidence.push({
        kind: 'tool',
        description: execution.call
          ? `${execution.call.name} ${execution.result.success ? 'succeeded' : 'failed'}`
          : `Tool execution ${execution.result.success ? 'succeeded' : 'failed'}`,
        success: execution.result.success,
        toolName: execution.call?.name,
      });
    }

    const plan = this.latestPlan(input.events);
    const planSteps = plan ? this.flattenSteps(plan.steps) : [];
    const incompleteSteps = planSteps.filter((step) => step.status !== 'completed');
    for (const step of planSteps) {
      evidence.push({
        kind: 'plan',
        description: `Plan step ${step.id}: ${step.description} (${step.status})`,
        success: step.status === 'completed',
      });
    }

    const deliverables = this.extractDeliverables(input.request);
    for (const execution of executions) {
      if (execution.call?.name === 'write_file') {
        const path = execution.call.arguments.path;
        if (typeof path === 'string') deliverables.push(path);
      }
    }
    const uniqueDeliverables = [...new Set(deliverables)];
    const missingDeliverables: string[] = [];
    for (const deliverable of uniqueDeliverables) {
      const exists = this.artifactExists(deliverable);
      if (exists === undefined) continue;
      evidence.push({
        kind: 'artifact',
        description: exists
          ? `Expected artifact exists: ${deliverable}`
          : `Expected artifact is missing: ${deliverable}`,
        success: exists,
        path: deliverable,
      });
      if (!exists) missingDeliverables.push(deliverable);
    }

    const failedRequirements = this.evaluateRequirements(input.reply, evidence);

    if (!input.reply.trim()) {
      evidence.push({ kind: 'response', description: 'Final response is empty', success: false });
      return {
        status: successfulTools.length > 0 ? 'partial' : 'failed',
        reason: 'The run produced no final response.',
        evidence,
      };
    }

    if (SELF_REPORTED_INCOMPLETE_PATTERNS.some((pattern) => pattern.test(input.reply))) {
      evidence.push({
        kind: 'response',
        description: 'The final response explicitly reports incomplete or failed work',
        success: false,
      });
      return {
        status: successfulTools.length > 0 ? 'partial' : 'failed',
        reason: 'The agent explicitly reported that the requested work is incomplete.',
        evidence,
      };
    }

    if (failedRequirements.length > 0) {
      return {
        status: successfulTools.length > 0 ? 'partial' : 'unverified',
        reason: `Completion contract was not satisfied: ${failedRequirements.join('; ')}.`,
        evidence,
      };
    }

    if (missingDeliverables.length > 0) {
      return {
        status: successfulTools.length > 0 ? 'partial' : 'unverified',
        reason: `Explicit deliverables were not found: ${missingDeliverables.join(', ')}.`,
        evidence,
      };
    }

    if (hasUnresolvedToolFailure || incompleteSteps.length > 0) {
      const hasProgress = successfulTools.length > 0 || planSteps.some((step) => step.status === 'completed');
      const blocked = input.events.some(
        (event) =>
          event.type === 'reflection' &&
          /missing_info|cannot proceed|缺少必要|无法继续/i.test(event.content),
      );
      return {
        status: blocked ? 'blocked' : hasProgress ? 'partial' : 'failed',
        reason: blocked
          ? 'Execution cannot continue without required information.'
          : 'One or more execution steps lack successful evidence.',
        evidence,
      };
    }

    const mutationRequested = MUTATION_INTENT_PATTERN.test(input.request);
    const successfulMutations = successfulTools.filter((execution) =>
      this.isMutationExecution(execution.call),
    );
    if (mutationRequested && successfulMutations.length === 0) {
      return {
        status: successfulTools.length > 0 ? 'partial' : 'unverified',
        reason: 'The request changes workspace state, but no successful mutation was observed.',
        evidence,
      };
    }

    const checkedArtifacts = evidence.filter((item) => item.kind === 'artifact');
    if (checkedArtifacts.length > 0 || successfulTools.length > 0) {
      return {
        status: 'verified',
        reason:
          checkedArtifacts.length > 0
            ? 'The explicit deliverables exist and no execution failure was observed.'
            : 'All observed tool executions succeeded and no incomplete plan step remains.',
        evidence,
      };
    }

    evidence.push({
      kind: 'response',
      description: 'A model response was produced without independent execution evidence',
      success: true,
    });
    return {
      status: 'unverified',
      reason: 'The response completed, but the runtime has no independent evidence that its claims are correct.',
      evidence,
    };
  }

  private collectToolExecutions(events: AgentEvent[]): ToolExecution[] {
    const executions: ToolExecution[] = [];
    const pending: ToolCall[] = [];

    const visit = (event: AgentEvent) => {
      if (event.type === 'tool_call') {
        pending.push(event.toolCall);
      } else if (event.type === 'tool_result') {
        const matchedIndex = event.toolCallId
          ? pending.findIndex((call) => call.id === event.toolCallId)
          : 0;
        const call = matchedIndex >= 0 ? pending.splice(matchedIndex, 1)[0] : undefined;
        executions.push({ call, result: event.toolResult });
      } else if (event.type === 'sub_agent' && event.events) {
        for (const nested of event.events) visit(nested);
      }
    };

    for (const event of events) visit(event);
    for (const call of pending) {
      executions.push({
        call,
        result: { success: false, error: 'No tool result was observed for this call.' },
      });
    }
    return executions;
  }

  private recoveryKey(call?: ToolCall): string {
    if (!call) return 'unknown';
    const path = call.arguments.path;
    return (call.name === 'write_file' || call.name === 'delete_file') && typeof path === 'string'
      ? `${call.name}:${path}`
      : call.name;
  }

  private isMutationExecution(call?: ToolCall): boolean {
    if (!call) return false;
    if (call.name === 'write_file' || call.name === 'delete_file') return true;
    if (call.name !== 'run_command') return false;
    const command = call.arguments.command;
    return typeof command === 'string' && MUTATING_COMMAND_PATTERN.test(command);
  }

  private latestPlan(events: AgentEvent[]): Plan | undefined {
    const plans = events.filter(
      (event): event is { type: 'plan'; plan: Plan } => event.type === 'plan',
    );
    return plans.at(-1)?.plan;
  }

  private flattenSteps(steps: PlanStep[]): PlanStep[] {
    return steps.flatMap((step) => [step, ...(step.children ? this.flattenSteps(step.children) : [])]);
  }

  private extractDeliverables(request: string): string[] {
    const deliverables = new Set<string>();
    for (const pattern of DELIVERABLE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of request.matchAll(pattern)) {
        const candidate = match[1]?.replace(/^workspace\//i, '').replace(/^\.\//, '');
        if (candidate) deliverables.add(candidate);
      }
    }
    return [...deliverables];
  }

  private artifactExists(relativePath: string): boolean | undefined {
    if (!this.options.sandbox) return undefined;
    try {
      return fs.existsSync(this.options.sandbox.resolve(relativePath));
    } catch {
      return false;
    }
  }

  private evaluateRequirements(reply: string, evidence: CompletionEvidence[]): string[] {
    const failures: string[] = [];
    for (const requirement of this.options.requirements ?? []) {
      if (requirement.kind === 'response') {
        const normalized = reply.toLowerCase();
        const success =
          (!requirement.containsAny?.length ||
            requirement.containsAny.some((value) => normalized.includes(value.toLowerCase()))) &&
          (!requirement.containsAll?.length ||
            requirement.containsAll.every((value) => normalized.includes(value.toLowerCase()))) &&
          (!requirement.notContains?.length ||
            requirement.notContains.every((value) => !normalized.includes(value.toLowerCase())));
        evidence.push({
          kind: 'response',
          description: success
            ? 'Final response satisfies its completion contract'
            : 'Final response does not satisfy its completion contract',
          success,
        });
        if (!success) failures.push('final response');
        continue;
      }

      const shouldExist = requirement.shouldExist ?? true;
      const exists = this.artifactExists(requirement.path);
      if (exists === undefined) {
        evidence.push({
          kind: 'artifact',
          description: `Artifact requirement could not be checked: ${requirement.path}`,
          success: false,
          path: requirement.path,
        });
        failures.push(`${requirement.path} could not be checked`);
        continue;
      }

      let success = exists === shouldExist;
      if (success && exists && (requirement.containsAll?.length || requirement.notContains?.length)) {
        try {
          const content = fs
            .readFileSync(this.options.sandbox!.resolve(requirement.path), 'utf-8')
            .toLowerCase();
          success =
            (requirement.containsAll ?? []).every((value) =>
              content.includes(value.toLowerCase()),
            ) &&
            (requirement.notContains ?? []).every(
              (value) => !content.includes(value.toLowerCase()),
            );
        } catch {
          success = false;
        }
      }
      evidence.push({
        kind: 'artifact',
        description: success
          ? `Artifact satisfies completion contract: ${requirement.path}`
          : `Artifact violates completion contract: ${requirement.path}`,
        success,
        path: requirement.path,
      });
      if (!success) failures.push(requirement.path);
    }
    return failures;
  }
}
