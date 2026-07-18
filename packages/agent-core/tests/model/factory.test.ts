import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/model/AnthropicProvider.js';
import { FallbackProvider } from '../../src/model/FallbackProvider.js';
import { OpenAICompatibleProvider } from '../../src/model/OpenAICompatibleProvider.js';
import { createProviderFromEnv } from '../../src/model/factory.js';

const openai = { chat: { completions: { create: vi.fn() } } } as unknown as OpenAI;
const anthropic = { messages: { create: vi.fn() } } as unknown as Anthropic;

function unsetEnv(name: string): void {
  vi.stubEnv(name, '__temporarily_unset__');
  delete process.env[name];
}

describe('provider factory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps OpenAI-compatible as the default protocol', () => {
    vi.stubEnv('MODEL_PROVIDER', 'openai-compatible');
    unsetEnv('FALLBACK_MODEL_PROVIDER');
    unsetEnv('OPENAI_FALLBACK_BASE_URL');

    const provider = createProviderFromEnv(openai, 'openai-model');

    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe('openai-compatible');
  });

  it('selects the native Anthropic adapter without changing the factory contract', () => {
    vi.stubEnv('MODEL_PROVIDER', 'anthropic');
    unsetEnv('FALLBACK_MODEL_PROVIDER');
    unsetEnv('OPENAI_FALLBACK_BASE_URL');

    const provider = createProviderFromEnv(openai, 'claude-model', {
      anthropicClient: anthropic,
      anthropicMaxTokens: 8192,
    });

    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider).toMatchObject({ name: 'anthropic', model: 'claude-model' });
  });

  it('builds a cross-protocol fallback chain from generic fallback configuration', () => {
    vi.stubEnv('MODEL_PROVIDER', 'anthropic');
    vi.stubEnv('FALLBACK_MODEL_PROVIDER', 'openai-compatible');
    vi.stubEnv('FALLBACK_MODEL', 'openai-fallback');
    vi.stubEnv('FALLBACK_API_KEY', 'test-key');

    const provider = createProviderFromEnv(openai, 'claude-primary', {
      anthropicClient: anthropic,
    });

    expect(provider).toBeInstanceOf(FallbackProvider);
    expect(provider).toMatchObject({
      name: 'fallback',
      model: 'claude-primary',
      capabilities: { streaming: 'emulated', toolCalling: 'native' },
    });
  });

  it('also configures Anthropic as fallback for an OpenAI-compatible primary', () => {
    vi.stubEnv('MODEL_PROVIDER', 'openai-compatible');
    vi.stubEnv('FALLBACK_MODEL_PROVIDER', 'anthropic');
    vi.stubEnv('FALLBACK_MODEL', 'claude-fallback');
    vi.stubEnv('FALLBACK_API_KEY', 'test-key');

    const provider = createProviderFromEnv(openai, 'openai-primary');

    expect(provider).toBeInstanceOf(FallbackProvider);
    expect(provider).toMatchObject({
      name: 'fallback',
      model: 'openai-primary',
      capabilities: { streaming: 'emulated', toolCalling: 'native' },
    });
  });

  it('can suppress fallback construction for purpose-specific models', () => {
    vi.stubEnv('MODEL_PROVIDER', 'anthropic');
    vi.stubEnv('FALLBACK_MODEL_PROVIDER', 'openai-compatible');

    const provider = createProviderFromEnv(openai, 'claude-utility', {
      anthropicClient: anthropic,
      includeFallback: false,
    });

    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('fails loudly on unknown protocols instead of silently using OpenAI', () => {
    vi.stubEnv('MODEL_PROVIDER', 'mystery-provider');

    expect(() => createProviderFromEnv(openai, 'model')).toThrow(/Invalid MODEL_PROVIDER/);
  });
});
