import { expect, test, type Page, type Response } from '@playwright/test';
import { login } from './helpers';

/**
 * docs/39 P0-2: every page carries the app's Content-Security-Policy with a fresh nonce on Next's
 * own scripts, framing refused, and the console reports no CSP violation. (HSTS, nosniff,
 * Referrer-Policy and X-Frame-Options come from nginx in front of the app; see deploy/nginx.)
 */
function cspOf(response: Response | null) {
  const csp = response?.headers()['content-security-policy'] ?? '';
  return {
    csp,
    nonce: /'nonce-([^']+)'/.exec(csp)?.[1] ?? null,
  };
}

async function watchViolations(page: Page) {
  const seen: string[] = [];
  page.on('console', (m) => {
    if (/Content[- ]Security[- ]Policy/i.test(m.text())) seen.push(m.text());
  });
  return seen;
}

for (const path of ['/login', '/', '/invoices']) {
  test(`${path}: CSP with a nonce, frame-ancestors 'none', no violations`, async ({ page }) => {
    const seen = await watchViolations(page);
    if (path !== '/login') {
      await page.goto('/login');
      await login(page);
      await expect(page.locator('main h1').first()).toBeVisible();
    }
    const response = await page.goto(path);
    const { csp, nonce } = cspOf(response);
    expect(csp).toContain(`frame-ancestors 'none'`);
    expect(csp).toContain(`object-src 'none'`);
    expect(csp).toContain(`base-uri 'self'`);
    expect(csp).toMatch(/script-src [^;]*'strict-dynamic'/);
    expect(nonce).toBeTruthy();
    // Next put that nonce on its own scripts.
    expect(await page.locator(`script[nonce]`).count()).toBeGreaterThan(0);
    await expect(page.locator('main h1, h1').first()).toBeVisible();
    expect(seen).toEqual([]);
  });
}

test('each response gets its own nonce', async ({ page }) => {
  const a = cspOf(await page.goto('/login')).nonce;
  const b = cspOf(await page.goto('/login')).nonce;
  expect(a).toBeTruthy();
  expect(a).not.toBe(b);
});

test('the page refuses to be framed', async ({ page, baseURL }) => {
  await page.setContent(`<iframe id="f" src="${baseURL}/login"></iframe>`);
  const frame = page.frameLocator('#f');
  await expect(frame.locator('#password')).toHaveCount(0, { timeout: 5_000 });
});
