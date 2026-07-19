import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeTraceEvent } from '../../src/agents/traceSanitizer.js';
import { configureSystem } from '../../src/config.js';

afterEach(() => {
  configureSystem({});
});

describe('trace sanitizer', () => {
  it('redacts credential-shaped keys and secret strings by default', () => {
    configureSystem({ trace: { contentMode: 'redacted' } });
    const event = sanitizeTraceEvent({
      type: 'tool_call',
      toolCall: {
        arguments: {
          apiKey: 'sk-private',
          command: 'OPENAI_API_KEY=sk-private run && Authorization: Bearer abc.def',
        },
      },
    });

    expect(event.toolCall.arguments.apiKey).toBe('[REDACTED]');
    expect(event.toolCall.arguments.command).not.toContain('sk-private');
    expect(event.toolCall.arguments.command).not.toContain('abc.def');
  });

  it('keeps structure but omits large content fields in metadata mode', () => {
    configureSystem({ trace: { contentMode: 'metadata' } });
    const event = sanitizeTraceEvent({ type: 'message', content: 'hello world' });
    expect(event).toEqual({ type: 'message', content: '[OMITTED 11 chars]' });
  });

  it('leaves the event untouched in full mode', () => {
    configureSystem({ trace: { contentMode: 'full' } });
    const event = { type: 'message', content: 'Bearer visible-token' };
    expect(sanitizeTraceEvent(event)).toBe(event);
  });
});
