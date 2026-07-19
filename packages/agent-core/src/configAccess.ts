import { config } from './config.js';

/**
 * Narrow runtime accessors keep older dependency-injection mocks working
 * while production configuration comes exclusively from SystemConfig JSON.
 */
export function modelName(): string {
  return typeof config.model === 'string' ? config.model : config.model.model;
}

export function modelTimeoutMs(): number {
  const legacy = config as unknown as { timeoutMs?: number };
  return typeof config.model === 'string' ? legacy.timeoutMs ?? 30000 : config.model.timeoutMs;
}

export function runtimeSettings() {
  const legacy = config as unknown as {
    systemPrompt?: string;
    maxRetries?: number;
    maxToolIterations?: number;
    maxReplanAttempts?: number;
    maxRetryAttempts?: number;
  };
  return config.runtime ?? {
    systemPrompt: legacy.systemPrompt ?? 'You are a helpful assistant.',
    loop: 'auto' as const,
    maxRetries: legacy.maxRetries ?? 2,
    maxToolIterations: legacy.maxToolIterations ?? 5,
    maxReplanAttempts: legacy.maxReplanAttempts ?? 3,
    maxRetryAttempts: legacy.maxRetryAttempts ?? 2,
  };
}

export function contextSettings() {
  const legacy = config as unknown as {
    maxContextTokens?: number;
    recentTokenBudget?: number;
  };
  return config.context ?? {
    maxTokens: legacy.maxContextTokens,
    recentTokenBudget: legacy.recentTokenBudget,
  };
}

export function subAgentSettings() {
  return config.subAgent ?? {
    enabled: true,
    maxDepth: 1,
    maxTasksPerRun: 8,
    maxConcurrency: 4,
    maxTotalTokens: 50000,
    taskTimeoutMs: 60000,
    maxToolIterations: 5,
  };
}

export function strategySettings() {
  return config.strategy ?? { maxInitialToolBatch: 2, maxSwitches: 1 };
}
