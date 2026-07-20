import type { ModelProvider, TokenUsage } from '../model/types.js';
import type { ToolCall } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { MANAGE_MEMORY_TOOL_NAME } from '../memory/manageMemoryTool.js';
import { REQUEST_USER_INPUT_TOOL_NAME } from './requestUserInputTool.js';
import { AgentLoop } from './AgentLoop.js';
import type { AgentEvent } from './events.js';
import {
  buildSubAgentEvidencePacket,
  type SubAgentEvidencePacket,
  type SubAgentTaskContract,
} from './SubAgentContract.js';

export interface SubAgentTask extends SubAgentTaskContract {
  /** Plan step id for trace correlation. */
  stepId?: string;
  /** Per-run memory override (defaults to the runner-level memoryText). */
  memoryText?: string;
}

export interface SubAgentResult {
  /** Whether the isolated execution loop itself ended normally. */
  executionStatus: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'budget_exhausted';
  /** A completed execution reports an outcome; the parent still decides whether it satisfies the goal. */
  outcomeStatus: 'unverified' | 'unavailable';
  /** Structured parent-facing conclusion, provenance and known gaps. */
  evidencePacket: SubAgentEvidencePacket;
  /** @deprecated Read evidencePacket.conclusion instead. */
  summary: string;
  error?: string;
  toolCalls: ToolCall[];
  tokenUsage?: TokenUsage;
  durationMs: number;
  /**
   * The sub-agent's condensed internal event stream (streaming deltas
   * stripped). Persisted by the parent as part of the sub_agent trace event
   * so the sub-agent is no longer a black box. Partial on failure.
   */
  events: AgentEvent[];
}

export interface DelegationBudget {
  /** Maximum accepted sub-tasks in one parent Run. */
  maxTasksPerRun: number;
  /** Maximum sub-agents executing at the same time. */
  maxConcurrency: number;
  /** Stop accepting new sub-tasks after observed usage reaches this total. */
  maxTotalTokens: number;
  /** Wall-clock execution timeout after a sub-agent acquires a slot. */
  taskTimeoutMs: number;
  /** Tool-loop limit for each sub-agent. */
  maxToolIterations: number;
}

export const DEFAULT_DELEGATION_BUDGET: Readonly<DelegationBudget> = Object.freeze({
  maxTasksPerRun: 8,
  maxConcurrency: 4,
  maxTotalTokens: 50_000,
  taskTimeoutMs: 60_000,
  maxToolIterations: 5,
});

export interface SubAgentRunnerOptions {
  /** The parent's tool registry; each run filters it down per task. */
  tools: ToolRegistry;
  /**
   * Model for the sub-agent. The caller resolves the default — the utility
   * model when configured, otherwise the parent's provider.
   */
  modelProvider?: ModelProvider;
  /** Long-term memory text inherited from the parent conversation. */
  memoryText?: string;
  /** Getter so per-call abort signals propagate into running sub-agents. */
  signal?: () => AbortSignal | undefined;
  /** Per-parent-Run resource limits. */
  budget?: Partial<DelegationBudget>;
  /** @deprecated Set budget.maxToolIterations instead. */
  maxToolIterations?: number;
}

/**
 * Executes one-shot subtasks in an isolated AgentLoop: fresh context, a
 * filtered tool registry, and no spawn_agent of its own (so recursion is
 * impossible by construction). The sub-agent runs the simple loop — no
 * planning, no thread persistence — and only its condensed result travels
 * back to the parent.
 */
export class SubAgentRunner {
  private readonly tools: ToolRegistry;
  private readonly modelProvider?: ModelProvider;
  private readonly defaultMemoryText?: string;
  private runMemoryText?: string;
  private readonly signal?: () => AbortSignal | undefined;
  private readonly budget: Readonly<DelegationBudget>;
  private acceptedTasks = 0;
  private observedTokens = 0;
  private activeTasks = 0;
  private readonly slotWaiters: Array<() => void> = [];

  constructor(options: SubAgentRunnerOptions) {
    this.tools = options.tools;
    this.modelProvider = options.modelProvider;
    this.defaultMemoryText = options.memoryText;
    this.signal = options.signal;
    this.budget = Object.freeze({
      ...DEFAULT_DELEGATION_BUDGET,
      ...options.budget,
      ...(options.maxToolIterations === undefined
        ? {}
        : { maxToolIterations: options.maxToolIterations }),
    });
    this.validateBudget();
  }

  /** Start accounting for a new parent Run. Active work must never cross this boundary. */
  resetBudget(): void {
    if (this.activeTasks > 0 || this.slotWaiters.length > 0) {
      throw new Error('Cannot reset delegation budget while sub-agents are active');
    }
    this.acceptedTasks = 0;
    this.observedTokens = 0;
    this.runMemoryText = undefined;
  }

  /** Inject the parent-selected memory snapshot for the current Run only. */
  setRunMemoryText(memoryText?: string): void {
    this.runMemoryText = memoryText;
  }

