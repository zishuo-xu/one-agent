import type { TraceEvent } from '@one-agent/agent-core';

export function formatTraceEvent(event: TraceEvent): string {
  const data = JSON.stringify(event.eventData);
  const preview = data.length > 200 ? `${data.slice(0, 200)}...` : data;
  return `${event.createdAt} [${event.eventType}] ${preview}`;
}

export function printTraces(events: TraceEvent[]): void {
  if (events.length === 0) {
    console.log('No traces found.');
    return;
  }

  for (const event of events) {
    console.log(formatTraceEvent(event));
  }
}
