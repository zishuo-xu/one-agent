export const DEFAULT_EVAL_CONCURRENCY = 4;

export function parseEvalConcurrency(argv: readonly string[]): number {
  const index = argv.indexOf('--concurrency');
  if (index === -1) {
    return DEFAULT_EVAL_CONCURRENCY;
  }

  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith('-')) {
    throw new Error('--concurrency requires a positive integer');
  }

  const concurrency = Number(raw);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got ${raw}`);
  }
  return concurrency;
}
