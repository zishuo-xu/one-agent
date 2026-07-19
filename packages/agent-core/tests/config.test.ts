import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  config,
  configureSystem,
  createDefaultSystemConfig,
  loadSystemConfig,
  redactSystemConfig,
} from '../src/config.js';

describe('JSON system configuration', () => {
  afterEach(() => configureSystem({}));
  it('provides one typed table with stable defaults', () => {
    const defaults = createDefaultSystemConfig();
    expect(defaults.api.port).toBe(3000);
    expect(defaults.api.host).toBe('127.0.0.1');
    expect(defaults.context.maxTokens).toBe(4096);
    expect(defaults.model.model).toBe('gpt-3.5-turbo');
    expect(defaults.tools.requireApproval).toEqual(['delete_file', 'run_command']);
    expect(defaults.runtime.planApproval).toBe(true);
  });

  it('loads partial JSON and resolves the database path against the workspace', () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'one-agent-config-'));
    const configPath = path.join(workspaceRoot, 'one-agent.config.json');
    writeFileSync(configPath, JSON.stringify({ context: { maxTokens: 8192 } }));

    const loaded = loadSystemConfig({ workspaceRoot, configPath });

    expect(loaded.context.maxTokens).toBe(8192);
    expect(loaded.context.recentTokenBudget).toBe(2048);
    expect(loaded.databasePath).toBe(path.join(workspaceRoot, 'data.db'));
  });

  it('rejects unknown fields and invalid values with their JSON path', () => {
    expect(() => configureSystem({ context: { maxTokens: 'many' } })).toThrow();
    expect(() => configureSystem({ context: { maxTokens: 4096, typo: true } })).toThrow();
  });

  it('selects Anthropic and redacts every configured secret', () => {
    const loaded = configureSystem({
      model: {
        provider: 'anthropic',
        apiKey: 'primary-secret',
        model: 'claude-test',
        fallback: {
          provider: 'openai-compatible',
          apiKey: 'fallback-secret',
          model: 'fallback-test',
        },
      },
      tools: { search: { apiKey: 'search-secret' } },
    });

    expect(loaded.modelProvider).toMatchObject({ name: 'fallback', model: 'claude-test' });
    const redacted = redactSystemConfig(config);
    expect(redacted.model.apiKey).toBe('[REDACTED]');
    expect(redacted.model.fallback?.apiKey).toBe('[REDACTED]');
    expect(redacted.tools.search.apiKey).toBe('[REDACTED]');
  });
});
