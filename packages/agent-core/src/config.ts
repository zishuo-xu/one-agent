import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import { createProviderFromConfig } from './model/factory.js';

export const CONFIG_FILE_NAME = 'one-agent.config.json';

const providerSchema = z.enum(['openai-compatible', 'openai', 'anthropic']);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

const fallbackSchema = z.object({
  provider: providerSchema.default('openai-compatible'),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().default(''),
  model: z.string().min(1),
  maxTokens: positiveInteger.default(4096),
}).strict();

export const systemConfigSchema = z.object({
  version: z.literal(1).default(1),
  model: z.object({
    provider: providerSchema.default('openai-compatible'),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().default(''),
    model: z.string().min(1).default('gpt-3.5-turbo'),
    maxTokens: positiveInteger.default(4096),
    timeoutMs: positiveInteger.default(30000),
    planningModel: z.string().min(1).optional(),
    utilityModel: z.string().min(1).optional(),
    fallback: fallbackSchema.optional(),
  }).strict().default({}),
  runtime: z.object({
    systemPrompt: z.string().min(1).default(
      'You are a helpful assistant. Answer concisely and in Chinese by default. ' +
      'When you use the web_search tool, base your answer strictly on the search results returned. ' +
      'If the search returns no useful results, tell the user clearly instead of making up information.',
    ),
    loop: z.enum(['auto', 'simple', 'planning']).default('auto'),
    maxRetries: nonNegativeInteger.default(2),
    maxToolIterations: positiveInteger.default(5),
    maxReplanAttempts: nonNegativeInteger.default(3),
    maxRetryAttempts: nonNegativeInteger.default(2),
    planApproval: z.boolean().default(true),
  }).strict().default({}),
  context: z.object({
    maxTokens: positiveInteger.default(4096),
    recentTokenBudget: positiveInteger.default(2048),
  }).strict().default({}),
  strategy: z.object({
    maxInitialToolBatch: positiveInteger.default(2),
    maxSwitches: nonNegativeInteger.default(1),
  }).strict().default({}),
  subAgent: z.object({
    enabled: z.boolean().default(true),
    maxDepth: nonNegativeInteger.default(1),
    maxTasksPerRun: positiveInteger.default(8),
    maxConcurrency: positiveInteger.default(4),
    maxTotalTokens: positiveInteger.default(50000),
    taskTimeoutMs: positiveInteger.default(60000),
    maxToolIterations: positiveInteger.default(5),
  }).strict().default({}),
  tools: z.object({
    disabled: z.array(z.string().min(1)).default([]),
    requireApproval: z.array(z.string().min(1)).default(['delete_file', 'run_command']),
    search: z.object({
      apiUrl: z.string().url().optional(),
      apiKey: z.string().optional(),
    }).strict().default({}),
  }).strict().default({}),
  trace: z.object({
    contentMode: z.enum(['metadata', 'redacted', 'full']).default('redacted'),
    host: z.string().min(1).default('127.0.0.1'),
    port: positiveInteger.max(65535).default(3001),
    logLevel: z.string().min(1).default('info'),
  }).strict().default({}),
  storage: z.object({
    databasePath: z.string().min(1).default('data.db'),
  }).strict().default({}),
  api: z.object({
    host: z.string().min(1).default('127.0.0.1'),
    port: positiveInteger.max(65535).default(3000),
    logLevel: z.string().min(1).default('info'),
  }).strict().default({}),
  taskQueue: z.object({
    maxConcurrency: positiveInteger.default(2),
    taskTimeoutMs: positiveInteger.default(300000),
    maxRetries: nonNegativeInteger.default(3),
    retryDelayMs: nonNegativeInteger.default(1000),
  }).strict().default({}),
  cli: z.object({
    color: z.boolean().default(true),
  }).strict().default({}),
}).strict();

export type SystemConfig = z.infer<typeof systemConfigSchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface ResolvedConfig extends SystemConfig {
  workspaceRoot: string;
  configPath?: string;
  databasePath: string;
  openai: OpenAI;
  anthropic?: Anthropic;
  modelProvider: ReturnType<typeof createProviderFromConfig>;
  planningModelProvider?: ReturnType<typeof createProviderFromConfig>;
  utilityModelProvider?: ReturnType<typeof createProviderFromConfig>;
}

function resolveDatabasePath(databasePath: string, workspaceRoot: string): string {
  if (databasePath === ':memory:' || path.isAbsolute(databasePath)) return databasePath;
  return path.resolve(workspaceRoot, databasePath);
}

function buildResolvedConfig(
  input: unknown,
  workspaceRoot: string,
  configPath?: string,
): ResolvedConfig {
  const settings = deepFreeze(systemConfigSchema.parse(input));
  const openai = new OpenAI({
    baseURL: settings.model.provider === 'anthropic' ? undefined : settings.model.baseUrl,
    apiKey: settings.model.apiKey || 'missing-api-key',
  });
  const anthropic = settings.model.provider === 'anthropic'
    ? new Anthropic({ apiKey: settings.model.apiKey || 'missing-api-key', baseURL: settings.model.baseUrl })
    : undefined;
  const modelProvider = createProviderFromConfig(openai, settings.model, { anthropicClient: anthropic });
  const purposeProvider = (model: string | undefined) => model
    ? createProviderFromConfig(openai, { ...settings.model, model, fallback: undefined }, {
        anthropicClient: anthropic,
        includeFallback: false,
      })
    : undefined;

  return {
    ...settings,
    workspaceRoot,
    configPath,
    databasePath: resolveDatabasePath(settings.storage.databasePath, workspaceRoot),
    openai,
    anthropic,
    modelProvider,
    planningModelProvider: purposeProvider(settings.model.planningModel),
    utilityModelProvider: purposeProvider(settings.model.utilityModel),
  };
}

export let config: ResolvedConfig = buildResolvedConfig({}, process.cwd());

export function createDefaultSystemConfig(): SystemConfig {
  return systemConfigSchema.parse({});
}

/** Configure the process once at startup from the single JSON configuration table. */
export function configureSystem(input: unknown, options?: { workspaceRoot?: string; configPath?: string }): ResolvedConfig {
  const workspaceRoot = path.resolve(options?.workspaceRoot ?? process.cwd());
  config = buildResolvedConfig(input, workspaceRoot, options?.configPath);
  return config;
}

export function loadSystemConfig(options: { workspaceRoot: string; configPath?: string }): ResolvedConfig {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const configPath = path.resolve(options.configPath ?? path.join(workspaceRoot, CONFIG_FILE_NAME));
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Configuration file not found: ${configPath}. ` +
      'Run "one-agent --init" or copy one-agent.config.example.json.',
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return configureSystem(input, { workspaceRoot, configPath });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const detail = error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
      throw new Error(`Invalid configuration in ${configPath}: ${detail}`);
    }
    throw error;
  }
}

export function redactSystemConfig(value: SystemConfig = config): SystemConfig {
  return {
    ...value,
    model: {
      ...value.model,
      apiKey: value.model.apiKey ? '[REDACTED]' : '',
      fallback: value.model.fallback
        ? { ...value.model.fallback, apiKey: value.model.fallback.apiKey ? '[REDACTED]' : '' }
        : undefined,
    },
    tools: {
      ...value.tools,
      search: {
        ...value.tools.search,
        apiKey: value.tools.search.apiKey ? '[REDACTED]' : undefined,
      },
    },
  };
}

export type Config = ResolvedConfig;
