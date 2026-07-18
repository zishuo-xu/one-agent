import { describe, expect, it } from 'vitest';
import {
  assertModelCapabilities,
  ModelCapabilityError,
} from '../../src/model/capabilities.js';
import type { ModelProvider } from '../../src/model/types.js';

function provider(): ModelProvider {
  return {
    name: 'capability-test',
    model: 'model-a',
    capabilities: {
      streaming: 'emulated',
      toolCalling: 'best_effort',
      structuredOutput: 'unsupported',
      reasoning: 'best_effort',
    },
    complete: async () => ({ content: '' }),
    stream: async function* () { yield {}; },
  };
}

describe('model capability contract', () => {
  it('accepts native and Provider-emulated guarantees', () => {
    expect(() => assertModelCapabilities(provider(), ['streaming'], 'test runtime')).not.toThrow();
  });

  it('reports every capability that is not guaranteed', () => {
    try {
      assertModelCapabilities(
        provider(),
        ['streaming', 'toolCalling', 'structuredOutput'],
        'test runtime',
      );
      throw new Error('expected capability validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCapabilityError);
      expect(error).toMatchObject({
        provider: 'capability-test',
        model: 'model-a',
        missing: ['toolCalling', 'structuredOutput'],
      });
    }
  });
});
