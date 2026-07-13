import { describe, it, expect, vi } from 'vitest';
import { createWebSearchTool } from '../../src/tools/built-in/webSearch.js';
import { Sandbox } from '../../src/tools/sandbox.js';

function createMockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => (typeof response === 'string' ? response : ''),
    json: async () => response,
  });
}

describe('web_search tool', () => {
  it('returns results from DuckDuckGo HTML search', async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2F">Node.js</a>
        <a class="result__snippet">Node.js® is a JavaScript runtime built on Chrome's V8 JavaScript engine.</a>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdownload%2F">Download Node.js</a>
        <a class="result__snippet">Download Node.js the way you want.</a>
      </div>
    `;
    const mockFetch = createMockFetch(html);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const tool = createWebSearchTool(new Sandbox('/tmp'));
    const result = await tool.execute({ query: 'Node.js LTS', limit: 2 });

    expect(result.query).toBe('Node.js LTS');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].url).toBe('https://nodejs.org/en/about/');
    expect(result.results[0].title).toBe('Node.js');
    expect(result.results[1].url).toBe('https://nodejs.org/en/download/');
  });

  it('falls back to Instant Answer when HTML search returns no results', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<html></html>',
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({
          AbstractText: 'JavaScript is a programming language.',
          AbstractURL: 'https://example.com/js',
          Heading: 'JavaScript',
          RelatedTopics: [
            { Text: 'JavaScript - MDN Web Docs', FirstURL: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },
          ],
        }),
      });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const tool = createWebSearchTool(new Sandbox('/tmp'));
    const result = await tool.execute({ query: 'JavaScript', limit: 2 });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].url).toBe('https://example.com/js');
  });

  it('returns empty result when all search backends fail', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Error',
      text: async () => '',
      json: async () => ({}),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const tool = createWebSearchTool(new Sandbox('/tmp'));
    const result = await tool.execute({ query: 'error' });

    expect(result.results).toHaveLength(0);
    expect(result.summary).toContain('No useful results');
  });

  it('parses Brave Search API response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({
        web: {
          results: [
            { title: 'Node.js', url: 'https://nodejs.org/', description: 'JavaScript runtime' },
            { title: 'Node.js LTS', url: 'https://nodejs.org/en/about/', description: 'Long Term Support' },
          ],
        },
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    process.env.SEARCH_API_URL = 'https://api.search.brave.io/api/web/search?q={query}&count={limit}';
    process.env.SEARCH_API_KEY = 'brave-key';

    try {
      const tool = createWebSearchTool(new Sandbox('/tmp'));
      const result = await tool.execute({ query: 'Node.js LTS', limit: 2 });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].url).toBe('https://nodejs.org/');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.search.brave.io/api/web/search'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Subscription-Token': 'brave-key',
          }),
        })
      );
    } finally {
      delete process.env.SEARCH_API_URL;
      delete process.env.SEARCH_API_KEY;
    }
  });
});
