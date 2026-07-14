import OpenAI from 'openai';

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? '3000'),
  host: process.env.HOST ?? '127.0.0.1',
  openai: new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: getEnv('OPENAI_API_KEY', ''),
  }),
  model: process.env.OPENAI_MODEL ?? 'gpt-3.5-turbo',
  /** Per-request timeout in milliseconds. Override with OPENAI_TIMEOUT_MS. */
  timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? '30000'),
  /** Maximum estimated tokens in the context window before summarization triggers. */
  maxContextTokens: Number(process.env.MAX_CONTEXT_TOKENS ?? '4096'),
  /** Token budget for the recent (non-summarized) message window. */
  recentTokenBudget: Number(process.env.RECENT_TOKEN_BUDGET ?? '2048'),
  systemPrompt:
    process.env.SYSTEM_PROMPT ??
    'You are a helpful assistant. Answer concisely and in Chinese by default. ' +
    'When you use the web_search tool, base your answer strictly on the search results returned. ' +
    'If the search returns no useful results, tell the user clearly instead of making up information.',
};

export type Config = typeof config;
