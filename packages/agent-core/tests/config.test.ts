import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config.js';

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('has default values', () => {
    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.model).toBeDefined();
    expect(config.systemPrompt).toBeDefined();
    expect(config.openai).toBeDefined();
  });

  it('throws loudly on a non-numeric MAX_CONTEXT_TOKENS instead of poisoning budgets with NaN', async () => {
    vi.stubEnv('MAX_CONTEXT_TOKENS', 'not-a-number');
    vi.resetModules();
    await expect(import('../src/config.js')).rejects.toThrow(
      'Invalid numeric value for MAX_CONTEXT_TOKENS'
    );
  });

  it('accepts valid numeric env overrides', async () => {
    vi.stubEnv('MAX_CONTEXT_TOKENS', '8192');
    vi.resetModules();
    const fresh = await import('../src/config.js');
    expect(fresh.config.maxContextTokens).toBe(8192);
  });
});
