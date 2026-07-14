import type { AgentLoopEvent } from '@one-agent/agent-core';
import { sanitizeTerminalText } from './output.js';

function formatToolResultSummary(toolResult: {
  success: boolean;
  data?: unknown;
  error?: string;
}): string {
  if (!toolResult.success) {
    return toolResult.error ?? 'failed';
  }
  const data = toolResult.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    return 'ok';
  }
  if (typeof data.results === 'object' && Array.isArray(data.results)) {
    const count = data.results.length;
    return count > 0 ? `found ${count} result(s)` : 'no results';
  }
  return 'ok';
}

export interface ProgressIndicator {
  setLabel: (label: string) => void;
  stop: () => void;
}

export interface ChatTimeline {
  /** Called with each live token from message_delta events. */
  onDelta: (text: string) => void;
  /** Called with dimmed reasoning tokens (chain of thought). */
  onReasoning: (text: string) => void;
  /** Called for tool_call/tool_result/thought/reflection (verbose only for some). */
  onInfo: (text: string) => void;
  /** Progress indicator to drive labels and stop. */
  progress: ProgressIndicator;
  verbose: boolean;
}

export interface ChatTimelineResult {
  streamedContent: string;
  hasStreamedLive: boolean;
  firstDeltaTime: number;
  toolStartTime: number;
  toolEndTime: number;
  answerStartTime: number;
  answerEndTime: number;
}

/**
 * Build an event handler that prints tokens live as they arrive.
 * Returns the handler plus a mutable result object capturing timing and
 * streamed content for end-of-turn formatting.
 */
export function createChatEventHandler(timeline: ChatTimeline): {
  handler: (event: AgentLoopEvent) => void;
  result: ChatTimelineResult;
} {
  const result: ChatTimelineResult = {
    streamedContent: '',
    hasStreamedLive: false,
    firstDeltaTime: 0,
    toolStartTime: 0,
    toolEndTime: 0,
    answerStartTime: 0,
    answerEndTime: 0,
  };

  const handler = (event: AgentLoopEvent) => {
    if (event.type === 'plan') {
      timeline.progress.setLabel('Working');
      if (timeline.verbose) {
        timeline.onInfo(`\n[plan] ${event.plan.steps.map((s) => s.description).join(' -> ')}\n`);
      }
    } else if (event.type === 'tool_call') {
      timeline.progress.setLabel('Working');
      if (result.toolStartTime === 0) result.toolStartTime = Date.now();
      timeline.onInfo(`\n[tool_call] ${event.toolCall.name}\n`);
    } else if (event.type === 'tool_result') {
      const summary = formatToolResultSummary(event.toolResult);
      result.toolEndTime = Date.now();
      timeline.onInfo(`[tool_result] ${summary}\n`);
    } else if (event.type === 'thought' && timeline.verbose) {
      timeline.onInfo(`\n[thought] ${event.content.slice(0, 120)}\n`);
    } else if (event.type === 'reflection') {
      timeline.progress.setLabel('Re-planning');
      if (timeline.verbose) {
        timeline.onInfo(`\n[reflection] ${event.content.slice(0, 120)}\n`);
      }
    } else if (event.type === 'reasoning_delta') {
      // In verbose mode, show reasoning live (dimmed) so the user can follow
      // the model's thinking. In normal mode, skip it entirely - the spinner
      // provides enough feedback that the model is working, and the final
      // answer appears as one clean continuous block.
      if (timeline.verbose) {
        const cleanContent = sanitizeTerminalText(event.content);
        if (cleanContent) {
          timeline.progress.stop();
          timeline.onReasoning(cleanContent);
        }
      }
    } else if (event.type === 'message_delta') {
      const cleanContent = sanitizeTerminalText(event.content);
      if (!cleanContent.trim()) {
        // Whitespace-only or empty delta: ignore for live output and timing.
        return;
      }
      if (result.firstDeltaTime === 0) result.firstDeltaTime = Date.now();
      if (result.answerStartTime === 0) result.answerStartTime = Date.now();
      result.answerEndTime = Date.now();
      timeline.progress.setLabel('Answering');
      timeline.progress.stop();
      result.hasStreamedLive = true;
      timeline.onDelta(cleanContent);
      result.streamedContent += cleanContent;
    } else if (event.type === 'message') {
      if (result.answerEndTime === 0) result.answerEndTime = Date.now();
      if (result.streamedContent.length === 0 && event.content) {
        result.streamedContent = sanitizeTerminalText(event.content);
      }
    }
  };

  return { handler, result };
}