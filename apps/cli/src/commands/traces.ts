import type { TraceEvent } from '@one-agent/agent-core';
import { shortId, formatDuration, dim, cyan } from '../format.js';

function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export function formatTraceEvent(event: TraceEvent, verbose = false): string {
  if (verbose) {
    const data = JSON.stringify(event.eventData);
    const preview = data.length > 200 ? `${data.slice(0, 200)}...` : data;
    return `${event.createdAt} [${event.eventType}] ${preview}`;
  }

  const eventData = event.eventData as Record<string, unknown>;
  let summary = '';

  switch (event.eventType) {
    case 'plan': {
      const plan = eventData.plan as { steps?: Array<{ description: string }> } | undefined;
      const steps = plan?.steps?.map((s) => s.description).join(' -> ') ?? '';
      summary = `plan: ${truncateWithEllipsis(steps, 80)}`;
      break;
    }
    case 'thought':
      summary = `thought: ${truncateWithEllipsis(String(eventData.content ?? ''), 80)}`;
      break;
    case 'tool_call': {
      const toolCall = eventData.toolCall as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const args = JSON.stringify(toolCall?.arguments ?? {});
      summary = `tool_call: ${toolCall?.name ?? '?'}(${truncateWithEllipsis(args, 80)})`;
      break;
    }
    case 'tool_result': {
      const toolResult = eventData.toolResult as { success?: boolean; error?: string } | undefined;
      summary = toolResult?.success === false
        ? `tool_result: failed - ${truncateWithEllipsis(toolResult.error ?? 'unknown', 80)}`
        : 'tool_result: ok';
      break;
    }
    case 'reflection':
      summary = `reflection: ${truncateWithEllipsis(String(eventData.content ?? ''), 80)}`;
      break;
    case 'message_delta':
      summary = `message_delta: ${truncateWithEllipsis(String(eventData.content ?? ''), 80)}`;
      break;
    case 'message':
      summary = `message: ${truncateWithEllipsis(String(eventData.content ?? ''), 80)}`;
      break;
    default:
      summary = `[${event.eventType}]`;
  }

  return `${dim(event.createdAt)} [${cyan(event.eventType)}] ${summary}`;
}

export function printTraces(events: TraceEvent[], options?: { limit?: number; verbose?: boolean }): void {
  const limit = options?.limit ?? 20;
  const verbose = options?.verbose ?? false;

  if (events.length === 0) {
    console.log('No traces found.');
    return;
  }

  const display = events.slice(-limit);
  if (events.length > limit && !verbose) {
    console.log(dim(`Showing last ${limit} of ${events.length} traces.`));
  }

  for (const event of display) {
    console.log(formatTraceEvent(event, verbose));
  }
}

export function printRunSummary(run: {
  id: string;
  status: string;
  startTime: string;
  endTime?: string | null;
  title?: string | null;
  model?: string | null;
}): void {
  const duration = run.endTime
    ? formatDuration(new Date(run.endTime).getTime() - new Date(run.startTime).getTime())
    : 'running';
  const title = run.title ?? '(no title)';
  console.log(`${shortId(run.id)}  ${run.status.padEnd(10)}  ${duration.padEnd(8)}  ${title}`);
}
