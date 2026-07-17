import type { ModelProvider, TokenUsage } from '../model/types.js';
import type { ToolCall } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentLoop } from './AgentLoop.js';
import type { AgentLoopEvent } from './AgentLoop.js';

export interface SubAgentTask {
  /** What the sub-agent should accomplish. */
  task: string;
  /** The parent goal this task contributes to, for orientation. */
  context?: string;
  /** What a successful outcome looks like. */
  expectedOutcome?: string;
  /** Restrict the sub-agent to these tool names (default: all inherited tools). */
  allowedTools?: string[];
  /** Plan step id for trace correlation. */
  stepId?: string;
  /** Per-run memory override (defaults to the runner-level memoryText). */
  memoryText?: string;
}

export interface SubAgentResult {
  success: boolean;
  reply: string;
  error?: string;
  toolCalls: ToolCall[];
  tokenUsage?: TokenUsage;
  durationMs: number;
  /**
   * The sub-agent's condensed internal event stream (streaming deltas
   * stripped). Persisted by the parent as part of the sub_agent trace event
   * so the sub-agent is no longer a black box. Partial on failure.
   */
  events: AgentLoopEvent[];
}

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
  private readonly memoryText?: string;
  private readonly signal?: () => AbortSignal | undefined;
  private readonly maxToolIterations?: number;

  constructor(options: SubAgentRunnerOptions) {
    this.tools = options.tools;
    this.modelProvider = options.modelProvider;
    this.memoryText = options.memoryText;
    this.signal = options.signal;
    this.maxToolIterations = options.maxToolIterations;
  }

  async run(task: SubAgentTask): Promise<SubAgentResult> {
    const startedAt = Date.now();
    const registry = new ToolRegistry();
    const inherited = task.allowedTools
      ? this.tools.list().filter((tool) => task.allowedTools!.includes(tool.name))
      : this.tools.list();
    registry.registerMany(inherited);

    const subAgent = new AgentLoop({
      tools: registry,
      modelProvider: this.modelProvider,
      maxToolIterations: this.maxToolIterations,
      enablePlanning: false,
      // depth=1 with the default max of 1: this loop cannot spawn further agents.
      subAgentDepth: 1,
      systemPrompt:
        'You are a sub-task execution agent. Complete the given sub-task with the ' +
        'available tools, then reply with a concise result summary. Do not ask ' +
        'follow-up questions; make reasonable assumptions and finish the task.',
      signal: this.signal?.(),
    });

    const memoryText = task.memoryText ?? this.memoryText;
    const prompt = [
      task.context ? `Overall goal: ${task.context}` : '',
      `Your sub-task: ${task.task}`,
      task.expectedOutcome ? `Expected outcome: ${task.expectedOutcome}` : '',
      memoryText ? `Relevant context from past conversations:\n${memoryText}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // Collect via the emitter rather than chat()'s return value so a failed
    // run still yields the partial event stream up to the error.
    const collected: AgentLoopEvent[] = [];
    subAgent.on('event', (event) => collected.push(event));

    try {
      const result = await subAgent.chat(prompt);
      const toolCalls = result.events
        .filter((e): e is { type: 'tool_call'; toolCall: ToolCall } => e.type === 'tool_call')
        .map((e) => e.toolCall);
      return {
        success: true,
        reply: result.reply,
        toolCalls,
        tokenUsage: result.tokenUsage,
        durationMs: Date.now() - startedAt,
        events: condenseEvents(collected),
      };
    } catch (error) {
      return {
        success: false,
        reply: '',
        error: error instanceof Error ? error.message : String(error),
        toolCalls: [],
        durationMs: Date.now() - startedAt,
        events: condenseEvents(collected),
      };
    }
  }
}

/**
 * Strip streaming deltas from a sub-agent's event stream: the final message
 * event already carries the full reply text, so delta chunks are pure noise
 * in a persisted trace.
 */
function condenseEvents(events: AgentLoopEvent[]): AgentLoopEvent[] {
  return events.filter((e) => e.type !== 'message_delta' && e.type !== 'reasoning_delta');
}
