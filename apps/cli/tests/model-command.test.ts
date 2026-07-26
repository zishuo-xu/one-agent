import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureSystem } from '@one-agent/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyModelChoice,
  configuredModelChoices,
  printModelChoices,
} from '../src/commands/model.js';

describe('/model command helpers', () => {
  afterEach(() => configureSystem({}));

  it('lists configured models and persists the selected global model', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-agent-cli-model-'));
    const configPath = path.join(root, 'one-agent.config.json');
    configureSystem({
      model: {
        connectionId: 'one',
        provider: 'openai-compatible',
        apiKey: 'one-secret',
        model: 'model-one',
      },
      modelConnections: [
        {
          id: 'one',
          name: 'One',
          provider: 'openai-compatible',
          apiKey: 'one-secret',
          models: ['model-one'],
        },
        {
          id: 'two',
          name: 'Two',
          provider: 'anthropic',
          apiKey: 'two-secret',
          models: ['model-two'],
        },
      ],
    }, { workspaceRoot: root, configPath });

    const choices = configuredModelChoices();
    expect(choices).toEqual([
      expect.objectContaining({ connectionName: 'One', model: 'model-one', active: true }),
      expect.objectContaining({ connectionName: 'Two', model: 'model-two', active: false }),
    ]);
    const lines: string[] = [];
    printModelChoices(choices, (line) => lines.push(line));
    expect(lines.join('\n')).toContain('Two / model-two');

    applyModelChoice(choices[1], { workspaceRoot: root, configPath });
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted.model).toMatchObject({
      connectionId: 'two',
      provider: 'anthropic',
      apiKey: 'two-secret',
      model: 'model-two',
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
