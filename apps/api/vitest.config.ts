import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (not esbuild) so Nest's decorators get `design:paramtypes` metadata for dependency injection.
const swcPlugin = swc.vite({ module: { type: 'es6' } });

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    // `pnpm test:e2e:coverage` (CI): the API's coverage comes from its e2e suite. Thresholds a little
    // under the level measured when they were set (docs/39 P2-4; re-measured
    // on vitest 4, which counts with AST-aware remapping): a drop fails.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', '**/*.spec.ts'],
      reporter: ['text-summary'],
      thresholds: { statements: 88, branches: 77, functions: 92, lines: 90 },
    },
    projects: [
      {
        plugins: [swcPlugin],
        test: { name: 'unit', include: ['src/**/*.spec.ts'], environment: 'node' },
      },
      {
        plugins: [swcPlugin],
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          environment: 'node',
          globalSetup: ['test/global-setup.ts'],
          setupFiles: ['test/setup-env.ts'],
          // One database: run every file in one process, one after another (vitest 4 form of the
          // old `poolOptions.forks.singleFork`).
          pool: 'forks',
          maxWorkers: 1,
          isolate: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
