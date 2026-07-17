import { ToolResult } from '../../tools/types.js';
import type { AgentLoopEvent } from '../AgentLoop.js';
import type { LoopInfrastructure, LoopRunInput, LoopStrategy } from './types.js';
import { safeParseArgs } from './utils.js';

/**
 * The direct tool loop: stream a completion, execute any tool calls, loop
 * until the model answers without tools (or the tool budget runs out — in
 * which case a tool-free wrap-up keeps partial findings instead of failing).
 */
export class SimpleLoop implements LoopStrategy {
  private readonly contextManager: LoopInfrastructure['contextManager'];
  private readonly modelCaller: LoopInfrastructure['modelCaller'];
  private readonly recorder: LoopInfrastructure['recorder'];
  private readonly toolExecutor: LoopInfrastructure['toolExecutor'];
  private readonly maxToolIterations: number;
  private readonly checkSignal: () => void;
  private readonly persistToolCall: LoopInfrastructure['persistToolCall'];

  constructor(infra: LoopInfrastructure) {
    this.contextManager = infra.contextManager;
    this.modelCaller = infra.modelCaller;
    this.recorder = infra.recorder;
    this.toolExecutor = infra.toolExecutor;
    this.maxToolIterations = infra.maxToolIterations;
    this.checkSignal = infra.checkSignal;
    this.persistToolCall = infra.persistToolCall;
  }

  async run(input: LoopRunInput): Promise<{ reply: string }> {
    const { runId } = input;
    let toolIterations = 0;

    while (toolIterations <= this.maxToolIterations) {
      this.checkSignal();
      // A single streaming completion serves two purposes at once: it streams
      // the answer text to the client token-by-token (message_delta events)
      // and accumulates any tool-call deltas. If tool calls arrive we execute
      // them and loop; otherwise the text already reached the user live and we
      // just record the final message. No separate "probe" round-trip.
      const { content, toolCalls } = await this.modelCaller.completeStreaming();

      if (toolCalls && toolCalls.length > 0) {
        const calls = toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseArgs(tc.function.arguments),
        }));

        this.contextManager.addMessage({
          role: 'assistant',
          content,
          tool_calls: toolCalls,
          internal: true,
        });

        for (const call of calls) {
          this.recorder.record({ type: 'tool_call', toolCall: call, attempt: toolIterations });
          const toolStartedAt = Date.now();

          if (!this.toolExecutor) {
            const result: ToolResult = {
              success: false,
              error: 'No tool executor available',
            };
            this.recorder.record({
              type: 'tool_result', toolResult: result, toolCallId: call.id,
              attempt: toolIterations, status: 'failed', durationMs: Date.now() - toolStartedAt,
            });
            this.contextManager.addMessage({
              role: 'tool',
              content: JSON.stringify(result),
              tool_call_id: call.id,
              internal: true,
            });
            this.persistToolCall(runId, call, result);
            continue;
          }

          const result = await this.toolExecutor.execute(call);
          this.recorder.record({
            type: 'tool_result', toolResult: result, toolCallId: call.id,
            attempt: toolIterations, status: result.success ? 'succeeded' : 'failed',
            durationMs: Date.now() - toolStartedAt,
          });
          this.contextManager.addMessage({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: call.id,
            internal: true,
          });
          this.persistToolCall(runId, call, result);
        }

        toolIterations++;
        continue;
      }

      // No tool calls: the answer was already streamed live above.
      this.contextManager.addMessage({ role: 'assistant', content });
      this.recorder.record({ type: 'message', content });
      return { reply: content };
    }

    // Tool budget exhausted: rather than throwing away everything the loop
    // has gathered, give the model one tool-free wrap-up call so partial
    // findings still reach the caller — crucial for sub-agents, whose parent
    // would otherwise receive only a bare error. A failing wrap-up call
    // propagates as before.
    this.contextManager.addMessage({
      role: 'user',
      content:
        'The tool-call budget for this turn is exhausted. Based on the work done so far, ' +
        'give your final answer or a summary of partial findings now. Do not call any more tools.',
      internal: true,
    });
    const { content } = await this.modelCaller.completeStreaming({ includeTools: false });
    this.contextManager.addMessage({ role: 'assistant', content });
    this.recorder.record({ type: 'message', content });
    return { reply: content };
  }

}
