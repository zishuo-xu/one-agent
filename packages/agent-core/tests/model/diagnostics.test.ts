import { describe, expect, it } from 'vitest';
import { diagnoseModelProviders } from '../../src/model/diagnostics.js';
import { FallbackProvider } from '../../src/model/FallbackProvider.js';
import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../../src/model/types.js';

const FULL_CAPABILITIES: ModelCapabilities = {
  streaming: 'native',
  toolCalling: 'native',
  structuredOutput: 'best_effort',
  reasoning: 'best_effort',
};

function healthyProvider(name: string): ModelProvider {
  return {
    name,
    model: `${name}-model`,
    endpoint: `https://${name}.example.test`,
    credentialConfigured: true,
    capabilities: FULL_CAPABILITIES,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.tools?.length) {
        return {
          content: '',
          toolCalls: [{ id: 'probe-1', name: 'one_agent_doctor_probe', arguments: '{}' }],
        };
      }
      return { content: 'ONE_AGENT_DOCTOR_OK' };
    },
    async *stream() {
      yield { content: 'STREAM_OK' };
    },
  };
}

describe('model diagnostics', () => {
  it('probes connection, streaming and normalized tool calls without an Agent Run', async () => {
    const report = await diagnoseModelProviders(healthyProvider('primary'), { timeoutMs: 1234 });

    expect(report.ready).toBe(true);
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]).toMatchObject({
      role: 'primary',
      provider: 'primary',
      endpoint: 'https://primary.example.test',
      ready: true,
    });
    expect(report.providers[0].checks.map((check) => [check.name, check.status])).toEqual([
      ['credential', 'pass'],
      ['capabilityContract', 'pass'],
      ['connection', 'pass'],
      ['streaming', 'pass'],
      ['toolCalling', 'pass'],
    ]);
  });

  it('diagnoses every member of a fallback chain independently', async () => {
    const provider = new FallbackProvider([
      healthyProvider('primary'),
      healthyProvider('fallback'),
    ]);

    const report = await diagnoseModelProviders(provider);

    expect(report.ready).toBe(true);
    expect(report.providers.map((item) => [item.role, item.provider])).toEqual([
      ['primary', 'primary'],
      ['fallback', 'fallback'],
    ]);
  });

  it('reports contract and live failures while redacting credentials', async () => {
    const failing: ModelProvider = {
      name: 'broken',
      model: 'broken-model',
      credentialConfigured: false,
      capabilities: { ...FULL_CAPABILITIES, toolCalling: 'unsupported' },
      async complete(request) {
        if (request.tools?.length) return { content: 'ignored' };
        throw new Error('Authorization: Bearer sk-secretvalue123456');
      },
      async *stream() {},
    };

    const report = await diagnoseModelProviders(failing);

    expect(report.ready).toBe(false);
    const checks = Object.fromEntries(
      report.providers[0].checks.map((check) => [check.name, check]),
    );
    expect(checks.credential.status).toBe('fail');
    expect(checks.capabilityContract.status).toBe('fail');
    expect(checks.connection.message).toContain('[redacted]');
    expect(checks.connection.message).not.toContain('secretvalue');
    expect(checks.streaming.status).toBe('fail');
    expect(checks.toolCalling.status).toBe('fail');
  });
});
