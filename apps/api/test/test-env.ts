import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // No timers in tests: jobs are called directly. Zoom tests swap in the fake driver.
    SCHEDULER_ENABLED: 'false',
    // Fixed test-only key (32 bytes of 0x07): refused in production like the placeholder.
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ZOOM_DRIVER: 'none',
    // Ticket files on the local disk, in a throwaway folder (never the dev storage).
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: join(tmpdir(), `qarabic-test-storage-${process.pid}`),
    // WhatsApp intake off, as in production by default; tests switch it on with WhatsAppConfig.
    FEEDBACK_WHATSAPP_ENABLED: 'false',
    FEEDBACK_WHATSAPP_ALLOW_UNKNOWN: 'false',
  });
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  delete process.env.COOKIE_DOMAIN;
}
