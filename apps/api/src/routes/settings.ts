import type { FastifyInstance } from 'fastify';
import {
  config,
  createStandaloneModelProvider,
  resolveModelConnections,
  saveSystemConfig,
  toSystemConfig,
} from '@one-agent/agent-core';
import type {
  ModelConnection,
  SystemConfig,
} from '@one-agent/agent-core';
import type { WorkspaceRuntimeRegistry } from '../runtime-provider.js';

const REDACTED = '[REDACTED]';

interface AgentSettingsInput {
  primaryConnectionId?: unknown;
  primaryModel?: unknown;
  fallbackConnectionId?: unknown;
  fallbackModel?: unknown;
  planningModel?: unknown;
  utilityModel?: unknown;
  timeoutMs?: unknown;
}

interface SettingsBody {
  connections?: unknown;
  agent?: AgentSettingsInput;
  budget?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  subAgent?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  trace?: Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number | null,
  field: string,
): number | null {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new Error(`${field} must be a positive integer or empty`);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim()))];
}

function connectionMatchesModel(
  connection: ModelConnection,
  model: SystemConfig['model'],
): boolean {
  return connection.provider === model.provider
    && connection.baseUrl === model.baseUrl
    && connection.apiKey === model.apiKey
    && connection.models.includes(model.model);
}

function activeConnectionId(settings: SystemConfig, connections: ModelConnection[]): string {
  return settings.model.connectionId
    ?? connections.find((connection) => connectionMatchesModel(connection, settings.model))?.id
    ?? connections[0]?.id
    ?? '';
}

function fallbackConnectionId(settings: SystemConfig, connections: ModelConnection[]): string | undefined {
  const fallback = settings.model.fallback;
  if (!fallback) return undefined;
  return fallback.connectionId
    ?? connections.find((connection) =>
      connection.provider === fallback.provider
      && connection.baseUrl === fallback.baseUrl
      && connection.apiKey === fallback.apiKey
      && connection.models.includes(fallback.model))?.id;
}

function settingsSnapshot(settings: SystemConfig = config) {
  const connections = resolveModelConnections(settings);
  return {
    configPath: config.configPath,
    connections: connections.map((connection) => ({
      ...connection,
      apiKey: connection.apiKey ? REDACTED : '',
    })),
    agent: {
      primaryConnectionId: activeConnectionId(settings, connections),
      primaryModel: settings.model.model,
      fallbackConnectionId: fallbackConnectionId(settings, connections) ?? '',
      fallbackModel: settings.model.fallback?.model ?? '',
      planningModel: settings.model.planningModel ?? '',
      utilityModel: settings.model.utilityModel ?? '',
      timeoutMs: settings.model.timeoutMs,
    },
    runtime: {
      locale: settings.runtime.locale,
      customInstructions: settings.runtime.customInstructions,
      loop: settings.runtime.loop,
      maxRetries: settings.runtime.maxRetries,
      maxToolIterations: settings.runtime.maxToolIterations,
      maxReplanAttempts: settings.runtime.maxReplanAttempts,
      maxRetryAttempts: settings.runtime.maxRetryAttempts,
      planApproval: settings.runtime.planApproval,
    },
    budget: {
      mainAgentTokens: settings.budget.mainAgentTokens,
      subAgentTokens: settings.budget.subAgentTokens,
    },
    subAgent: {
      enabled: settings.subAgent.enabled,
      maxDepth: settings.subAgent.maxDepth,
      maxConcurrency: settings.subAgent.maxConcurrency,
      taskTimeoutMs: settings.subAgent.taskTimeoutMs,
      maxToolIterations: settings.subAgent.maxToolIterations,
    },
    tools: {
      disabled: [...settings.tools.disabled],
      requireApproval: [...settings.tools.requireApproval],
    },
    trace: {
      contentMode: settings.trace.contentMode,
    },
  };
}

