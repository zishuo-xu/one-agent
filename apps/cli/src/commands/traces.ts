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
    case 'reasoning_delta':
      summary = `reasoning_delta: ${truncateWithEllipsis(String(eventData.content ?? ''), 80)}`;
      break;
    case 'sub_agent': {
      const status = String(eventData.status ?? '?');
      const task = truncateWithEllipsis(String(eventData.task ?? ''), 60);
      summary = `sub_agent ${status}: ${task}`;
      break;
    }
    case 'memory_recall': {
      const selected = Number(eventData.selectedCount ?? 0);
      const candidates = Number(eventData.candidateCount ?? 0);
      const tokens = Number(eventData.estimatedTokens ?? 0);
      const reason = eventData.skipReason ? ` · ${String(eventData.skipReason)}` : '';
      const error = eventData.error ? ` · failed: ${String(eventData.error)}` : '';
      summary = `memory_recall: ${selected}/${candidates} selected · ~${tokens} tokens${reason}${error}`;
      break;
    }
    case 'message':
      summary = `message: ${truncateWithEllipsis(String(eventData.content ?? ''), 80)}`;
      break;
    default:
      summary = `[${event.eventType}]`;
  }

  return `${dim(event.createdAt)} [${cyan(event.eventType)}] ${summary}`;
}

export function printTraces(events: TraceEvent[], options?: { limit?: number; verbose?: boolean }): void {
  // Verbose lifts the default cap entirely; `?? 20` must not re-apply it.
  const limit = options?.limit ?? (options?.verbose ? Number.MAX_SAFE_INTEGER : 20);
  const verbose = options?.verbose ?? false;

  if (events.length === 0) {
    console.log('No traces found.');
    return;
  }

  // Group consecutive same-type delta events first so per-token rows don't
  // drown out the meaningful events (one row per group, like trace-web).
  const grouped = groupDeltaEvents(events);
  const display = grouped.slice(-limit);
  if (grouped.length > limit) {
    console.log(dim(`Showing last ${limit} of ${grouped.length} traces.`));
  }

  for (const item of display) {
    if (isDeltaGroup(item)) {
      console.log(formatDeltaGroup(item, verbose));
    } else {
      console.log(formatTraceEvent(item, verbose));
    }
  }
}

interface DeltaGroup {
  eventType: string;
  count: number;
  fullText: string;
  startAt: string;
  endAt: string;
}

function isDeltaGroup(item: TraceEvent | DeltaGroup): item is DeltaGroup {
  return 'count' in item;
}

function groupDeltaEvents(events: TraceEvent[]): Array<TraceEvent | DeltaGroup> {
  const grouped: Array<TraceEvent | DeltaGroup> = [];
  let i = 0;
  while (i < events.length) {
    const event = events[i];
    if (event.eventType === 'message_delta' || event.eventType === 'reasoning_delta') {
      const type = event.eventType;
      let fullText = '';
      let endAt = event.createdAt;
      let count = 0;
      while (i < events.length && events[i].eventType === type) {
        fullText += String((events[i].eventData as { content?: string }).content ?? '');
        endAt = events[i].createdAt;
        count++;
        i++;
      }
      grouped.push({ eventType: type, count, fullText, startAt: event.createdAt, endAt });
    } else {
      grouped.push(event);
      i++;
    }
  }
  return grouped;
}

function formatDeltaGroup(group: DeltaGroup, verbose: boolean): string {
  if (verbose) {
    return `${group.startAt} [${group.eventType}] × ${group.count} chunks: ${group.fullText}`;
  }
  return `${dim(group.startAt)} [${cyan(group.eventType)}] × ${group.count}: ${truncateWithEllipsis(group.fullText, 80)}`;
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
