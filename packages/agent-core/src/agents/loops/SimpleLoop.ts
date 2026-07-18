import type { LoopInfrastructure, LoopStrategy } from './types.js';
import type { LoopResult, RunContext } from '../RunContext.js';
import {
  readUserInputRequest,
  REQUEST_USER_INPUT_TOOL_NAME,
} from '../requestUserInputTool.js';
import { safeParseArgs } from './utils.js';
import { ToolApprovalRequiredError } from '../../tools/policy.js';

/**
 * The direct tool loop: stream a completion, execute any tool calls, loop
 * until the model answers without tools (or the tool budget runs out — in
 * which case a tool-free wrap-up keeps partial findings instead of failing).
 */
export class SimpleLoop implements LoopStrategy {
  private readonly contextManager: LoopInfrastructure['contextManager'];
  private readonly modelCaller: LoopInfrastructure['modelCaller'];
  private readonly recorder: LoopInfrastructure['recorder'];
  private readonly toolRunner: LoopInfrastructure['toolRunner'];
  private readonly maxToolIterations: number;
  private readonly checkSignal: () => void;

  constructor(infra: LoopInfrastructure) {
    this.contextManager = infra.contextManager;
    this.modelCaller = infra.modelCaller;
    this.recorder = infra.recorder;
    this.toolRunner = infra.toolRunner;
    this.maxToolIterations = infra.maxToolIterations;
    this.checkSignal = infra.checkSignal;
  }

  async run(context: RunContext): Promise<LoopResult> {
    const { runId } = context;
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
        const inputCall = calls.find((call) => call.name === REQUEST_USER_INPUT_TOOL_NAME);
        if (!inputCall && context.strategy) {
          const trigger = {
            phase: 'before_tool_execution' as const,
            loop: 'simple' as const,
            toolIteration: toolIterations,
            toolCallNames: calls.map((call) => call.name),
            switchCount: context.strategy.switchCount,
          };
          const decision = context.strategy.controller.evaluate(trigger);
          if (decision.action === 'switch_to_planning') {
            return {
              status: 'switch_strategy',
              from: 'simple',
              to: 'planning',
              reason: decision.reason,
              trigger,
            };
          }
        }

        this.contextManager.addMessage({
          role: 'assistant',
          content,
          tool_calls: toolCalls,
          internal: true,
        });

        this.toolRunner.recordCalls(calls, { attempt: toolIterations });
        if (inputCall) {
          const result = await this.toolRunner.execute(inputCall, { runId, attempt: toolIterations });
          const inputRequest = readUserInputRequest(result);
          for (const skipped of calls.filter((call) => call.id !== inputCall.id)) {
            this.toolRunner.recordResult(skipped, {
              success: false,
              error: 'Skipped: the run is waiting for user input.',
            }, { attempt: toolIterations, status: 'skipped' });
          }
          if (inputRequest) {
            return {
              status: 'waiting_for_input',
              reply: inputRequest.question,
              inputRequest,
              checkpoint: {
                version: 1,
                updatedAt: new Date().toISOString(),
                originalMessage: context.message,
                loopMode: 'simple',
                recoveryCount: context.recovery
                  ? context.recovery.checkpoint.recoveryCount + 1
                  : 0,
                resumedFromRunId: context.recovery?.resumedFromRunId,
                pendingInput: inputRequest,
              },
            };
          }
          toolIterations++;
          continue;
        }

        try {
          this.toolRunner.preflight(calls, { attempt: toolIterations });
        } catch (error) {
          if (error instanceof ToolApprovalRequiredError) {
            this.toolRunner.recordResult(error.call, {
              success: false,
              data: { status: 'awaiting_approval', requestId: error.request.id },
            }, { attempt: toolIterations, status: 'awaiting_approval' });
            for (const skipped of calls.filter((call) => call.id !== error.call.id)) {
              this.toolRunner.recordResult(skipped, {
                success: false,
                error: 'Skipped: another tool call is waiting for approval.',
              }, { attempt: toolIterations, status: 'skipped' });
            }
          }
          throw error;
        }

        for (const call of calls) {
          await this.toolRunner.execute(call, { runId, attempt: toolIterations });
        }

        toolIterations++;
        continue;
      }

      // No tool calls: the answer was already streamed live above.
      this.contextManager.addMessage({ role: 'assistant', content });
      this.recorder.record({ type: 'message', content });
      return { status: 'completed', reply: content };
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
    return { status: 'completed', reply: content };
  }

}
