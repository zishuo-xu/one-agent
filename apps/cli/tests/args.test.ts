import { describe, expect, it } from 'vitest';
import { isUsableApiKey, parseArgs } from '../src/args.js';

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
});
