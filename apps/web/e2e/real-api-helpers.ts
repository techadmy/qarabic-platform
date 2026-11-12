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

/** E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, or SEED_ADMIN_* in apps/api/.env (never committed, never printed). */
export function seedAdmin(): { email: string; password: string } {
  const fromEnv = { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD };
  if (fromEnv.email && fromEnv.password) return fromEnv as { email: string; password: string };
  const file = fileURLToPath(new URL('../../api/.env', import.meta.url));
  const vars = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2]!.replace(/^(['"])(.*)\1$/, '$2')]),
  );
  return { email: vars.SEED_ADMIN_EMAIL, password: vars.SEED_ADMIN_PASSWORD };
}

export const SESSION_FILE = join(tmpdir(), 'qarabic-e2e-real-session.json');

/** Opens `path` as the seed admin: reuses the saved session, signs in (and saves it) only if needed. */
export async function signInReal(page: Page, path: string) {
  if (existsSync(SESSION_FILE)) {
    const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as {
      cookies: Parameters<BrowserContext['addCookies']>[0];
    };
    await page.context().addCookies(saved.cookies);
  }
  await page.goto(path);
  // The sign-in redirect may happen on the client: wait for either the form or the app's heading.
  await expect(page.locator('#password').or(page.locator('main h1').first())).toBeVisible();
  if (/\/login/.test(page.url())) {
    const admin = seedAdmin();
    await page.getByLabel('البريد الإلكتروني').fill(admin.email);
    await page.locator('#password').fill(admin.password);
    await page.getByRole('button', { name: 'دخول' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.context().storageState({ path: SESSION_FILE });
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
