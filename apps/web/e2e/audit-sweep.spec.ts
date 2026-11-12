import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { login } from './helpers';

/**
 * UI audit sweep (the `ui-ux-audit` skill; not a CI gate): every N1–N7 route for staff, teacher and
 * parent at 375/768/1440 × Arabic/English; records serious/critical axe violations, horizontal
 * overflow, h1 and main-landmark counts as JSON, one file per role × width × language.
 * Runs only with AUDIT_OUT set: `AUDIT_OUT=/tmp/audit pnpm --filter @qarabic/web test:e2e audit-sweep`.
 */
const OUT = process.env.AUDIT_OUT;
test.skip(!OUT, 'AUDIT_OUT not set');
const ROUTES: Record<string, string[]> = {
  'admin@qarabic.test': [
    '/',
    '/today',
    '/schedule',
    '/schedule/1',
    '/schedule/new',
    '/schedule/availability',
    '/requests',
    '/leads',
    '/leads/1',
    '/lesson-reports',
    '/tests',
    '/tests/1',
    '/support',
    '/tickets/1',
    '/feedback',
    '/families',
    '/families/1',
    '/students',
    '/students/1',
    '/teachers',
    '/teachers/1',
    '/teachers/1/timetable',
    '/staff',
    '/staff/1',
    '/invoices',
    '/invoices/4',
    '/packages',
    '/attendance',
    '/fines',
    '/payroll',
    '/payroll/runs/1',
    '/payroll/profiles',
    '/payroll/wallets',
    '/holidays',
    '/settings/sessions',
    '/settings/support',
    '/settings/crm',
    '/settings/billing',
    '/settings/pay-rules',
    '/roles',
    '/roles/1',
    '/roles/new',
    '/account',
  ],
  'teacher@qarabic.test': [
    '/',
    '/my-classes',
    '/my-students',
    '/my-schedule',
    '/attendance',
    '/payroll/me',
    '/my-requests',
  ],
  'parent@qarabic.test': ['/', '/my-family', '/my-classes', '/invoices', '/my-requests'],
};

async function check(
  rows: unknown[],
  page: Page,
  who: string,
  path: string,
  width: number,
  lang: string,
) {
  await page.goto(path);
  await expect(page.locator('#main h1, main h1').first())
    .toBeVisible({ timeout: 15_000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  const h1 = await page.locator('h1').count();
  const mains = await page.locator('main').count();
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const v = res.violations
    .filter((x) => x.impact === 'serious' || x.impact === 'critical')
    .map((x) => ({ id: x.id, n: x.nodes.length, t: x.nodes[0]?.target.join(' ') }));
  const moderate = res.violations
    .filter((x) => x.impact === 'moderate' || x.impact === 'minor')
    .map((x) => x.id);
  rows.push({ who, path, width, lang, overflow, h1, mains, serious: v, moderate });
}

for (const [who, paths] of Object.entries(ROUTES)) {
  for (const width of [375, 768, 1440]) {
    for (const lang of ['ar', 'en'] as const) {
      test(`${who} ${width} ${lang}`, async ({ page }) => {
        test.setTimeout(600_000);
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/login');
        await login(page, who);
        await expect(page.locator('main h1').first()).toBeVisible();
        if (lang === 'en') {
          await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
          await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
        }
        const rows: unknown[] = [];
        for (const p of paths) await check(rows, page, who, p, width, lang);
        writeFileSync(`${OUT}/${who.split('@')[0]}-${width}-${lang}.json`, JSON.stringify(rows));
      });
    }
  }
}
