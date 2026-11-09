import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
