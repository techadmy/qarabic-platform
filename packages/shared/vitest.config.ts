import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `pnpm test:coverage` (CI): thresholds a little under the level measured when they were set
    // (docs/39 P2-4); a drop fails.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reporter: ['text-summary'],
      thresholds: { statements: 87, branches: 52, functions: 68, lines: 89 },
    },
  },
});
