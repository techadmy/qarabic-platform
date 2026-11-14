import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

/** Demo password of the mock users (see mocks/data.ts). */
export const PASSWORD = 'Qarabic-demo-123';

export async function login(page: Page, email = 'admin@qarabic.test') {
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * axe: no serious or critical WCAG 2.2 AA violations on the current page, and no moderate one that
 * is not in the baseline.
 */
export async function expectNoSeriousA11yViolations(page: Page) {
  // Next streams <title> with the page metadata; under load axe could run before it arrives.
  await expect(page).toHaveTitle(/\S/);
  // Jump running transitions and animations to their end (a dialog fading in, a button turning
  // from disabled to enabled): axe measured colours mid-fade and reported contrast that the
  // settled screen does not have (support.spec «teacher change», 2026-11-14). finish() fires the
  // usual end events; infinite ones (spinners) throw and are left alone.
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) {
      try {
        animation.finish();
      } catch {
        // infinite
      }
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);

  // Moderate (docs/39 E2E-4): the known ones are in e2e/axe-moderate-baseline.json (page + rule);
  // a new one fails. `AXE_BASELINE_UPDATE=1` records instead (then `node e2e/axe-baseline.mjs`).
  const moderate = results.violations.filter((v) => v.impact === 'moderate');
  const page_ = pageKey(page.url());
  const keys = moderate.map((v) => `${page_} ${v.id}`);
  if (process.env.AXE_BASELINE_UPDATE === '1') {
    if (keys.length) appendFileSync(BASELINE_LOG, keys.map((k) => `${k}\n`).join(''));
    return;
  }
  const fresh = moderate.filter((v) => !moderateBaseline().has(`${page_} ${v.id}`));
  expect(
    fresh,
    `New moderate axe violations on ${page_} (fix them, or add to e2e/axe-moderate-baseline.json with a reason): ${JSON.stringify(fresh, null, 2)}`,
  ).toEqual([]);
}

const BASELINE_FILE = fileURLToPath(new URL('./axe-moderate-baseline.json', import.meta.url));
const BASELINE_LOG = fileURLToPath(new URL('./.axe-moderate.log', import.meta.url));
let baseline: Set<string> | null = null;
function moderateBaseline(): Set<string> {
  baseline ??= new Set(
    existsSync(BASELINE_FILE)
      ? (JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as { known: string[] }).known
      : [],
  );
  return baseline;
}

/** `/invoices/:id/receipts/:id`: the path with ids folded, without the base path or query. */
export function pageKey(url: string): string {
  const base = process.env.E2E_BASE_PATH ?? '';
  const path = new URL(url).pathname.replace(new RegExp(`^${base}(?=/|$)`), '') || '/';
  return path.replace(/\/\d+(?=\/|$)/g, '/:id');
}
