import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * e2e tests run against TEST_DATABASE_URL only, and refuse any database whose name does not end in
 * `_test` (tables are truncated between tests).
 */
export function applyTestEnv(): void {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see apps/api/.env.example).');
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must point to a database whose name ends in _test.');
  }
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    WEB_ORIGIN: 'http://localhost:3000',
    APP_URL: 'http://localhost:3000',
    SESSION_SECRET: 'test-only-secret-0123456789abcdef0123456789',
  });
  delete process.env.COOKIE_DOMAIN;
}
