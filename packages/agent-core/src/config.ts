import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createProviderFromEnv } from './model/factory.js';

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
const selectedProvider = process.env.MODEL_PROVIDER ?? 'openai-compatible';
const usesAnthropic = selectedProvider === 'anthropic';
const model = usesAnthropic
  ? getEnv('ANTHROPIC_MODEL')
  : process.env.OPENAI_MODEL ?? 'gpt-3.5-turbo';
const anthropic = usesAnthropic
  ? new Anthropic({
      // Compatibility gateways such as DeepSeek often use one key for both
      // OpenAI and Anthropic wire protocols. Avoid duplicating that secret.
      apiKey: process.env.ANTHROPIC_API_KEY ?? getEnv('OPENAI_API_KEY', ''),
      baseURL: process.env.ANTHROPIC_BASE_URL,
    })
  : undefined;
const anthropicMaxTokens = getNumericEnv('ANTHROPIC_MAX_TOKENS', 4096);
const modelTimeoutMs = process.env.MODEL_TIMEOUT_MS !== undefined
  ? getNumericEnv('MODEL_TIMEOUT_MS', 30000)
  : getNumericEnv('OPENAI_TIMEOUT_MS', 30000);

function createPurposeProvider(purposeModel: string | undefined) {
  return purposeModel
    ? createProviderFromEnv(openai, purposeModel, {
        anthropicClient: anthropic,
        anthropicMaxTokens,
        includeFallback: false,
      })
    : undefined;
}

export const config = {
  port: getNumericEnv('PORT', 3000),
  host: process.env.HOST ?? '127.0.0.1',
  openai,
  model,
  /**
   * Default protocol-neutral Provider chain. MODEL_PROVIDER selects the
   * primary adapter and FALLBACK_MODEL_PROVIDER may select another protocol.
   */
  modelProvider: createProviderFromEnv(openai, model, {
    anthropicClient: anthropic,
    anthropicMaxTokens,
  }),
  /**
   * Optional stronger model for planning/judging (PLANNING_MODEL).
   * Falls back to modelProvider when unset.
   */
  planningModelProvider: createPurposeProvider(process.env.PLANNING_MODEL),
  /**
   * Optional cheaper model for summarization and memory extraction
   * (UTILITY_MODEL). Falls back to modelProvider when unset.
   */
  utilityModelProvider: createPurposeProvider(process.env.UTILITY_MODEL),
  /** Per-request timeout. MODEL_TIMEOUT_MS supersedes legacy OPENAI_TIMEOUT_MS. */
  timeoutMs: modelTimeoutMs,
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