function mergeConnections(
  input: unknown,
  currentConnections: ModelConnection[],
): ModelConnection[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('至少需要保留一个模型连接。');
  }
  const seen = new Set<string>();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`connections.${index} must be an object`);
    }
    const value = raw as Record<string, unknown>;
    const id = stringValue(value.id, `connections.${index}.id`);
    if (seen.has(id)) throw new Error(`模型连接 ID 重复：${id}`);
    seen.add(id);
    const existing = currentConnections.find((connection) => connection.id === id);
    const suppliedKey = typeof value.apiKey === 'string' ? value.apiKey : '';
    const apiKey = suppliedKey === REDACTED ? existing?.apiKey ?? '' : suppliedKey.trim();
    const models = stringArray(value.models, []);
    if (models.length === 0) throw new Error(`连接 ${id} 至少需要一个模型名称。`);
    const provider = stringValue(value.provider, `connections.${index}.provider`);
    if (!['openai-compatible', 'openai', 'anthropic'].includes(provider)) {
      throw new Error(`连接 ${id} 使用了不支持的 API 协议。`);
    }
    return {
      id,
      name: stringValue(value.name, `connections.${index}.name`),
      provider: provider as ModelConnection['provider'],
      baseUrl: optionalString(value.baseUrl),
      apiKey,
      models,
      maxTokens: integerValue(value.maxTokens, 4096),
    };
  });
}

function buildUpdatedConfig(body: SettingsBody): SystemConfig {
  const current = toSystemConfig(config);
  const currentConnections = resolveModelConnections(current);
  const connections = mergeConnections(body.connections, currentConnections);
  const agent = body.agent ?? {};
  const primaryConnectionId = stringValue(
    agent.primaryConnectionId,
    'agent.primaryConnectionId',
  );
  const primary = connections.find((connection) => connection.id === primaryConnectionId);
  if (!primary) throw new Error(`找不到主模型连接：${primaryConnectionId}`);
  const primaryModel = stringValue(agent.primaryModel, 'agent.primaryModel');
  if (!primary.models.includes(primaryModel)) {
    throw new Error(`主模型 ${primaryModel} 不属于连接 ${primary.name}`);
  }

  const fallbackId = optionalString(agent.fallbackConnectionId);
  const fallback = fallbackId
    ? connections.find((connection) => connection.id === fallbackId)
    : undefined;
  if (fallbackId && !fallback) throw new Error(`找不到备用模型连接：${fallbackId}`);
  const fallbackModel = fallback
    ? optionalString(agent.fallbackModel) ?? fallback.models[0]
    : undefined;
  if (fallback && fallbackModel && !fallback.models.includes(fallbackModel)) {
    throw new Error(`备用模型 ${fallbackModel} 不属于连接 ${fallback.name}`);
  }

  const next = current;
  next.modelConnections = connections;
  next.model = {
    ...current.model,
    connectionId: primary.id,
    provider: primary.provider,
    baseUrl: primary.baseUrl,
    apiKey: primary.apiKey,
    model: primaryModel,
    maxTokens: primary.maxTokens,
    timeoutMs: integerValue(agent.timeoutMs, current.model.timeoutMs),
    planningModel: optionalString(agent.planningModel),
    utilityModel: optionalString(agent.utilityModel),
    fallback: fallback && fallbackModel
      ? {
          connectionId: fallback.id,
          provider: fallback.provider,
          baseUrl: fallback.baseUrl,
          apiKey: fallback.apiKey,
          model: fallbackModel,
          maxTokens: fallback.maxTokens,
        }
      : undefined,
  };

  const runtime = body.runtime ?? {};
  const locale = typeof runtime.locale === 'string'
    ? runtime.locale
    : current.runtime.locale;
  if (!['auto', 'zh-CN', 'en-US'].includes(locale)) {
    throw new Error('不支持的交互语言。');
  }
  next.runtime = {
    ...current.runtime,
    locale: locale as SystemConfig['runtime']['locale'],
    customInstructions: typeof runtime.customInstructions === 'string'
      ? runtime.customInstructions
      : current.runtime.customInstructions,
    loop: typeof runtime.loop === 'string'
      ? runtime.loop as SystemConfig['runtime']['loop']
      : current.runtime.loop,
    maxRetries: integerValue(runtime.maxRetries, current.runtime.maxRetries),
    maxToolIterations: integerValue(
      runtime.maxToolIterations,
      current.runtime.maxToolIterations,
    ),
    maxReplanAttempts: integerValue(
      runtime.maxReplanAttempts,
      current.runtime.maxReplanAttempts,
    ),
    maxRetryAttempts: integerValue(
      runtime.maxRetryAttempts,
      current.runtime.maxRetryAttempts,
    ),
    planApproval: booleanValue(runtime.planApproval, current.runtime.planApproval),
  };

  const budget = body.budget ?? {};
  next.budget = {
    mainAgentTokens: optionalPositiveInteger(
      budget.mainAgentTokens,
      current.budget.mainAgentTokens,
      'budget.mainAgentTokens',
    ),
    subAgentTokens: optionalPositiveInteger(
      budget.subAgentTokens,
      current.budget.subAgentTokens,
      'budget.subAgentTokens',
    ),
  };

  const subAgent = body.subAgent ?? {};
  next.subAgent = {
    ...current.subAgent,
    enabled: booleanValue(subAgent.enabled, current.subAgent.enabled),
    maxDepth: integerValue(subAgent.maxDepth, current.subAgent.maxDepth),
    maxConcurrency: integerValue(
      subAgent.maxConcurrency,
      current.subAgent.maxConcurrency,
    ),
    taskTimeoutMs: integerValue(
      subAgent.taskTimeoutMs,
      current.subAgent.taskTimeoutMs,
    ),
    maxToolIterations: integerValue(
      subAgent.maxToolIterations,
      current.subAgent.maxToolIterations,
    ),
  };

  const tools = body.tools ?? {};
  next.tools = {
    ...current.tools,
    disabled: stringArray(tools.disabled, current.tools.disabled),
    requireApproval: stringArray(
      tools.requireApproval,
      current.tools.requireApproval,
    ),
  };

  const trace = body.trace ?? {};
  next.trace = {
    ...current.trace,
    contentMode: typeof trace.contentMode === 'string'
      ? trace.contentMode as SystemConfig['trace']['contentMode']
      : current.trace.contentMode,
  };
  return next;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|authorization|x-api-key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 500);
}

