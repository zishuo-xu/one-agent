import { config } from '../config.js';

type TraceContentMode = 'metadata' | 'redacted' | 'full';

const SENSITIVE_KEY = /^(?:password|passwd|pass|secret|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)$/i;
const LARGE_CONTENT_KEY = /^(?:content|feedback|stdout|stderr)$/i;

function redactString(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|PASSWORD|PASS|SECRET|ACCESS_TOKEN|REFRESH_TOKEN)\s*=\s*)[^\s"']+/gi,
      '$1[REDACTED]',
    );
}

function sanitize(value: unknown, mode: TraceContentMode, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (mode === 'metadata' && key && LARGE_CONTENT_KEY.test(key)) {
      return `[OMITTED ${value.length} chars]`;
    }
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, mode));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, mode, childKey),
      ]),
    );
  }
  return value;
}

/** Sanitize only the persisted copy; live execution events remain untouched. */
export function sanitizeTraceEvent<T>(event: T): T {
  const mode: TraceContentMode = config.trace?.contentMode ?? 'redacted';
  if (mode === 'full') return event;
  return sanitize(event, mode) as T;
}
