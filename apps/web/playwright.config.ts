import { defineConfig, devices } from '@playwright/test';

const PORT = 3200;

/**
 * E2E against a production build (`next build && next start`) with the MSW mocks switched on.
 * The build goes to `.next-e2e`, so it never replaces the real `.next` build.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
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
  webServer: {
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