export async function settingsRoutes(
  fastify: FastifyInstance,
  options: {
    runtimes: WorkspaceRuntimeRegistry;
    configPath?: string;
  },
): Promise<void> {
  fastify.get('/api/settings', async () => settingsSnapshot(config));

  fastify.put<{ Body: SettingsBody }>('/api/settings', async (request, reply) => {
    if (!options.configPath) {
      return reply.status(500).send({ error: 'Global configuration path is unavailable.' });
    }
    if (options.runtimes.hasPendingOperations()) {
      return reply.status(409).send({
        error: '当前仍有任务正在执行或等待审批，请先处理完成再保存 Agent 配置。',
      });
    }
    try {
      const next = buildUpdatedConfig(request.body ?? {});
      saveSystemConfig(next, {
        workspaceRoot: config.workspaceRoot,
        configPath: options.configPath,
      });
      await options.runtimes.reload();
      return settingsSnapshot(config);
    } catch (error) {
      return reply.status(400).send({ error: safeError(error) });
    }
  });

  fastify.post<{
    Body: {
      connection?: Record<string, unknown>;
      model?: unknown;
    };
  }>('/api/settings/connections/test', async (request, reply) => {
    try {
      const currentConnections = resolveModelConnections(config);
      const [connection] = mergeConnections(
        request.body?.connection ? [request.body.connection] : [],
        currentConnections,
      );
      const model = optionalString(request.body?.model) ?? connection.models[0];
      if (!connection.models.includes(model)) {
        throw new Error(`模型 ${model} 不属于连接 ${connection.name}`);
      }
      const provider = createStandaloneModelProvider({
        provider: connection.provider,
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        model,
        maxTokens: connection.maxTokens,
      });
      const startedAt = Date.now();
      const result = await provider.complete({
        messages: [{
          role: 'user',
          content: 'Reply with exactly ONE_AGENT_CONNECTION_OK.',
        }],
        timeoutMs: Math.min(config.model.timeoutMs, 15000),
      });
      if (!result.content.trim() && !result.reasoning?.trim()) {
        throw new Error('模型已响应，但没有返回文本内容。');
      }
      return {
        ok: true,
        provider: provider.name,
        model: provider.model,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return reply.status(400).send({ error: safeError(error) });
    }
  });
}
