import { defineConfig, devices } from '@playwright/test';

/**
 * Default: E2E against a production build (`next build && next start`) with the MSW mocks on.
 * The build goes to `.next-e2e`, so it never replaces the real `.next` build.
 *
 * `E2E_REAL_API=1`: runs only `e2e/real-api.spec.ts` against the real NestJS API (apps/api, its
 * `.env` dev database, port 3001) and the web app on http://localhost:3000 (the API's WEB_ORIGIN).
 */
const REAL_API = process.env.E2E_REAL_API === '1';
/** Ports can be moved when another checkout already serves 3000/3001/3200 (`E2E_PORT`, `E2E_API_PORT`). */
const PORT = Number(process.env.E2E_PORT) || (REAL_API ? 3000 : 3200);
const API_PORT = Number(process.env.E2E_API_PORT) || 3001;
/** `E2E_BASE_URL`: run against a server you started yourself (e.g. `pnpm dev:mocks`); no build. */
const BASE_URL = process.env.E2E_BASE_URL;
/** `E2E_BASE_PATH=/app`: build and serve under a path (N8: the app stays at api.qarabic.com/app/). */
const BASE_PATH = process.env.E2E_BASE_PATH ?? '';

export default defineConfig({
  testDir: './e2e',
  testMatch: REAL_API ? 'real-api.spec.ts' : BASE_PATH ? 'base-path.spec.ts' : undefined,
  testIgnore: REAL_API || BASE_PATH ? undefined : ['real-api.spec.ts', 'base-path.spec.ts'],
  fullyParallel: !REAL_API,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'ar-EG',
    timezoneId: 'Africa/Cairo',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: BASE_URL
    ? undefined
    : REAL_API
      ? [
          {
            command: 'pnpm build && node --env-file-if-exists=.env dist/main.js',
            cwd: '../api',
            url: `http://localhost:${API_PORT}/api/v1/health`,
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
              NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
              NEXT_DIST_DIR: '.next-real',
              NEXT_TELEMETRY_DISABLED: '1',
            },
          },
        ]
      : {
          command: `next build && next start --port ${PORT}`,
          url: `http://localhost:${PORT}${BASE_PATH}/login`,
          reuseExistingServer: !process.env.CI,
          timeout: 240_000,
          env: {
            NEXT_PUBLIC_ENABLE_MOCKS: 'true',
            NEXT_PUBLIC_API_URL: '',
            NEXT_PUBLIC_BASE_PATH: BASE_PATH,
            NEXT_DIST_DIR: BASE_PATH ? '.next-e2e-base' : '.next-e2e',
            NEXT_TELEMETRY_DISABLED: '1',
          },
        },
});