  async run(task: SubAgentTask): Promise<SubAgentResult> {
    const startedAt = Date.now();
    const budgetFailure = this.reserveTask(startedAt);
    if (budgetFailure) return budgetFailure;

    await this.acquireSlot();
    const parentSignal = this.signal?.();
    if (parentSignal?.aborted) {
      this.releaseSlot();
      return this.unavailableResult(
        'cancelled',
        'Parent Run was cancelled before the sub-agent started',
        startedAt,
      );
    }

    const taskSignal = new AbortController();
    let timedOut = false;
    const cancelFromParent = () => taskSignal.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', cancelFromParent, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      taskSignal.abort(new Error(`Sub-agent exceeded ${this.budget.taskTimeoutMs}ms execution timeout`));
    }, this.budget.taskTimeoutMs);

    const registry = new ToolRegistry();
    const inherited = this.tools.list().filter((tool) =>
      tool.readOnly === true &&
      tool.name !== MANAGE_MEMORY_TOOL_NAME &&
      tool.name !== REQUEST_USER_INPUT_TOOL_NAME &&
      (!task.allowedTools || task.allowedTools.includes(tool.name)),
    );
    registry.registerMany(inherited);

    const subAgent = new AgentLoop({
      tools: registry,
      modelProvider: this.modelProvider,
      maxToolIterations: this.budget.maxToolIterations,
      enablePlanning: false,
      // depth=1 with the default max of 1: this loop cannot spawn further agents.
      subAgentDepth: 1,
      systemPrompt:
        'You are a read-only sub-task execution agent. Investigate the given sub-task with the ' +
        'available tools, then report a concise conclusion. Distinguish tool-supported facts from ' +
        'assumptions, and state uncertainty or unresolved questions. Do not claim ' +
        'that the parent task is complete. Do not ask ' +
        'follow-up questions; make reasonable assumptions and finish the task.',
      signal: taskSignal.signal,
    });

    const memoryText = task.memoryText ?? this.runMemoryText ?? this.defaultMemoryText;
    const prompt = [
      task.context ? `Overall goal: ${task.context}` : '',
      `Your sub-task: ${task.task}`,
      task.constraints?.length ? `Constraints:\n- ${task.constraints.join('\n- ')}` : '',
      task.expectedOutcome ? `Expected outcome: ${task.expectedOutcome}` : '',
      task.expectedEvidence?.length
        ? `Requested evidence:\n- ${task.expectedEvidence.join('\n- ')}`
        : '',
      memoryText ? `Relevant context from past conversations:\n${memoryText}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // Collect via the emitter rather than chat()'s return value so a failed
    // run still yields the partial event stream up to the error.
    const collected: AgentEvent[] = [];
    subAgent.on('event', (event) => collected.push(event));

    try {
      const result = await subAgent.chat(prompt);
      const toolCalls = result.events
        .filter((e): e is { type: 'tool_call'; toolCall: ToolCall } => e.type === 'tool_call')
        .map((e) => e.toolCall);
      const output: SubAgentResult = {
        executionStatus: 'completed',
        outcomeStatus: 'unverified',
        evidencePacket: buildSubAgentEvidencePacket(task, result.reply, collected),
        summary: result.reply,
        toolCalls,
        tokenUsage: result.tokenUsage,
        durationMs: Date.now() - startedAt,
        events: condenseEvents(collected),
      };
      this.observedTokens += output.tokenUsage?.totalTokens ?? 0;
      return output;
    } catch (error) {
      const tokenUsage = usageFromEvents(collected);
      this.observedTokens += tokenUsage?.totalTokens ?? 0;
      return this.unavailableResult(
        timedOut ? 'timed_out' : taskSignal.signal.aborted ? 'cancelled' : 'failed',
        timedOut
          ? `Sub-agent exceeded ${this.budget.taskTimeoutMs}ms execution timeout`
          : error instanceof Error ? error.message : String(error),
        startedAt,
        condenseEvents(collected),
        tokenUsage,
      );
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', cancelFromParent);
      this.releaseSlot();
    }
  }

  private reserveTask(startedAt: number): SubAgentResult | undefined {
    if (this.acceptedTasks >= this.budget.maxTasksPerRun) {
      return this.unavailableResult(
        'budget_exhausted',
        `Sub-agent delegation budget exhausted: maximum ${this.budget.maxTasksPerRun} tasks per Run`,
        startedAt,
      );
    }
    if (this.observedTokens >= this.budget.maxTotalTokens) {
      return this.unavailableResult(
        'budget_exhausted',
        `Sub-agent delegation budget exhausted: observed ${this.observedTokens} tokens ` +
          `reached the ${this.budget.maxTotalTokens} token limit`,
        startedAt,
      );
    }
    this.acceptedTasks++;
    return undefined;
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeTasks < this.budget.maxConcurrency) {
      this.activeTasks++;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.activeTasks--;
  }

  private unavailableResult(
    executionStatus: Exclude<SubAgentResult['executionStatus'], 'completed'>,
    error: string,
    startedAt: number,
    events: AgentEvent[] = [],
    tokenUsage?: TokenUsage,
  ): SubAgentResult {
    return {
      executionStatus,
      outcomeStatus: 'unavailable',
      evidencePacket: {
        conclusion: '',
        evidence: [],
        uncertainty: [error],
        unresolvedQuestions: [],
      },
      summary: '',
      error,
      toolCalls: [],
      tokenUsage,
      durationMs: Date.now() - startedAt,
      events,
    };
  }

  private validateBudget(): void {
    for (const [name, value] of Object.entries(this.budget)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Delegation budget ${name} must be a positive integer; received ${value}`);
      }
    }
  }
}

/**
 * Strip streaming deltas from a sub-agent's event stream: the final message
 * event already carries the full reply text, so delta chunks are pure noise
 * in a persisted trace.
 */
function condenseEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type !== 'message_delta' && e.type !== 'reasoning_delta');
}

function usageFromEvents(events: AgentEvent[]): TokenUsage | undefined {
  const usages = events
    .filter((event) => event.type === 'model_call' && event.phase === 'completed' && event.usage)
    .map((event) => event.type === 'model_call' ? event.usage! : undefined)
    .filter((usage): usage is TokenUsage => usage !== undefined);
  if (usages.length === 0) return undefined;
  return usages.reduce<TokenUsage>((total, usage) => ({
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
}
