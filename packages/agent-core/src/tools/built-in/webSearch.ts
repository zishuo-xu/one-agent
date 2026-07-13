import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export function createWebSearchTool(_sandbox: Sandbox): ToolDefinition {
  return {
    name: 'web_search',
    description:
      'Search the web for a query and return a short summary with related links. ' +
      'Useful for finding current information that is not in the workspace. ' +
      'If the returned results are empty, do not invent information.',
    parameters: z.object({
      query: z.string().describe('The search query.'),
      limit: z.number().optional().describe('Maximum number of related results to return (default 5).'),
    }),
    execute: async (args) => {
      const { query, limit = 5 } = args as { query: string; limit?: number };

      const results = await searchWithConfigApi(query, limit) ??
        (await searchDuckDuckGoHtml(query, limit)) ??
        (await searchDuckDuckGoInstantAnswer(query, limit));

      if (!results || results.length === 0) {
        return {
          query,
          summary: 'No useful results were found for this query.',
          sourceUrl: '',
          results: [],
        };
      }

      return {
        query,
        summary: results[0].snippet,
        sourceUrl: results[0].url,
        results: results.slice(0, limit),
      };
    },
  };
}

async function searchWithConfigApi(query: string, limit: number): Promise<SearchResult[] | null> {
  const apiUrl = process.env.SEARCH_API_URL;
  const apiKey = process.env.SEARCH_API_KEY;
  if (!apiUrl) {
    return null;
  }

  if (isTavilyUrl(apiUrl)) {
    return searchTavily(apiUrl, apiKey, query, limit);
  }

  if (isBraveUrl(apiUrl)) {
    return searchBrave(apiUrl, apiKey, query, limit);
  }

  return searchGenericApi(apiUrl, apiKey, query, limit);
}

function isTavilyUrl(url: string): boolean {
  return url.includes('api.tavily.com');
}

function isBraveUrl(url: string): boolean {
  return url.includes('api.search.brave.io');
}

async function searchTavily(
  apiUrl: string,
  apiKey: string | undefined,
  query: string,
  limit: number
): Promise<SearchResult[] | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'one-agent/1.0',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      max_results: limit,
      search_depth: 'basic',
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
    answer?: string;
  };

  const results = (data.results ?? [])
    .filter((item) => item.title && item.url)
    .slice(0, limit)
    .map((item) => ({
      title: item.title!,
      snippet: item.content ?? item.title!,
      url: item.url!,
    }));

  return results.length > 0 ? results : null;
}

async function searchBrave(
  apiUrl: string,
  apiKey: string | undefined,
  query: string,
  limit: number
): Promise<SearchResult[] | null> {
  const url = apiUrl
    .replace('{query}', encodeURIComponent(query))
    .replace('{limit}', String(limit));

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'one-agent/1.0',
  };
  if (apiKey) {
    headers['X-Subscription-Token'] = apiKey;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    return null;
  }

  const data = await response.json() as unknown;
  return parseBraveResults(data, limit);
}

async function searchGenericApi(
  apiUrl: string,
  apiKey: string | undefined,
  query: string,
  limit: number
): Promise<SearchResult[] | null> {
  const url = apiUrl
    .replace('{query}', encodeURIComponent(query))
    .replace('{limit}', String(limit));

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'one-agent/1.0',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    return null;
  }

  const data = await response.json() as unknown;
  return normalizeSearchResults(data, limit);
}

function parseBraveResults(data: unknown, limit: number): SearchResult[] | null {
  const web = (data as { web?: { results?: unknown } }).web;
  if (!web || !Array.isArray(web.results)) {
    return null;
  }

  const results: SearchResult[] = [];
  for (const item of web.results as Array<{ title?: unknown; url?: unknown; description?: unknown }>) {
    if (typeof item !== 'object' || item === null) continue;
    const title = String(item.title ?? '');
    const snippet = String(item.description ?? '');
    const url = String(item.url ?? '');
    if (title && url) {
      results.push({ title, snippet, url });
    }
    if (results.length >= limit) break;
  }

  return results.length > 0 ? results : null;
}

async function searchDuckDuckGoHtml(query: string, limit: number): Promise<SearchResult[] | null> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const results = parseDuckDuckGoHtml(html, limit);
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Match title/link anchors first, then find the corresponding snippet.
  const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/s;

  let titleMatch: RegExpExecArray | null;
  while ((titleMatch = titleRegex.exec(html)) !== null) {
    const rawUrl = decodeHtmlEntities(titleMatch[1]);
    const title = stripHtml(titleMatch[2]);
    const url = extractRealUrl(rawUrl);

    const snippetMatch = snippetRegex.exec(html.slice(titleMatch.index + titleMatch[0].length));
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : title;

    if (url && title) {
      results.push({ title, snippet, url });
    }
    if (results.length >= limit) break;
  }

  return results;
}

function extractRealUrl(rawUrl: string): string {
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl;
  }
  // DuckDuckGo wraps organic results in a redirect URL.
  const redirectMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
  if (redirectMatch) {
    try {
      return decodeURIComponent(redirectMatch[1]);
    } catch {
      return redirectMatch[1];
    }
  }
  return rawUrl;
}

async function searchDuckDuckGoInstantAnswer(query: string, limit: number): Promise<SearchResult[] | null> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'one-agent/1.0',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{
        Text?: string;
        FirstURL?: string;
      }>;
    };

    const results: SearchResult[] = [];

    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || query,
        snippet: data.AbstractText,
        url: data.AbstractURL,
      });
    }

    for (const topic of data.RelatedTopics ?? []) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(' - ')[0] ?? topic.Text,
          snippet: topic.Text,
          url: topic.FirstURL,
        });
      }
      if (results.length >= limit) break;
    }

    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

function normalizeSearchResults(data: unknown, limit: number): SearchResult[] | null {
  if (!Array.isArray(data)) return null;

  const results: SearchResult[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const title = String((item as { title?: unknown }).title ?? '');
    const snippet = String((item as { snippet?: unknown }).snippet ?? (item as { description?: unknown }).description ?? title);
    const url = String((item as { url?: unknown }).url ?? (item as { link?: unknown }).link ?? '');
    if (title && url) {
      results.push({ title, snippet, url });
    }
    if (results.length >= limit) break;
  }

  return results.length > 0 ? results : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export default createWebSearchTool;
