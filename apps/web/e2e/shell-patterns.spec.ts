import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * D141 shell patterns: the top-bar search (scoped, `/`, section picker), the sidebar «+», and the
 * family profile's tabs + collapsible sections. Keyboard, Arabic RTL + English LTR, 375/768/1440,
 * axe.
 */
async function signIn(page: Page, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page);
  await expect(page.locator('#main h1').first()).toBeVisible();
}

async function english(page: Page) {
  await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}

const L = {
  ar: {
    search: 'بحث في «العائلات»',
    dialog: 'البحث',
    input: 'ابحث في «العائلات»…',
    section: 'قسم البحث',
    leads: 'العملاء المحتملون',
    leadsInput: 'ابحث في «العملاء المحتملون»…',
    plus: 'إضافة في «العائلات»',
    addSheet: 'عائلة جديدة',
    overview: 'نظرة عامة',
    history: 'السجل',
    contact: 'التواصل',
  },
  en: {
    search: 'Search “Families”',
    dialog: 'Search',
    input: 'Search “Families”…',
    section: 'Search section',
    leads: 'Leads',
    leadsInput: 'Search “Leads”…',
    plus: 'Add to “Families”',
    addSheet: 'New family',
    overview: 'Overview',
    history: 'History',
    contact: 'Contact',
  },
} as const;

for (const lang of ['ar', 'en'] as const) {
  const l = L[lang];
  test(`${lang} 1440: '/' search scoped to the section, switch section, open a result`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, '/families');
    if (lang === 'en') await english(page);
    await expect(page.getByRole('button', { name: l.search })).toBeVisible();
    await page.locator('#main h1').first().click();
    await page.keyboard.press('/');
    const dialog = page.getByRole('dialog', { name: l.dialog });
    await expect(dialog.getByRole('combobox', { name: l.input })).toBeFocused();
    await expectNoSeriousA11yViolations(page);
    // Section picker → leads; a result opens beside the list (split view).
    await dialog.getByRole('combobox', { name: l.section }).click();
    await page.getByRole('option', { name: l.leads }).click();
    const leadsInput = dialog.getByRole('combobox', { name: l.leadsInput });
    await leadsInput.fill('Amina');
    await expect(dialog.getByRole('option', { name: /Amina Rahman/ })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/leads\?.*id=\d+/);
    await expect(page.getByRole('heading', { level: 2, name: 'Amina Rahman' })).toBeVisible();
  });

  test(`${lang} 1440: sidebar «+» by keyboard opens the add sheet; family tabs + sections`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, '/today');
    if (lang === 'en') await english(page);
    const plus = page.getByRole('link', { name: l.plus });
    await plus.focus();
    await expect(plus).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/families$/);
    await expect(page.getByRole('dialog').getByRole('heading', { name: l.addSheet })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.goto('/families/1');
    const tabs = page.getByRole('tablist');
    await expect(tabs.getByRole('tab', { name: l.overview })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const contact = page.getByRole('button', { name: l.contact, exact: true });
    await contact.click();
    await expect(contact).toHaveAttribute('aria-expanded', 'false');
    await contact.press('Enter');
    await expect(contact).toHaveAttribute('aria-expanded', 'true');
    await tabs.getByRole('tab', { name: l.overview }).focus();
    await page.keyboard.press(lang === 'ar' ? 'ArrowLeft' : 'ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/tab=/);
    await tabs.getByRole('tab', { name: l.history }).click();
    await expect(page).toHaveURL(/tab=history/);
    await page.reload();
    await expect(page.getByRole('tab', { name: l.history })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectNoSeriousA11yViolations(page);
  });
}

for (const width of [375, 768]) {
  test(`${width} px: search button, family tabs fit; axe`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, '/families/1');
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'بحث في «العائلات»' }).click();
    await expect(page.getByRole('dialog', { name: 'البحث' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tablist')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });
}
