import { defineConfig, devices } from '@playwright/test';
import { API_PORT, apiEnv, WEB_PORT } from './e2e-journeys/env';

/**
 * QA journeys (`pnpm --filter @qarabic/web test:journeys`, docs/standards/testing.md «Journeys»):
 * whole business scenarios across roles on the REAL stack — the built API (with an egress guard:
 * nothing leaves the machine), PostgreSQL and the production web build — no MSW mocks.
 *
 * The database must be a dedicated `*_test` one: `qa:seed` empties it and seeds the QA personas
 * (`JOURNEYS_DATABASE_URL`, default the local `qarabic_journeys_test`). Ports, throwaway secrets and
 * the API's environment: e2e-journeys/env.ts.
 */
export default defineConfig({
  testDir: './e2e-journeys',
  globalSetup: './e2e-journeys/global-setup.ts',
  outputDir: './journeys-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A journey is a story: a retry would start from the middle of it. Fail loudly instead.
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'journeys-report' }],
    ['./e2e-journeys/summary-reporter.ts', { outputFile: 'journeys-summary.json' }],
    ...(process.env.CI ? ([['github']] as const) : []),
  ],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ar-EG',
    timezoneId: 'Africa/Cairo',
  },
  projects: [{ name: 'journeys', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Built by the global setup's seed step or CI; `--import` loads the egress guard first.
      command: 'pnpm build && node --import ../web/e2e-journeys/no-egress.mjs dist/main.js',
      cwd: '../api',
      url: `http://localhost:${API_PORT}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: apiEnv,
    },
    {
      command: `next build && next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        NEXT_PUBLIC_ENABLE_MOCKS: 'false',
        NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
        NEXT_DIST_DIR: '.next-journeys',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
});
