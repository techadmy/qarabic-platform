import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'e2e/**', '.next/**', '.next-e2e/**'],
    css: false,
    // Form flows type many keys; under a loaded CI (turbo runs the API suite alongside) 5 s was
    // too tight and the N1 «creates a family» flow timed out now and then.
    testTimeout: 15_000,
  },
});
