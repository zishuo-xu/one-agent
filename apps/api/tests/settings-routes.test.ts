import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  config,
  configureSystem,
  createConnection,
  createDefaultSystemConfig,
  RunStore,
  ThreadStore,
} from '@one-agent/agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('Web Agent settings', () => {
  let root: string;
  let workspace: string;
  let configPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-settings-'));
    workspace = path.join(root, 'workspace');
    configPath = path.join(root, '.one-agent', 'one-agent.config.json');
    fs.mkdirSync(workspace);
    const settings = createDefaultSystemConfig();
    settings.model = {
      ...settings.model,
      connectionId: 'deepseek',
      provider: 'anthropic',
      baseUrl: 'https://api.deepseek.example/anthropic',
      apiKey: 'primary-secret',
      model: 'deepseek-test',
    };
    settings.modelConnections = [{
      id: 'deepseek',
      name: 'DeepSeek',
      provider: 'anthropic',
      baseUrl: 'https://api.deepseek.example/anthropic',
      apiKey: 'primary-secret',
      models: ['deepseek-test'],
      maxTokens: 4096,
    }];
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    configureSystem(settings, { workspaceRoot: root, configPath });
  });

  afterEach(() => {
    configureSystem({});
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns redacted global settings and preserves secrets when saving', async () => {
    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspace,
      workspaceStatePath: path.join(root, 'web-state.json'),
      configPath,
    });

    const getResponse = await server.inject({ method: 'GET', url: '/api/settings' });
    expect(getResponse.statusCode).toBe(200);
    const snapshot = JSON.parse(getResponse.body);
    expect(snapshot.connections[0].apiKey).toBe('[REDACTED]');
    expect(snapshot.agent.primaryConnectionId).toBe('deepseek');
    expect(snapshot.runtime.locale).toBe('zh-CN');
    expect(snapshot.budget).toEqual({
      mainAgentTokens: null,
      subAgentTokens: null,
    });

    snapshot.runtime.loop = 'planning';
    snapshot.runtime.locale = 'en-US';
    snapshot.runtime.customInstructions = 'Keep responses short.';
    snapshot.budget.mainAgentTokens = 50000;
    snapshot.budget.subAgentTokens = 25000;
    snapshot.subAgent.maxConcurrency = 3;
    const putResponse = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: snapshot,
    });

    expect(putResponse.statusCode).toBe(200);
    expect(config.runtime.loop).toBe('planning');
    expect(config.runtime.locale).toBe('en-US');
    expect(config.runtime.customInstructions).toBe('Keep responses short.');
    expect(config.budget.mainAgentTokens).toBe(50000);
    expect(config.budget.subAgentTokens).toBe(25000);
    expect(config.subAgent.maxConcurrency).toBe(3);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted.model.apiKey).toBe('primary-secret');
    expect(persisted.modelConnections[0].apiKey).toBe('primary-secret');
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    await server.close();
  });

  it('rejects removing every model connection', async () => {
    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspace,
      workspaceStatePath: path.join(root, 'web-state.json'),
      configPath,
    });
    const snapshot = JSON.parse((await server.inject({
      method: 'GET',
      url: '/api/settings',
    })).body);
    snapshot.connections = [];
    const response = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: snapshot,
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain('至少需要');
    await server.close();
  });

  it('does not reload Agent configuration while a task waits for approval', async () => {
    const server = await buildServer({
      workspaceMode: 'selectable',
      workspaceRoot: workspace,
      workspaceStatePath: path.join(root, 'web-state.json'),
      configPath,
    });
    const db = createConnection({ path: path.join(workspace, 'data.db') });
    const thread = new ThreadStore(db).create({});
    new RunStore(db).create({
      threadId: thread.id,
      model: 'deepseek-test',
      status: 'waiting_for_input',
    });
    db.close();
    const snapshot = JSON.parse((await server.inject({
      method: 'GET',
      url: '/api/settings',
    })).body);
    const response = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: snapshot,
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toContain('等待审批');
    await server.close();
  });
});
