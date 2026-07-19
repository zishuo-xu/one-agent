import { assertModelCapabilities, ModelCapabilityError } from './capabilities.js';
import { FallbackProvider } from './FallbackProvider.js';
import type {
  ModelCapabilities,
  ModelProvider,
  ModelToolDefinition,
} from './types.js';

export type ModelDiagnosticStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type ModelDiagnosticCheckName =
  | 'credential'
  | 'capabilityContract'
  | 'connection'
  | 'streaming'
  | 'toolCalling';

export interface ModelDiagnosticCheck {
  name: ModelDiagnosticCheckName;
  status: ModelDiagnosticStatus;
  message: string;
  latencyMs?: number;
}

export interface ModelProviderDiagnostic {
  role: 'primary' | 'fallback';
  index: number;
  provider: string;
  model: string;
  endpoint?: string;
  capabilities: Readonly<ModelCapabilities>;
  checks: ModelDiagnosticCheck[];
  ready: boolean;
}

export interface ModelDiagnosticReport {
  providers: ModelProviderDiagnostic[];
  ready: boolean;
  checkedAt: string;
}

export interface ModelDiagnosticOptions {
  timeoutMs?: number;
}

const PROBE_TOOL: ModelToolDefinition = {
  name: 'one_agent_doctor_probe',
  description: 'Protocol diagnostic tool. Call it exactly once with an empty object.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

function providersInChain(provider: ModelProvider): ModelProvider[] {
  return provider instanceof FallbackProvider
    ? [...provider.providers]
    : [provider];
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|authorization|x-api-key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 500);
}

async function timedProbe(
  name: ModelDiagnosticCheckName,
  probe: () => Promise<string>,
): Promise<ModelDiagnosticCheck> {
  const started = Date.now();
  try {
    const message = await probe();
    return { name, status: 'pass', message, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      name,
      status: 'fail',
      message: safeErrorMessage(error),
      latencyMs: Date.now() - started,
    };
  }
}

async function diagnoseProvider(
  provider: ModelProvider,
  index: number,
  timeoutMs: number,
): Promise<ModelProviderDiagnostic> {
  const checks: ModelDiagnosticCheck[] = [];
  checks.push(provider.credentialConfigured === undefined
    ? {
        name: 'credential',
        status: 'warn',
        message: 'Provider does not expose credential presence',
      }
    : {
        name: 'credential',
        status: provider.credentialConfigured ? 'pass' : 'fail',
        message: provider.credentialConfigured ? 'credential configured' : 'credential is missing',
      });

  try {
    assertModelCapabilities(provider, ['streaming', 'toolCalling'], 'interactive AgentRuntime');
    checks.push({
      name: 'capabilityContract',
      status: 'pass',
      message: 'streaming and tool calling are guaranteed',
    });
  } catch (error) {
    const missing = error instanceof ModelCapabilityError
      ? error.missing.join(', ')
      : safeErrorMessage(error);
    checks.push({
      name: 'capabilityContract',
      status: 'fail',
      message: `required capability is not guaranteed: ${missing}`,
    });
  }

  checks.push(await timedProbe('connection', async () => {
    const response = await provider.complete({
      messages: [
        { role: 'system', content: 'You are a protocol diagnostic. Follow the user exactly.' },
        { role: 'user', content: 'Reply with exactly ONE_AGENT_DOCTOR_OK.' },
      ],
      timeoutMs,
    });
    if (!response.content.trim() && !response.reasoning?.trim()) {
      throw new Error('model returned no text or reasoning content');
    }
    return 'non-streaming response received';
  }));

  checks.push(await timedProbe('streaming', async () => {
    let received = false;
    for await (const chunk of provider.stream({
      messages: [{ role: 'user', content: 'Reply with exactly STREAM_OK.' }],
      timeoutMs,
    })) {
      if (chunk.content?.trim() || chunk.reasoning?.trim()) received = true;
    }
    if (!received) throw new Error('stream completed without content');
    return 'stream content received';
  }));

  checks.push(await timedProbe('toolCalling', async () => {
    const response = await provider.complete({
      messages: [{
        role: 'user',
        content: 'Call the one_agent_doctor_probe tool exactly once with an empty object. Do not answer in text.',
      }],
      tools: [PROBE_TOOL],
      timeoutMs,
    });
    const call = response.toolCalls?.find((item) => item.name === PROBE_TOOL.name);
    if (!call) throw new Error('model did not return the required diagnostic tool call');
    return 'normalized tool call received';
  }));

  const ready = checks.every((check) => check.status !== 'fail');
  return {
    role: index === 0 ? 'primary' : 'fallback',
    index,
    provider: provider.name,
    model: provider.model,
    endpoint: provider.endpoint,
    capabilities: provider.capabilities,
    checks,
    ready,
  };
}

/** Explicit live protocol probes. No Agent Run, tool execution, or Trace is created. */
export async function diagnoseModelProviders(
  provider: ModelProvider,
  options: ModelDiagnosticOptions = {},
): Promise<ModelDiagnosticReport> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const providers = [];
  const chain = providersInChain(provider);
  for (let index = 0; index < chain.length; index++) {
    providers.push(await diagnoseProvider(chain[index], index, timeoutMs));
  }
  return {
    providers,
    ready: providers.every((item) => item.ready),
    checkedAt: new Date().toISOString(),
  };
}
