import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // better-sqlite3 (native addon) can segfault during worker-thread
    // teardown on Node 25 — after all tests have passed — failing the whole
    // `pnpm test` chain. Running in forked processes avoids the native
    // cleanup race without changing what is tested.
    pool: 'forks',
  },
});
