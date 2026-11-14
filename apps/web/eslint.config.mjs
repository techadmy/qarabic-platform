import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import { defineConfig, globalIgnores } from 'eslint/config';
import { designTokens } from '../../packages/config/eslint/design-tokens.mjs';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Audit 39 P1-9: tokens and logical (RTL) utilities only.
  designTokens,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
  globalIgnores([
    '.next/**',
    '.next-*/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'public/mockServiceWorker.js',
    'playwright-report/**',
    'test-results/**',
  ]),
]);
