import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'client/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['shared/src/**/*.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
});