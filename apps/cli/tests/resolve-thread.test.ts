import { describe, it, expect } from 'vitest';
import { parseArgs, resolveThread } from '../src/args.js';

const existsNone = () => false;
const createNew = (id?: string) => id ?? 'fresh-uuid';

describe('resolveThread', () => {
  it('--thread <id> resumes when it exists', () => {
    const args = parseArgs(['--thread', 'abc123']);
    const res = resolveThread(args, [], () => true, createNew);
    expect(res).toEqual({ threadId: 'abc123', mode: 'resumed' });
  });

  it('--thread <id> creates when it does not exist', () => {
    const args = parseArgs(['--thread', 'abc123']);
    const res = resolveThread(args, [], existsNone, createNew);
    expect(res).toEqual({ threadId: 'abc123', mode: 'created' });
  });

  it('--thread <id> --new creates even if id collides', () => {
    const args = parseArgs(['--thread', 'abc123', '--new']);
    expect(() => resolveThread(args, [], () => true, createNew)).toThrow(/already exists/);
  });

  it('--new alone creates a fresh thread', () => {
    const args = parseArgs(['--new']);
    const res = resolveThread(args, [], existsNone, createNew);
    expect(res.mode).toBe('created');
    expect(res.threadId).toBe('fresh-uuid');
  });

  it('no args resumes the most recent thread when one exists', () => {
    const args = parseArgs([]);
    const recent = [
      { id: 'recent-1', title: 'hello' },
      { id: 'older', title: null },
    ];
    const res = resolveThread(args, recent, existsNone, createNew);
    expect(res).toEqual({ threadId: 'recent-1', mode: 'resumed' });
  });

  it('no args creates a thread when none exist', () => {
    const args = parseArgs([]);
    const res = resolveThread(args, [], existsNone, createNew);
    expect(res.mode).toBe('created');
  });

  it('--new alias works alongside --new-thread', () => {
    expect(parseArgs(['--new']).newThread).toBe(true);
    expect(parseArgs(['--new-thread']).newThread).toBe(true);
  });
});