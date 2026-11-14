import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Shared by the real-API specs (`pnpm test:e2e:real`): the seed admin and a signed-in session that
 * is reused across tests, since the API allows 5 logins a minute per email.
 */
export const REAL_API = process.env.E2E_REAL_API === '1';

/** A variable from the environment, else from apps/api/.env (never committed, never printed). */
function setting(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const file = fileURLToPath(new URL('../../api/.env', import.meta.url));
  if (!existsSync(file)) return undefined;
  const vars = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2]!.replace(/^(['"])(.*)\1$/, '$2')]),
  );
  return vars[name];
}

export interface Account {
  email: string;
  password: string;
}

/** E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, or SEED_ADMIN_* in apps/api/.env. */
export function seedAdmin(): Account {
  return {
    email: (setting('E2E_ADMIN_EMAIL') ?? setting('SEED_ADMIN_EMAIL'))!,
    password: (setting('E2E_ADMIN_PASSWORD') ?? setting('SEED_ADMIN_PASSWORD'))!,
  };
}

/**
 * A made-up demo login of the seed (`parent1` London, `parent2` Toronto, `teacher1`…), with the
 * password `db:seed` set from SEED_DEMO_PASSWORD (E2E_DEMO_PASSWORD wins). Null when not set.
 */
export function demoAccount(local: string): Account | null {
  const password = setting('E2E_DEMO_PASSWORD') ?? setting('SEED_DEMO_PASSWORD');
  return password ? { email: `${local}@demo.qarabic.test`, password } : null;
}

export const SESSION_FILE = join(tmpdir(), 'qarabic-e2e-real-session.json');
const sessionFileOf = (account: Account) =>
  account.email === seedAdmin().email
    ? SESSION_FILE
    : join(tmpdir(), `qarabic-e2e-real-${account.email.replace(/[^a-z0-9]/gi, '-')}.json`);

/**
 * Opens `path` as `account` (the seed admin by default): reuses its saved session, signs in (and
 * saves it) only if needed — the API allows 5 logins a minute per email.
 */
export async function signInReal(page: Page, path: string, account: Account = seedAdmin()) {
  const file = sessionFileOf(account);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      cookies: Parameters<BrowserContext['addCookies']>[0];
    };
    await page.context().addCookies(saved.cookies);
  }
  await page.goto(path);
  // The sign-in redirect may happen on the client: wait for either the form or the app's heading.
  await expect(page.locator('#password').or(page.locator('main h1')).first()).toBeVisible();
  if (/\/login/.test(page.url())) {
    await page.getByLabel('البريد الإلكتروني').fill(account.email);
    await page.locator('#password').fill(account.password);
    await page.getByRole('button', { name: 'دخول' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.context().storageState({ path: file });
  }
  const pathname = path.split('?')[0]!;
  await expect(page).toHaveURL(new RegExp(`${pathname.replace(/[/]/g, '\\/')}(\\?.*)?$`));
}

/** No «تعذّر تحميل البيانات» on the page: every answer parsed with the shared schemas. */
export async function expectLoaded(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByText('تعذّر تحميل البيانات')).toHaveCount(0);
}

/** A short run-unique tag, so the flows can run again on the same dev database. */
export const runTag = () => `${Date.now() % 1_000_000}`;
