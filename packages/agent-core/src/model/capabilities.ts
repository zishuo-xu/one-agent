import type {
  ModelCapabilities,
  ModelCapabilitySupport,
  ModelProvider,
  RequiredModelCapability,
} from './types.js';

const SUPPORT_RANK: Record<ModelCapabilitySupport, number> = {
  unsupported: 0,
  best_effort: 1,
  emulated: 2,
  native: 3,
};

function weakestSupport(values: ModelCapabilitySupport[]): ModelCapabilitySupport {
  return values.reduce((weakest, value) =>
    SUPPORT_RANK[value] < SUPPORT_RANK[weakest] ? value : weakest,
  );
}

/** A fallback chain can guarantee only the weakest capability of every member. */
export function intersectModelCapabilities(providers: ModelProvider[]): ModelCapabilities {
  if (providers.length === 0) {
    throw new Error('Cannot intersect capabilities of an empty provider list');
  }
  const windows = providers.map((provider) => provider.capabilities.contextWindow);
  return {
    streaming: weakestSupport(providers.map((provider) => provider.capabilities.streaming)),
    toolCalling: weakestSupport(providers.map((provider) => provider.capabilities.toolCalling)),
    structuredOutput: weakestSupport(
      providers.map((provider) => provider.capabilities.structuredOutput),
    ),
    reasoning: weakestSupport(providers.map((provider) => provider.capabilities.reasoning)),
    contextWindow: windows.every((value): value is number => typeof value === 'number')
      ? Math.min(...windows)
      : undefined,
  };
}

export class ModelCapabilityError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    readonly missing: RequiredModelCapability[],
    context: string,
  ) {
    super(
      `Model provider ${provider}/${model} cannot satisfy ${context}; ` +
      `required capabilities not guaranteed: ${missing.join(', ')}`,
    );
    this.name = 'ModelCapabilityError';
  }
}

/** Hard requirements accept native or Provider-emulated support only. */
export function assertModelCapabilities(
  provider: ModelProvider,
  required: RequiredModelCapability[],
  context: string,
): void {
  const missing = required.filter((capability) => {
    const support = provider.capabilities[capability];
    return support !== 'native' && support !== 'emulated';
  });
  if (missing.length > 0) {
    throw new ModelCapabilityError(provider.name, provider.model, missing, context);
  }
}
