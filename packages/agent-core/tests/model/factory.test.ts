import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/model/AnthropicProvider.js';
import { FallbackProvider } from '../../src/model/FallbackProvider.js';
import { OpenAICompatibleProvider } from '../../src/model/OpenAICompatibleProvider.js';
import { createProviderFromConfig } from '../../src/model/factory.js';

const openai = { chat: { completions: { create: vi.fn() } } } as unknown as OpenAI;
const anthropic = { messages: { create: vi.fn() } } as unknown as Anthropic;

describe('provider factory from JSON configuration', () => {
  it('creates an OpenAI-compatible primary', () => {
    const provider = createProviderFromConfig(openai, {
      provider: 'openai-compatible', apiKey: 'key', model: 'openai-model', maxTokens: 4096,
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('accepts openai as the JSON alias for openai-compatible', () => {
    const provider = createProviderFromConfig(openai, {
      provider: 'openai', apiKey: 'key', model: 'openai-model', maxTokens: 4096,
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe('openai-compatible');
  });

  it('creates a native Anthropic primary', () => {
    const provider = createProviderFromConfig(openai, {
      provider: 'anthropic', apiKey: 'key', model: 'claude-model', maxTokens: 8192,
    }, { anthropicClient: anthropic });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.model).toBe('claude-model');
  });

  it('builds a cross-protocol fallback chain', () => {
    const provider = createProviderFromConfig(openai, {
      provider: 'anthropic', apiKey: 'key', model: 'claude-primary', maxTokens: 4096,
      fallback: {
        provider: 'openai-compatible', apiKey: 'fallback-key', model: 'openai-fallback', maxTokens: 4096,
      },
    }, { anthropicClient: anthropic });
    expect(provider).toBeInstanceOf(FallbackProvider);
    expect(provider).toMatchObject({ name: 'fallback', model: 'claude-primary' });
  });

  it('supports Anthropic as the fallback protocol', () => {
    const provider = createProviderFromConfig(openai, {
      provider: 'openai-compatible', apiKey: 'key', model: 'openai-primary', maxTokens: 4096,
      fallback: {
        provider: 'anthropic', apiKey: 'fallback-key', model: 'claude-fallback', maxTokens: 4096,
      },
    });
    expect(provider).toBeInstanceOf(FallbackProvider);
  });

  it('can suppress fallback construction for purpose-specific models', () => {
    const provider = createProviderFromConfig(openai, {
      provider: 'openai-compatible', apiKey: 'key', model: 'utility', maxTokens: 4096,
      fallback: {
        provider: 'anthropic', apiKey: 'fallback-key', model: 'claude-fallback', maxTokens: 4096,
      },
    }, { includeFallback: false });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
