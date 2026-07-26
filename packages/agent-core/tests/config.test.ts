import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  config,
  configureSystem,
  createDefaultSystemConfig,
  loadSystemConfig,
  redactSystemConfig,
  resolveModelConnections,
  saveSystemConfig,
  selectPrimaryModel,
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
    expect(defaults.runtime.locale).toBe('zh-CN');
    expect(defaults.runtime.customInstructions).toBe('');
    expect(defaults.budget).toEqual({
      mainAgentTokens: null,
      subAgentTokens: null,
    });
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
    expect(() => configureSystem({ budget: { mainAgentTokens: 0 } })).toThrow();
  });

  it('accepts nullable agent budgets and removes legacy aggregate child limits', () => {
    const loaded = configureSystem({
      budget: {
        mainAgentTokens: 50000,
        subAgentTokens: null,
      },
      subAgent: {
        maxTasksPerRun: 8,
        maxTotalTokens: 50000,
      },
    });

    expect(loaded.budget).toEqual({
      mainAgentTokens: 50000,
      subAgentTokens: null,
    });
    expect(loaded.subAgent).not.toHaveProperty('maxTasksPerRun');
    expect(loaded.subAgent).not.toHaveProperty('maxTotalTokens');
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

  it('supports multiple named model connections and atomically selects one', () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'one-agent-models-'));
    const configPath = path.join(workspaceRoot, 'one-agent.config.json');
    const initial = configureSystem({
      model: {
        connectionId: 'primary',
        provider: 'openai-compatible',
        apiKey: 'primary-secret',
        model: 'model-a',
      },
      modelConnections: [
        {
          id: 'primary',
          name: 'Primary',
          provider: 'openai-compatible',
          apiKey: 'primary-secret',
          models: ['model-a'],
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          provider: 'anthropic',
          baseUrl: 'https://api.example.com/anthropic',
          apiKey: 'anthropic-secret',
          models: ['model-b'],
        },
      ],
    }, { workspaceRoot, configPath });

    expect(resolveModelConnections(initial)).toHaveLength(2);
    const selected = selectPrimaryModel(initial, 'anthropic', 'model-b');
    saveSystemConfig(selected, { workspaceRoot, configPath });

    expect(config.model.connectionId).toBe('anthropic');
    expect(config.model.provider).toBe('anthropic');
    expect(config.model.model).toBe('model-b');
    expect(JSON.parse(readFileSync(configPath, 'utf8')).model.apiKey).toBe('anthropic-secret');
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('synthesizes named connections for legacy primary and fallback config', () => {
    const legacy = configureSystem({
      model: {
        provider: 'anthropic',
        apiKey: 'primary-secret',
        model: 'primary-model',
        fallback: {
          provider: 'openai-compatible',
          apiKey: 'fallback-secret',
          model: 'fallback-model',
        },
      },
    });
    expect(resolveModelConnections(legacy).map((connection) => connection.id))
      .toEqual(['primary', 'fallback']);
    const redacted = redactSystemConfig(legacy);
    expect(redacted.modelConnections).toEqual([]);
  });
});
