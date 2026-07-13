import { describe, it, expect, vi } from 'vitest';
import { createWebSearchTool } from '../../src/tools/built-in/webSearch.js';
import { Sandbox } from '../../src/tools/sandbox.js';

function createMockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => response,
  });
}

describe('web_search tool', () => {
  it('returns summary and related results from DuckDuckGo', async () => {
    const mockFetch = createMockFetch({
      AbstractText: 'JavaScript is a programming language.',
      AbstractURL: 'https://example.com/js',
      Heading: 'JavaScript',
      RelatedTopics: [
        { Text: 'JavaScript - MDN Web Docs', FirstURL: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },
        { Text: 'Node.js - JavaScript runtime', FirstURL: 'https://nodejs.org/' },
      ],
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const tool = createWebSearchTool(new Sandbox('/tmp'));
    const result = await tool.execute({ query: 'JavaScript', limit: 2 });

    expect(result.query).toBe('JavaScript');
    expect(result.summary).toBe('JavaScript is a programming language.');
    expect(result.sourceUrl).toBe('https://example.com/js');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].url).toBe('https://developer.mozilla.org/en-US/docs/Web/JavaScript');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.duckduckgo.com/?q=JavaScript'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
  });

  it('throws when search request fails', async () => {
    const mockFetch = createMockFetch({}, 500);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const tool = createWebSearchTool(new Sandbox('/tmp'));
    await expect(tool.execute({ query: 'error' })).rejects.toThrow('Search request failed');
  });
});
