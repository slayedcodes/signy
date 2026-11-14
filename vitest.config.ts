import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'fixtures/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
