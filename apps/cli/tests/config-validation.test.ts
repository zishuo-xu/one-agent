import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import {
  getStartupConfigurationErrors,
  validateStartupConfiguration,
} from '../src/config-validation.js';

describe('startup configuration validation', () => {
  it('points a missing configuration to the one-time global init command', () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'one-agent-home-'));
    const configPath = path.join(homeDir, '.one-agent', 'one-agent.config.json');
    const errors = getStartupConfigurationErrors({
      apiKey: '',
      configPath,
      workspaceRoot: '/tmp/project-a',
    });

    expect(errors.join('\n')).toContain('configuration file not found');
    expect(errors.join('\n')).toContain('one-agent --init');
    expect(errors.join('\n')).toContain('/tmp/project-a');
  });

  it('rejects placeholder keys before starting a runtime', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'one-agent-config-'));
    const configPath = path.join(root, 'one-agent.config.json');
    writeFileSync(configPath, '{}');

    expect(getStartupConfigurationErrors({
      apiKey: 'missing-api-key',
      configPath,
      workspaceRoot: root,
    }).join('\n')).toContain('model.apiKey');
  });

  it('accepts an existing configuration with a usable key', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'one-agent-config-'));
    const configPath = path.join(root, '.one-agent', 'one-agent.config.json');
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{}');
    const output: string[] = [];

    expect(validateStartupConfiguration({
      apiKey: 'test-key',
      configPath,
      workspaceRoot: '/tmp/project-b',
    }, (message) => output.push(message))).toBe(true);
    expect(output).toEqual([]);
  });
});
