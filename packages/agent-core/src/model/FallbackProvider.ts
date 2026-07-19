import type { ModelChunk, ModelProvider, ModelRequest, ModelResponse } from './types.js';
import { intersectModelCapabilities } from './capabilities.js';

export type FallbackPredicate = (error: unknown) => boolean;

/**
 * Default fallback policy: switch providers on server errors (5xx), rate
 * limits (429), and transport-level failures (no HTTP status: DNS, connection
 * reset, timeout). Never switch on aborts, and never on client errors (4xx
 * other than 429) — those requests would fail identically on any provider.
 */
export function defaultShouldFallback(error: unknown): boolean {
  if ((error as { name?: string })?.name === 'AbortError') return false;
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number') {
    return status >= 500 || status === 429;
  }
  return true;
}

/**
 * Tries providers in order. Streaming only fails over before the first chunk
 * has been yielded — once a stream starts, errors propagate so partially
 * emitted output is never duplicated by a silent retry on another provider.
 */
export class FallbackProvider implements ModelProvider {
  readonly name = 'fallback';
  readonly model: string;
  readonly capabilities;

  readonly providers: readonly ModelProvider[];

  constructor(
    providers: ModelProvider[],
    private readonly shouldFallback: FallbackPredicate = defaultShouldFallback,
  ) {
    if (providers.length === 0) {
      throw new Error('FallbackProvider requires at least one provider');
    }
    this.providers = Object.freeze([...providers]);
    this.model = this.providers[0].model;
    this.capabilities = Object.freeze(intersectModelCapabilities([...this.providers]));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        return await provider.complete(request);
      } catch (error) {
        if (!this.shouldFallback(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    let lastError: unknown;
    for (const provider of this.providers) {
      const iterator = provider.stream(request)[Symbol.asyncIterator]();
      let first: IteratorResult<ModelChunk>;
      try {
        // Pull the first chunk BEFORE committing: if this provider fails up
        // front, nothing was emitted yet and we may safely fail over.
        first = await iterator.next();
      } catch (error) {
        if (!this.shouldFallback(error)) {
          throw error;
        }
        lastError = error;
        continue;
      }
      if (first.done) {
        return;
      }
      yield first.value;
      // Committed to this provider; later errors propagate to the caller.
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    }
    throw lastError;
  }
}
