import OpenAI from 'openai';
import { createProviderFromEnv } from './model/factory.js';
import { OpenAICompatibleProvider } from './model/OpenAICompatibleProvider.js';

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

/**
 * Parse a numeric env var, failing loudly on garbage. `Number(env)` yields
 * NaN silently, and NaN poisons downstream comparisons (e.g.
 * `totalTokens <= NaN` is always false, which would summarize the whole
 * history away on every single turn).
 */
function getNumericEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value for ${key}: ${JSON.stringify(raw)}`);
  }
  return value;
}

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: getEnv('OPENAI_API_KEY', ''),
});
const model = process.env.OPENAI_MODEL ?? 'gpt-3.5-turbo';

export const config = {
  port: getNumericEnv('PORT', 3000),
  host: process.env.HOST ?? '127.0.0.1',
  openai,
  model,
  /**
   * Default model provider chain (primary + optional fallback configured via
   * OPENAI_FALLBACK_* env vars). Consumers may still wrap `config.openai`
   * directly when they need a pinned single provider (tests, eval mocks).
   */
  modelProvider: createProviderFromEnv(openai, model),
  /**
   * Optional stronger model for planning/judging (PLANNING_MODEL).
   * Falls back to modelProvider when unset.
   */
  planningModelProvider: process.env.PLANNING_MODEL
    ? new OpenAICompatibleProvider(openai, process.env.PLANNING_MODEL)
    : undefined,
  /**
   * Optional cheaper model for summarization and memory extraction
   * (UTILITY_MODEL). Falls back to modelProvider when unset.
   */
  utilityModelProvider: process.env.UTILITY_MODEL
    ? new OpenAICompatibleProvider(openai, process.env.UTILITY_MODEL)
    : undefined,
  /** Per-request timeout in milliseconds. Override with OPENAI_TIMEOUT_MS. */
  timeoutMs: getNumericEnv('OPENAI_TIMEOUT_MS', 30000),
  /** Maximum estimated tokens in the context window before summarization triggers. */
  maxContextTokens: getNumericEnv('MAX_CONTEXT_TOKENS', 4096),
  /** Token budget for the recent (non-summarized) message window. */
  recentTokenBudget: getNumericEnv('RECENT_TOKEN_BUDGET', 2048),
  systemPrompt:
    process.env.SYSTEM_PROMPT ??
    'You are a helpful assistant. Answer concisely and in Chinese by default. ' +
    'When you use the web_search tool, base your answer strictly on the search results returned. ' +
    'If the search returns no useful results, tell the user clearly instead of making up information.',
};

export type Config = typeof config;
