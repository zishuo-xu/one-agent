import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/eval/runner.js';

describe('eval concurrency', () => {
  it('bounds active work and preserves input order', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrency([40, 5, 30, 10, 20, 1], 4, async (delay, index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active--;
      return `result-${index}`;
    });

    expect(maxActive).toBe(4);
    expect(results).toEqual([
      'result-0',
      'result-1',
      'result-2',
      'result-3',
      'result-4',
      'result-5',
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid concurrency: %s', async (value) => {
    await expect(mapWithConcurrency([1], value, async (item) => item)).rejects.toThrow(
      /positive integer/,
    );
  });

  it('handles an empty task list', async () => {
    await expect(mapWithConcurrency([], 4, async (item) => item)).resolves.toEqual([]);
  });
});
