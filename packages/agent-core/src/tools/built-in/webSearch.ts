import { z } from 'zod';
import { ToolDefinition } from '../types.js';
import { Sandbox } from '../sandbox.js';

export function createWebSearchTool(_sandbox: Sandbox): ToolDefinition {
  return {
    name: 'web_search',
    description:
      'Search the web for a query and return a short summary with related links. ' +
      'Useful for finding current information that is not in the workspace.',
    parameters: z.object({
      query: z.string().describe('The search query.'),
      limit: z.number().optional().describe('Maximum number of related results to return (default 5).'),
    }),
    execute: async (args) => {
      const { query, limit = 5 } = args as { query: string; limit?: number };
      const encodedQuery = encodeURIComponent(query);
      const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'one-agent/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`Search request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        AbstractText?: string;
        AbstractURL?: string;
        Heading?: string;
        RelatedTopics?: Array<{
          Text?: string;
          FirstURL?: string;
          Icon?: { URL?: string };
        }>;
      };

      const results = (data.RelatedTopics ?? [])
        .filter((topic) => topic.Text && topic.FirstURL)
        .slice(0, limit)
        .map((topic) => ({
          title: topic.Text!.split(' - ')[0] ?? topic.Text!,
          snippet: topic.Text!,
          url: topic.FirstURL!,
        }));

      return {
        query,
        summary: data.AbstractText || data.Heading || '',
        sourceUrl: data.AbstractURL || '',
        results,
      };
    },
  };
}

export default createWebSearchTool;
