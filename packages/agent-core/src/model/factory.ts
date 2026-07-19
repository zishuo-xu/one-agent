import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicProvider } from './AnthropicProvider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { FallbackProvider } from './FallbackProvider.js';
import type { ModelProvider } from './types.js';

export type ModelProviderKind = 'openai-compatible' | 'openai' | 'anthropic';

export interface ModelConnectionConfig {
  provider: ModelProviderKind;
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  fallback?: ModelConnectionConfig;
}

export interface ProviderFactoryOptions {
  anthropicClient?: Anthropic;
  includeFallback?: boolean;
}

function normalizeProvider(kind: ModelProviderKind): 'openai-compatible' | 'anthropic' {
  return kind === 'openai' ? 'openai-compatible' : kind;
}

function createProvider(
  openaiClient: OpenAI,
  modelConfig: ModelConnectionConfig,
  anthropicClient?: Anthropic,
): ModelProvider {
  if (normalizeProvider(modelConfig.provider) === 'anthropic') {
    return new AnthropicProvider(
      anthropicClient ?? new Anthropic({
        apiKey: modelConfig.apiKey || 'missing-api-key',
        baseURL: modelConfig.baseUrl,
      }),
      modelConfig.model,
      { maxTokens: modelConfig.maxTokens },
    );
  }
  return new OpenAICompatibleProvider(openaiClient, modelConfig.model);
}

export function createProviderFromConfig(
  primaryClient: OpenAI,
  modelConfig: ModelConnectionConfig,
  options: ProviderFactoryOptions = {},
): ModelProvider {
  const primary = createProvider(primaryClient, modelConfig, options.anthropicClient);
  if (options.includeFallback === false || !modelConfig.fallback) return primary;

  const fallbackConfig = modelConfig.fallback;
  const fallbackClient = normalizeProvider(fallbackConfig.provider) === 'openai-compatible'
    ? new OpenAI({
        baseURL: fallbackConfig.baseUrl,
        apiKey: fallbackConfig.apiKey || 'missing-api-key',
      })
    : primaryClient;
  return new FallbackProvider([
    primary,
    createProvider(fallbackClient, fallbackConfig),
  ]);
}
