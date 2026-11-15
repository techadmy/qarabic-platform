import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * docs/39 P2-4 (E2E-5): visual baselines of 10 key screens (MSW mocks, 1440 px, Arabic). The page
 * clock is pinned, so the mock data (built from it) is the same on every run; a layout shift of a
 * few pixels fails. Baselines are rendered on Linux by CI (`*-linux.png`, committed); on a Mac set
 * VISUAL_LOCAL=1 to compare against local `*-darwin.png` files (never committed).
 * After an intended change: `pnpm --filter @qarabic/web test:e2e visual --update-snapshots` on
 * Linux, or download the «visual-baselines» artifact of the CI run.
 */
test.skip(
  process.platform !== 'linux' && process.env.VISUAL_LOCAL !== '1',
  'baselines are rendered on Linux (CI); VISUAL_LOCAL=1 compares local ones',
);

/** Thursday 12 November 2026, 12:00 in Cairo: a working day with classes on the board. */
const NOW = new Date('2026-11-12T10:00:00Z');

const SCREENS: Array<[name: string, email: string, path: string]> = [
  ['staff-home', 'admin@qarabic.test', '/'],
  ['today-board', 'admin@qarabic.test', '/today'],
  ['families-list', 'admin@qarabic.test', '/families'],
  ['family-profile', 'admin@qarabic.test', '/families/1'],
  ['enrollment', 'admin@qarabic.test', '/schedule/1'],
  ['lead', 'admin@qarabic.test', '/leads/1'],
  ['invoice', 'admin@qarabic.test', '/invoices/1'],
  ['payroll-run', 'admin@qarabic.test', '/payroll/runs/2'],
  ['parent-home', 'parent@qarabic.test', '/'],
  ['teacher-classes', 'teacher@qarabic.test', '/my-classes'],
];

test.use({ viewport: { width: 1440, height: 900 } });

for (const [name, email, path] of SCREENS) {
  test(`visual: ${name} (${path})`, async ({ page }) => {
    // Fixed, not just started there: relative times («in 5 minutes») stay put between runs.
    await page.clock.setFixedTime(NOW);
    await page.goto(`/login?next=${encodeURIComponent(path)}`);
    await login(page, email);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`${name}.png`, {
      animations: 'disabled',
      caret: 'hide',
      // A few pixels of anti-aliasing noise pass; a shifted block of the page does not.
      maxDiffPixelRatio: 0.002,
      mask: [page.locator('[data-sonner-toaster]')],
    });
  });
}
