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
