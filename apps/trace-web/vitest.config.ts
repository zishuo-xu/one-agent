import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // better-sqlite3 is a native addon. Isolate it in a child process instead
    // of a worker thread so connection finalizers cannot crash Vitest teardown.
    pool: 'forks',
  },
});
