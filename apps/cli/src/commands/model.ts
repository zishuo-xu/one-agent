import {
  config,
  resolveModelConnections,
  saveSystemConfig,
  selectPrimaryModel,
} from '@one-agent/agent-core';
import type { ModelConnection } from '@one-agent/agent-core';

export interface ModelChoice {
  connectionId: string;
  connectionName: string;
  provider: ModelConnection['provider'];
  model: string;
  active: boolean;
}

export function configuredModelChoices(): ModelChoice[] {
  const activeConnectionId = config.model.connectionId
    ?? resolveModelConnections(config)[0]?.id;
  return resolveModelConnections(config).flatMap((connection) =>
    connection.models.map((model) => ({
      connectionId: connection.id,
      connectionName: connection.name,
      provider: connection.provider,
      model,
      active:
        connection.id === activeConnectionId
        && model === config.model.model,
    })));
}

export function printModelChoices(
  choices: ModelChoice[],
  write: (line: string) => void = console.log,
): void {
  write(`当前模型：${config.model.model}`);
  write('');
  choices.forEach((choice, index) => {
    const marker = choice.active ? '●' : ' ';
    write(`${marker} ${index + 1}. ${choice.connectionName} / ${choice.model}`);
  });
  write('');
  write('输入序号切换；直接回车取消。');
}

export function applyModelChoice(
  choice: ModelChoice,
  options: { configPath: string; workspaceRoot: string },
): void {
  const next = selectPrimaryModel(config, choice.connectionId, choice.model);
  saveSystemConfig(next, options);
}
