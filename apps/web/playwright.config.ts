import { defineConfig, devices } from '@playwright/test';

/**
 * Default: E2E against a production build (`next build && next start`) with the MSW mocks on.
 * The build goes to `.next-e2e`, so it never replaces the real `.next` build.
 *
 * `E2E_REAL_API=1`: runs only `e2e/real-api.spec.ts` against the real NestJS API (apps/api, its
 * `.env` dev database, port 3001) and the web app on http://localhost:3000 (the API's WEB_ORIGIN).
 */
const REAL_API = process.env.E2E_REAL_API === '1';
const PORT = REAL_API ? 3000 : 3200;

export default defineConfig({
  testDir: './e2e',
  testMatch: REAL_API ? 'real-api.spec.ts' : undefined,
  testIgnore: REAL_API ? undefined : 'real-api.spec.ts',
  fullyParallel: !REAL_API,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'ar-EG',
    timezoneId: 'Africa/Cairo',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: REAL_API
    ? [
        {
          command: 'pnpm build && node --env-file-if-exists=.env dist/main.js',
          cwd: '../api',
          url: 'http://localhost:3001/api/v1/health',
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: `next build && next start --port ${PORT}`,
          url: `http://localhost:${PORT}/login`,
          reuseExistingServer: true,
          timeout: 240_000,
          env: {
            NEXT_PUBLIC_ENABLE_MOCKS: 'false',
            NEXT_PUBLIC_API_URL: 'http://localhost:3001',
            NEXT_DIST_DIR: '.next-real',
            NEXT_TELEMETRY_DISABLED: '1',
          },
        },
      ]
    : {
        command: `next build && next start --port ${PORT}`,
        url: `http://localhost:${PORT}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        env: {
          NEXT_PUBLIC_ENABLE_MOCKS: 'true',
          NEXT_PUBLIC_API_URL: '',
          NEXT_DIST_DIR: '.next-e2e',
          NEXT_TELEMETRY_DISABLED: '1',
        },
      },
});
