import { describe, it, expect } from 'vitest';
import { createGetTimeTool } from '../../src/tools/built-in/getTime.js';

describe('get_time tool', () => {
  it('returns current ISO time', () => {
    const tool = createGetTimeTool();
    const result = tool.execute({});

    expect(result).toMatchObject({
      now: expect.any(String),
      timezone: 'UTC',
    });

    // Verify it is a valid ISO 8601 string
    const parsed = new Date((result as { now: string }).now);
    expect(parsed.toISOString()).toBe((result as { now: string }).now);
  });
});
