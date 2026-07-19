import { describe, expect, it } from 'vitest';
import { isUsableApiKey, parseArgs, toPlanningOption } from '../src/args.js';

describe('CLI arguments', () => {
  it('treats -v as the version flag', () => {
    expect(parseArgs(['-v']).version).toBe(true);
    expect(parseArgs(['-v']).verbose).toBe(false);
  });

  it('keeps verbose as an explicit option', () => {
    expect(parseArgs(['--verbose']).verbose).toBe(true);
    expect(parseArgs(['--verbose']).version).toBe(false);
  });

  it('does not consume another option as a thread id', () => {
    expect(parseArgs(['--thread', '--new-thread']).threadId).toBeUndefined();
  });

  it('rejects the generated API key placeholders', () => {
    expect(isUsableApiKey(undefined)).toBe(false);
    expect(isUsableApiKey('your-api-key')).toBe(false);
    expect(isUsableApiKey(' sk-your-api-key ')).toBe(false);
    expect(isUsableApiKey('test-key')).toBe(true);
  });

  it('defaults to chat with automatic loop selection', () => {
    expect(parseArgs([])).toMatchObject({ command: 'chat', loop: 'auto', withTrace: false });
    expect(toPlanningOption('auto')).toBe('auto');
  });

  it('parses the unified loop option', () => {
    expect(parseArgs(['--loop', 'simple']).loop).toBe('simple');
    expect(parseArgs(['--loop', 'planning']).loop).toBe('planning');
    expect(toPlanningOption('simple')).toBe(false);
    expect(toPlanningOption('planning')).toBe(true);
  });

  it('parses trace as a standalone command without confusing a thread id', () => {
    expect(parseArgs(['trace'])).toMatchObject({ command: 'trace', withTrace: false });
    expect(parseArgs(['--thread', 'trace']).command).toBe('chat');
  });

  it('parses doctor as a standalone command', () => {
    expect(parseArgs(['doctor'])).toMatchObject({ command: 'doctor' });
    expect(parseArgs(['--thread', 'doctor']).command).toBe('chat');
  });

  it('keeps old planning and trace flags as deprecated aliases', () => {
    expect(parseArgs(['--plan'])).toMatchObject({
      loop: 'planning', deprecatedFlags: ['--plan'],
    });
    expect(parseArgs(['--plan-auto'])).toMatchObject({
      loop: 'auto', deprecatedFlags: ['--plan-auto'],
    });
    expect(parseArgs(['--trace'])).toMatchObject({
      withTrace: true, deprecatedFlags: ['--trace'],
    });
  });

  it('rejects invalid or conflicting loop options', () => {
    expect(() => parseArgs(['--loop'])).toThrow('--loop requires');
    expect(() => parseArgs(['--loop', 'fast'])).toThrow('Invalid --loop value');
    expect(() => parseArgs(['--loop', 'simple', '--plan'])).toThrow('Do not combine');
    expect(() => parseArgs(['--plan', '--plan-auto'])).toThrow('Use only one loop mode');
  });
});
