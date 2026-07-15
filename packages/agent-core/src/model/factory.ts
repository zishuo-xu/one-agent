import OpenAI from 'openai';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { FallbackProvider } from './FallbackProvider.js';
import type { ModelProvider } from './types.js';

/**
 * Build the default provider chain from environment variables.
 * When OPENAI_FALLBACK_BASE_URL is set, requests that fail with a retryable
 * error automatically fail over to the fallback endpoint.
 */
export function createProviderFromEnv(primaryClient: OpenAI, primaryModel: string): ModelProvider {
  const primary = new OpenAICompatibleProvider(primaryClient, primaryModel);

  const fallbackBaseURL = process.env.OPENAI_FALLBACK_BASE_URL;
  if (!fallbackBaseURL) {
    return primary;
  }

  const fallback = new OpenAICompatibleProvider(
    new OpenAI({
      baseURL: fallbackBaseURL,
      apiKey: process.env.OPENAI_FALLBACK_API_KEY ?? '',
    }),
    process.env.OPENAI_FALLBACK_MODEL ?? primaryModel,
  );

  return new FallbackProvider([primary, fallback]);
}
