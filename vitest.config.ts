import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'fixtures/**/*.test.ts'],
    // Test files run one at a time: they all spawn git, which contends badly on Windows.
    fileParallelism: false,
    // Fixtures build real git repos; git start-up is slow and erratic on Windows.
    testTimeout: 120_000,
  },
});
