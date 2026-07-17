import { describe, expect, it } from 'vitest';
import { DEFAULT_EVAL_CONCURRENCY, parseEvalConcurrency } from '../src/eval-options.js';

describe('eval CLI options', () => {
  it('defaults to four concurrent tasks', () => {
    expect(parseEvalConcurrency([])).toBe(DEFAULT_EVAL_CONCURRENCY);
    expect(DEFAULT_EVAL_CONCURRENCY).toBe(4);
  });

  it('accepts an explicit positive integer', () => {
    expect(parseEvalConcurrency(['--real', '--concurrency', '1'])).toBe(1);
    expect(parseEvalConcurrency(['--concurrency', '8'])).toBe(8);
  });

  it.each([
    ['--concurrency'],
    ['--concurrency', '0'],
    ['--concurrency', '-1'],
    ['--concurrency', '1.5'],
    ['--concurrency', 'many'],
  ])('rejects invalid arguments: %s', (...argv) => {
    expect(() => parseEvalConcurrency(argv)).toThrow(/concurrency/);
  });
});
