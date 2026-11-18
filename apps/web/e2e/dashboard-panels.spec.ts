import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * D3 dashboard row 3 and drill-down (docs/40 §3, D144) on the mock API: «waiting for action» and
 * «recent events» are on the staff home with their links, each chart opens the list behind it, and
 * the page passes axe with no sideways scroll at 375, 768 and 1440 px in Arabic and English.
 */
const RUNS = [
  { width: 375, lang: 'ar' },
  { width: 375, lang: 'en' },
  { width: 768, lang: 'ar' },
  { width: 768, lang: 'en' },
  { width: 1440, lang: 'ar' },
  { width: 1440, lang: 'en' },
] as const;

const TEXT = {
  ar: {
    waiting: 'بانتظار إجراء',
    events: 'آخر الأحداث',
    leads: /عملاء محتملون لم يُتواصل معهم/,
    payment: 'تحصيل دفعة',
    more: 'عرض المزيد',
    details: /^التفاصيل: .?نتائج الحصص/,
  },
  en: {
    waiting: 'Waiting for action',
    events: 'Recent events',
    leads: /Leads not contacted/,
    payment: 'Payment received',
    more: 'Show more',
    details: /^Details: .?Class outcomes/,
  },
} as const;

async function open(page: Page, width: number, lang: 'ar' | 'en') {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/login?next=%2F');
  await login(page);
  await page.waitForURL((u) => u.pathname === '/');
  if (lang === 'en') {
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  }
  await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
}

const cardOf = (page: Page, title: string) =>
  page.locator('[data-slot="card"]').filter({
    has: page.getByRole('heading', { level: 3, name: title, exact: true }),
  });

for (const run of RUNS) {
  test(`D3 panels ${run.width}px ${run.lang}: waiting, events, drill-down; axe`, async ({
    page,
  }) => {
    const x = TEXT[run.lang];
    await open(page, run.width, run.lang);
    const waiting = cardOf(page, x.waiting);
    await waiting.scrollIntoViewIfNeeded();
    await expect(waiting.getByRole('link', { name: x.leads })).toHaveAttribute(
      'href',
      '/leads?uncontacted=1',
    );
    const events = cardOf(page, x.events);
    await expect(events.getByRole('listitem')).toHaveCount(8);
    await expect(events.getByText(x.payment).first()).toBeVisible();
    await expect(page.getByRole('link', { name: x.details })).toHaveAttribute('href', /^\/today/);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });
}

test('D3 (1440, Arabic): more events page back; a queue opens its list', async ({ page }) => {
  await open(page, 1440, 'ar');
  const events = cardOf(page, 'آخر الأحداث');
  await events.getByRole('button', { name: 'عرض المزيد' }).click();
  await expect(events.getByRole('listitem')).toHaveCount(12);
  await expect(events.getByRole('button', { name: 'عرض المزيد' })).toHaveCount(0);
  await cardOf(page, 'بانتظار إجراء')
    .getByRole('link', { name: /طلبات إجازة معلّقة/ })
    .click();
  await expect(page).toHaveURL(/\/requests\?type=leave/);
});
