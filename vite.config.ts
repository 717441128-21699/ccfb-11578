import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
