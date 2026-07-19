import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicProvider } from './AnthropicProvider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { FallbackProvider } from './FallbackProvider.js';
import type { ModelProvider } from './types.js';

export type ModelProviderKind = 'openai-compatible' | 'anthropic';

export interface ProviderFactoryOptions {
  anthropicClient?: Anthropic;
  anthropicMaxTokens?: number;
  includeFallback?: boolean;
}

function providerKind(raw: string | undefined, variable: string): ModelProviderKind {
  const value = raw ?? 'openai-compatible';
  if (value === 'openai' || value === 'openai-compatible') return 'openai-compatible';
  if (value === 'anthropic') return 'anthropic';
  throw new Error(
    `Invalid ${variable}: ${JSON.stringify(value)}; expected openai-compatible or anthropic`,
  );
}

function positiveInteger(raw: string | undefined, fallback: number, variable: string): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${variable}: ${JSON.stringify(raw)}; expected a positive integer`);
  }
  return value;
}

function createPrimaryProvider(
  kind: ModelProviderKind,
  openaiClient: OpenAI,
  model: string,
  options: ProviderFactoryOptions,
): ModelProvider {
  if (kind === 'anthropic') {
    const client = options.anthropicClient ?? new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
    return new AnthropicProvider(client, model, {
      maxTokens: options.anthropicMaxTokens ??
        positiveInteger(process.env.ANTHROPIC_MAX_TOKENS, 4096, 'ANTHROPIC_MAX_TOKENS'),
    });
  }
  return new OpenAICompatibleProvider(openaiClient, model);
}

function createFallbackProvider(kind: ModelProviderKind, primaryModel: string): ModelProvider {
  const model = process.env.FALLBACK_MODEL ??
    process.env.OPENAI_FALLBACK_MODEL ??
    primaryModel;
  if (kind === 'anthropic') {
    return new AnthropicProvider(
      new Anthropic({
        apiKey: process.env.FALLBACK_API_KEY ??
          process.env.ANTHROPIC_FALLBACK_API_KEY ??
          process.env.ANTHROPIC_API_KEY ??
          process.env.OPENAI_API_KEY ??
          '',
        baseURL: process.env.FALLBACK_BASE_URL ?? process.env.ANTHROPIC_FALLBACK_BASE_URL,
      }),
      model,
      {
        maxTokens: positiveInteger(
          process.env.FALLBACK_MAX_TOKENS ?? process.env.ANTHROPIC_FALLBACK_MAX_TOKENS,
          4096,
          'FALLBACK_MAX_TOKENS',
        ),
      },
    );
  }
  return new OpenAICompatibleProvider(
    new OpenAI({
      baseURL: process.env.FALLBACK_BASE_URL ?? process.env.OPENAI_FALLBACK_BASE_URL,
      apiKey: process.env.FALLBACK_API_KEY ?? process.env.OPENAI_FALLBACK_API_KEY ?? '',
    }),
    model,
  );
}

/**
 * Build one protocol-neutral Provider chain from environment variables.
 * MODEL_PROVIDER selects the primary protocol; FALLBACK_MODEL_PROVIDER may
 * select either protocol. Legacy OPENAI_FALLBACK_* configuration remains
 * supported.
 */
export function createProviderFromEnv(
  primaryClient: OpenAI,
  primaryModel: string,
  options: ProviderFactoryOptions = {},
): ModelProvider {
  const primaryKind = providerKind(process.env.MODEL_PROVIDER, 'MODEL_PROVIDER');
  const primary = createPrimaryProvider(primaryKind, primaryClient, primaryModel, options);

  if (options.includeFallback === false) return primary;

  const fallbackKindRaw = process.env.FALLBACK_MODEL_PROVIDER;
  const hasLegacyOpenAIFallback = Boolean(process.env.OPENAI_FALLBACK_BASE_URL);
  if (!fallbackKindRaw && !hasLegacyOpenAIFallback) {
    return primary;
  }

  const fallbackKind = providerKind(
    fallbackKindRaw ?? 'openai-compatible',
    'FALLBACK_MODEL_PROVIDER',
  );
  const fallback = createFallbackProvider(fallbackKind, primaryModel);

  return new FallbackProvider([primary, fallback]);
}
