import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * docs/standards/ui-ux.md on every screen that standards.spec.ts does not already sweep: each one,
 * signed in as the role that uses it, at 375 / 768 / 1440 px in Arabic (RTL) and English (LTR),
 * fits without sideways scrolling and has no serious or critical axe violation. Ids are the MSW
 * mock's (mocks/data.ts). A new page.tsx goes into one of the groups below (see the last test).
 */
const WIDTHS = { mobile: 375, tablet: 768, desktop: 1440 } as const;

const GROUPS: Record<string, { email: string | null; pages: string[] }> = {
  public: {
    email: null,
    pages: ['/login', '/forgot-password', '/reset-password?token=e2e', '/trial'],
  },
  'staff lists': {
    email: 'admin@qarabic.test',
    pages: [
      '/account',
      '/students',
      '/teachers',
      '/staff',
      '/roles',
      '/requests',
      '/holidays',
      '/lesson-reports',
      '/trials',
      '/tests',
      '/support',
      '/feedback',
      '/fines',
      '/packages',
    ],
  },
  'staff details': {
    email: 'admin@qarabic.test',
    pages: [
      '/families/1',
      '/students/1',
      '/staff/12',
      '/teachers/1',
      '/teachers/1/timetable',
      '/roles/4',
      '/roles/new',
      '/schedule/1',
      '/schedule/new',
      '/schedule/availability',
    ],
  },
  'staff records': {
    email: 'admin@qarabic.test',
    pages: [
      '/leads/1',
      '/tests/1',
      '/tickets/4',
      '/invoices/1',
      '/payroll/runs/2',
      '/payroll/payslips/2',
    ],
  },
  'staff settings': {
    email: 'admin@qarabic.test',
    pages: [
      '/payroll/profiles',
      '/payroll/wallets',
      '/settings/sessions',
      '/settings/support',
      '/settings/crm',
      '/settings/billing',
      '/settings/pay-rules',
    ],
  },
  parent: {
    email: 'parent@qarabic.test',
    pages: ['/', '/my-family', '/my-requests', '/invoices'],
  },
  teacher: {
    email: 'teacher@qarabic.test',
    pages: [
      '/',
      '/my-classes',
      '/my-schedule',
      '/my-students',
      '/attendance',
      '/payroll',
      '/payroll/me',
      '/fines',
    ],
  },
};

/** Covered by standards.spec.ts (admin) or not a product screen. */
const ELSEWHERE = [
  // operations.spec.ts sweeps tasks and announcements (375/768/1440 × ar/en, axe, no overflow).
  '/tasks',
  '/tasks/1',
  '/announcements',
  // accounting.spec.ts sweeps the accounting screens (375/768/1440 × ar/en, axe, no overflow).
  '/accounting/journal',
  '/accounting/journal/new',
  '/accounting/journal/1',
  '/accounting/vouchers',
  '/accounting/vouchers/1',
  '/accounting/accounts',
  '/accounting/accounts/4',
  '/accounting/reports',
  '/accounting/periods',
  '/',
  '/today',
  '/families',
  '/schedule',
  '/leads',
  '/invoices',
  '/payroll',
  '/attendance',
  '/dev/components',
  // Needs a recorded payment, and the mock seeds none: billing.spec.ts records one; the receipt
  // itself is listed as a gap in docs/31.
  '/invoices/1/receipts/1',
];

/**
 * Known layout bugs, reported to their owner and listed in docs/31: the sideways-scroll check is
 * skipped there (and fails once the page fits, so the entry gets removed). Key: `path@width`.
 */
// The student and teacher profiles at 768 px were here until main fixed them (2026-11-12).
const KNOWN_OVERFLOW: Record<string, string> = {};

async function overflowOf(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function settle(page: Page) {
  // Generous: six workers build axe reports at once.
  await expect(page.locator('main h1, h1').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
}

for (const [group, { email, pages }] of Object.entries(GROUPS)) {
  for (const [name, width] of Object.entries(WIDTHS)) {
    for (const lang of ['ar', 'en'] as const) {
      test(`${group} · ${name} ${width}px ${lang}: fit the screen and pass axe`, async ({
        page,
        context,
        baseURL,
      }) => {
        test.setTimeout(180_000); // up to 13 pages with axe each
        await page.setViewportSize({ width, height: 900 });
        if (email) {
          await page.goto('/login');
          await login(page, email);
          await expect(page.locator('main h1').first()).toBeVisible();
        }
        // Signed in: the header switch (the account's language wins over the cookie). Signed out:
        // the locale cookie.
        if (lang === 'en' && email) {
          await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
          await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
        } else if (lang === 'en') {
          await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL! }]);
        }
        const dir = lang === 'ar' ? 'rtl' : 'ltr';
        // Every page is checked; the test lists all the failing ones at the end.
        const failures: string[] = [];
        for (const path of pages) {
          await test.step(path, async () => {
            try {
              await page.goto(path);
              await expect(page.locator('html')).toHaveAttribute('dir', dir);
              await settle(page);
              const known = KNOWN_OVERFLOW[`${path}@${width}`];
              if (!known) await expectNoHorizontalScroll(page);
              else if ((await overflowOf(page)) <= 0) {
                throw new Error(`fits now: remove '${path}@${width}' from KNOWN_OVERFLOW`);
              } else test.info().annotations.push({ type: 'known issue', description: known });
              await expectNoSeriousA11yViolations(page);
            } catch (e) {
              failures.push(`${path}: ${(e as Error).message.split('\n').slice(0, 12).join(' ')}`);
            }
          });
        }
        expect(failures).toEqual([]);
      });
    }
  }
}

test('every page.tsx is in a standards sweep', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join, relative, sep } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../app', import.meta.url));
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'page.tsx') {
        const segs = relative(root, dir)
          .split(sep)
          .filter((s) => s && !/^\(.*\)$/.test(s));
        routes.push('/' + segs.join('/'));
      }
    }
  };
  walk(root);
  const swept = [...ELSEWHERE, ...Object.values(GROUPS).flatMap((g) => g.pages)].map(
    (p) => p.split('?')[0]!,
  );
  const covered = (route: string) => {
    const pattern = new RegExp(`^${route.replace(/\[[^\]]+\]/g, '[^/]+')}$`);
    return swept.some((p) => pattern.test(p));
  };
  expect(routes.filter((r) => !covered(r)).sort()).toEqual([]);
});
