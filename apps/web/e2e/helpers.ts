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

/** axe: no serious or critical WCAG 2.2 AA violations on the current page. */
export async function expectNoSeriousA11yViolations(page: Page) {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}
