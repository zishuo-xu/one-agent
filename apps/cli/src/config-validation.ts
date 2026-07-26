import fs from 'node:fs';
import { isUsableApiKey } from './args.js';

export interface StartupConfiguration {
  apiKey: string | undefined;
  configPath: string;
  workspaceRoot: string;
}

export function getStartupConfigurationErrors(
  input: StartupConfiguration,
): string[] {
  if (!fs.existsSync(input.configPath)) {
    return [
      `Error: configuration file not found: ${input.configPath}`,
      `Workspace: ${input.workspaceRoot}`,
      '',
      'Run "one-agent --init" once to create the shared global configuration,',
      'then edit model.apiKey before starting One Agent again.',
    ];
  }

  if (!isUsableApiKey(input.apiKey)) {
    return [
      'Error: model.apiKey is missing or still uses the template placeholder.',
      `Configuration: ${input.configPath}`,
      `Workspace: ${input.workspaceRoot}`,
      '',
      `Edit ${input.configPath} and set model.apiKey.`,
      'Run "one-agent doctor" to verify the model connection afterward.',
    ];
  }

  return [];
}

export function validateStartupConfiguration(
  input: StartupConfiguration,
  print: (message: string) => void = console.error,
): boolean {
  const errors = getStartupConfigurationErrors(input);
  for (const message of errors) {
    print(message);
  }
  return errors.length === 0;
}
