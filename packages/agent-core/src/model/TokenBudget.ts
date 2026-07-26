import type { TokenUsage } from './types.js';

export class AgentTokenBudgetExceededError extends Error {
  readonly observedTokens: number;
  readonly limit: number;

  constructor(label: string, observedTokens: number, limit: number) {
    super(`${label} token budget exhausted: observed ${observedTokens} tokens reached the ${limit} token limit`);
    this.name = 'AgentTokenBudgetExceededError';
    this.observedTokens = observedTokens;
    this.limit = limit;
  }
}

/**
 * Per-agent cumulative model-usage guard.
 *
 * Providers generally report authoritative usage only after a request
 * completes, so the guard stops the next model request once the configured
 * limit has been reached. A single in-flight request may finish above the
 * threshold, but no later request is admitted.
 */
export class AgentTokenBudget {
  private observedTokens = 0;

  constructor(
    private readonly label: string,
    private readonly limit?: number,
  ) {}

  reset(): void {
    this.observedTokens = 0;
  }

  observe(usage?: TokenUsage): void {
    this.observedTokens += usage?.totalTokens ?? 0;
  }

  assertCanCall(): void {
    if (this.limit !== undefined && this.observedTokens >= this.limit) {
      throw new AgentTokenBudgetExceededError(
        this.label,
        this.observedTokens,
        this.limit,
      );
    }
  }

  getObservedTokens(): number {
    return this.observedTokens;
  }
}
