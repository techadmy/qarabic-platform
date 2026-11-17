import { randomBytes } from 'node:crypto';

/**
 * The journeys' shared settings. Throwaway secrets are made per run unless already set (CI sets its
 * own) and kept in `process.env`, so the Playwright workers (which load the config again), the
 * global setup and the servers all see the same values. Nothing here is a real credential.
 */
export const API_PORT = Number(process.env.JOURNEYS_API_PORT) || 3101;
export const WEB_PORT = Number(process.env.JOURNEYS_WEB_PORT) || 3100;

function once(name: string, make: () => string): string {
  process.env[name] ||= make();
  return process.env[name]!;
}

export const DATABASE_URL = once(
  'JOURNEYS_DATABASE_URL',
  () => 'postgresql://qarabic:qarabic@localhost:5432/qarabic_journeys_test',
);
once('QA_PASSWORD', () => randomBytes(12).toString('hex'));
once('QA_ZOOM_WEBHOOK_SECRET', () => randomBytes(16).toString('hex'));
const SESSION_SECRET = once('JOURNEYS_SESSION_SECRET', () => randomBytes(32).toString('hex'));
const ENCRYPTION_KEY = once('JOURNEYS_ENCRYPTION_KEY', () => randomBytes(32).toString('base64'));
/** The API base the specs call directly (sign-in, lookups, the simulated Zoom webhook). */
export const API = `http://localhost:${API_PORT}/api/v1`;

/** The API process's environment: test mode, no scheduler, Zoom tracking on with made-up keys. */
export const apiEnv: Record<string, string> = {
  DATABASE_URL,
  NODE_ENV: 'test',
  PORT: String(API_PORT),
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  APP_URL: `http://localhost:${WEB_PORT}`,
  LOG_LEVEL: 'warn',
  SESSION_SECRET,
  APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  SCHEDULER_ENABLED: 'false',
  ZOOM_DRIVER: 's2s',
  ZOOM_ACCOUNT_ID: 'qa-account',
  ZOOM_CLIENT_ID: 'qa-client',
  ZOOM_CLIENT_SECRET: 'qa-client-secret',
  ZOOM_WEBHOOK_SECRET: process.env.QA_ZOOM_WEBHOOK_SECRET!,
  PUSH_DRIVER: 'none',
  QA_PASSWORD: process.env.QA_PASSWORD!,
};
