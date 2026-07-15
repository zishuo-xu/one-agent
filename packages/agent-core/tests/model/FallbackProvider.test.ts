import { describe, it, expect } from 'vitest';
import { FallbackProvider, defaultShouldFallback } from '../../src/model/FallbackProvider.js';
import type { ModelChunk, ModelProvider, ModelRequest, ModelResponse } from '../../src/model/types.js';

function makeProvider(
  name: string,
  behavior: {
    complete?: (req: ModelRequest) => Promise<ModelResponse>;
    stream?: (req: ModelRequest) => AsyncIterable<ModelChunk>;
  } = {},
): ModelProvider {
  return {
    name,
    model: `${name}-model`,
    complete: behavior.complete ?? (async () => ({ content: `ok:${name}` })),
    stream:
      behavior.stream ??
      (async function* () {
        yield { content: `ok:${name}` };
      }),
  };
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('defaultShouldFallback', () => {
  it('falls back on 5xx, 429 and transport-level errors', () => {
    expect(defaultShouldFallback(httpError(500))).toBe(true);
    expect(defaultShouldFallback(httpError(503))).toBe(true);
    expect(defaultShouldFallback(httpError(429))).toBe(true);
    expect(defaultShouldFallback(new Error('ECONNRESET'))).toBe(true);
    expect(defaultShouldFallback(new Error('fetch failed'))).toBe(true);
  });

  it('does not fall back on 4xx client errors or aborts', () => {
    expect(defaultShouldFallback(httpError(400))).toBe(false);
    expect(defaultShouldFallback(httpError(401))).toBe(false);
    expect(defaultShouldFallback(httpError(404))).toBe(false);
    expect(defaultShouldFallback(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('FallbackProvider', () => {
  it('requires at least one provider', () => {
    expect(() => new FallbackProvider([])).toThrow('at least one provider');
  });

  it('exposes the primary provider model', () => {
    const provider = new FallbackProvider([makeProvider('primary'), makeProvider('fallback')]);
    expect(provider.model).toBe('primary-model');
    expect(provider.name).toBe('fallback');
  });

  describe('complete', () => {
    it('uses the primary provider when it succeeds', async () => {
      const provider = new FallbackProvider([makeProvider('primary'), makeProvider('fallback')]);

      const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      expect(response.content).toBe('ok:primary');
    });

    it('falls back on retryable errors', async () => {
      const primary = makeProvider('primary', {
        complete: async () => {
          throw httpError(500);
        },
      });
      const provider = new FallbackProvider([primary, makeProvider('fallback')]);

      const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      expect(response.content).toBe('ok:fallback');
    });

    it('does not fall back on 4xx client errors', async () => {
      const primary = makeProvider('primary', {
        complete: async () => {
          throw httpError(400);
        },
      });
      const provider = new FallbackProvider([primary, makeProvider('fallback')]);

      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow('HTTP 400');
    });

    it('throws the last error when every provider fails', async () => {
      const primary = makeProvider('primary', {
        complete: async () => {
          throw httpError(500);
        },
      });
      const fallback = makeProvider('fallback', {
        complete: async () => {
          throw httpError(503);
        },
      });
      const provider = new FallbackProvider([primary, fallback]);

      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow('HTTP 503');
    });
  });

  describe('stream', () => {
    it('streams from the primary provider when healthy', async () => {
      const provider = new FallbackProvider([makeProvider('primary'), makeProvider('fallback')]);

      const chunks = await collect(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(chunks).toEqual([{ content: 'ok:primary' }]);
    });

    it('fails over when the primary errors before the first chunk', async () => {
      const primary = makeProvider('primary', {
        stream: async function* () {
          throw new Error('ECONNRESET');
        },
      });
      const provider = new FallbackProvider([primary, makeProvider('fallback')]);

      const chunks = await collect(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(chunks).toEqual([{ content: 'ok:fallback' }]);
    });

    it('does NOT fail over after the first chunk has been emitted', async () => {
      const primary = makeProvider('primary', {
        stream: async function* () {
          yield { content: 'partial' };
          throw httpError(500);
        },
      });
      const provider = new FallbackProvider([primary, makeProvider('fallback')]);

      const chunks: ModelChunk[] = [];
      const consume = (async () => {
        for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          chunks.push(chunk);
        }
      })();

      await expect(consume).rejects.toThrow('HTTP 500');
      // Partial output was preserved and NOT duplicated by a fallback retry.
      expect(chunks).toEqual([{ content: 'partial' }]);
    });
  });
});
