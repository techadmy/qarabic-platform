import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations } from './helpers';
import { type Account, demoAccount, REAL_API, signInReal } from './real-api-helpers';

/**
 * docs/39 P1-7 (E2E-1, E2E-2): the parent and teacher portals against the real API and the seeded
 * dev database — not the mocks. The seed's made-up demo logins (password from SEED_DEMO_PASSWORD):
 * parent 1 (London) and parent 2 (Toronto), each with invoices, and teacher 1. At 375 / 768 / 1440
 * in Arabic and English: every portal screen loads its real data (the shared schemas parse it), fits
 * without sideways scroll and has no serious axe issue; parent 1 opening parent 2's invoice URL gets
 * «not found», and never sees it in their list.
 */
test.skip(!REAL_API, 'set E2E_REAL_API=1 (needs the API and Postgres)');
test.skip(!demoAccount('parent1'), 'set SEED_DEMO_PASSWORD (db:seed) / E2E_DEMO_PASSWORD');

const API = `http://localhost:${Number(process.env.E2E_API_PORT) || 3001}/api/v1`;
const WIDTHS = { mobile: 375, tablet: 768, desktop: 1440 } as const;
const parentA = demoAccount('parent1')!;
const parentB = demoAccount('parent2')!;
const teacher = demoAccount('teacher1')!;

/** The ids of an account's own invoices, from the API with that account's session. */
async function invoiceIds(page: Page, account: Account): Promise<number[]> {
  await signInReal(page, '/', account);
  const res = await page.context().request.get(`${API}/invoices?perPage=100`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: { id: number }[] }).data.map((i) => i.id);
}

/** Arabic or English for this run. The switch is saved on the account: set it both ways. */
async function switchLanguage(page: Page, lang: 'ar' | 'en') {
  // The account's saved language replaces the cookie of the saved session once the app has
  // loaded the user: read it after a reload, then switch if needed.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main h1').first()).toBeVisible();
  const current = await page.locator('html').getAttribute('lang');
  if (current === lang) return;
  const label = lang === 'en' ? 'Switch to English' : 'التبديل إلى العربية';
  await page.locator('header').getByRole('button', { name: label }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
}

/** Every page: real data loaded, fits, axe. Reports all failing pages at once. */
async function sweep(page: Page, lang: 'ar' | 'en', paths: string[]) {
  const failures: string[] = [];
  for (const path of paths) {
    await test.step(path, async () => {
      try {
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        await expect(page.locator('main h1').first()).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
        await expect(page.getByText(/تعذّر تحميل البيانات|Could not load/)).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page);
      } catch (e) {
        failures.push(`${path}: ${(e as Error).message.split('\n').slice(0, 8).join(' ')}`);
      }
    });
  }
  expect(failures).toEqual([]);
}

let ownInvoice = 0;
let otherInvoice = 0;

test.describe.configure({ mode: 'serial' });

test('parent 1 sees only their invoices; parent 2’s invoice URL is «not found»', async ({
  page,
  browser,
}) => {
  const mine = await invoiceIds(page, parentA);
  const other = await browser.newContext();
  const theirs = await invoiceIds(await other.newPage(), parentB);
  await other.close();
  expect(mine.length, 'the seed gives parent 1 invoices').toBeGreaterThan(0);
  expect(theirs.length, 'the seed gives parent 2 invoices').toBeGreaterThan(0);
  expect(mine.filter((id) => theirs.includes(id))).toEqual([]);
  [ownInvoice] = mine as [number];
  [otherInvoice] = theirs as [number];

  await page.goto(`/invoices/${otherInvoice}`);
  await expect(page.getByText('الفاتورة غير موجودة')).toBeVisible();
  const api = await page.context().request.get(`${API}/invoices/${otherInvoice}`);
  expect(api.status()).toBe(404);

  await page.goto(`/invoices/${ownInvoice}`);
  // The parent's view titles the invoice by its month («فاتورة نوفمبر 2026 مستحقة»).
  await expect(page.getByRole('heading', { level: 1, name: /^فاتورة / })).toBeVisible();
});

for (const [name, width] of Object.entries(WIDTHS)) {
  for (const lang of ['ar', 'en'] as const) {
    test.describe(`${name} ${width}px ${lang}`, () => {
      test.use({ viewport: { width, height: 900 } });

      test('parent portal: real data, fits, axe', async ({ page }) => {
        test.setTimeout(120_000);
        await signInReal(page, '/', parentA);
        await switchLanguage(page, lang);
        await sweep(page, lang, [
          '/',
          '/my-family',
          '/my-requests',
          '/invoices',
          `/invoices/${ownInvoice || ''}`.replace(/\/$/, ''),
        ]);
      });

      test('teacher portal: real data, fits, axe', async ({ page }) => {
        test.setTimeout(120_000);
        await signInReal(page, '/', teacher);
        await switchLanguage(page, lang);
        await sweep(page, lang, [
          '/',
          '/my-classes',
          '/my-schedule',
          '/my-students',
          '/attendance',
          '/payroll',
        ]);
      });
    });
  }
}

test.afterAll(async ({ browser }) => {
  // Leave both accounts in Arabic (the switch is saved on the account).
  for (const account of [parentA, teacher]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInReal(page, '/', account);
    await switchLanguage(page, 'ar');
    await context.close();
  }
});
