import { expect, test } from '@playwright/test';
import { login, sentence } from './helpers';

/**
 * docs/39 P1-10: a value inside a sentence is wrapped in bidi isolates (FSI … PDI), so a Latin
 * name keeps its place in an Arabic sentence and an Arabic name in an English one; the isolates
 * reach visible text, aria-labels and toasts. With BIDI_SHOTS_DIR set, saves the screenshots.
 */
const FSI = '\u2068';
const PDI = '\u2069';
const shots = process.env.BIDI_SHOTS_DIR;

test('Arabic: a role name is isolated in the button label, the dialog title and the toast', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login?next=%2Froles');
  await login(page);
  await page.waitForURL((u) => u.pathname === '/roles');
  const del = page.getByRole('button', { name: /^حذف الدور/ }).first();
  const label = (await del.getAttribute('aria-label')) ?? '';
  expect(label).toMatch(new RegExp(`^حذف الدور «${FSI}.+${PDI}»$`));
  await del.click();
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
  await expect(dialog).toBeVisible();
  const title = (await dialog.getByRole('heading').first().textContent()) ?? '';
  expect(title).toContain(FSI);
  expect(title).toContain(PDI);
  if (shots) await page.screenshot({ path: `${shots}/bidi-ar-delete-role.png` });
});

test('English: an Arabic name keeps its place in an English sentence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await login(page);
  await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
  const heading = page.getByRole('heading', { level: 1, name: sentence('Welcome, مدير النظام') });
  await expect(heading).toBeVisible();
  expect(await heading.textContent()).toBe(`Welcome, ${FSI}مدير النظام${PDI}`);
  // The isolated name renders after the comma, not before "Welcome".
  const box = await heading.boundingBox();
  const welcome = await heading.evaluate((el) => {
    const r = document.createRange();
    const text = el.firstChild!;
    r.setStart(text, 0);
    r.setEnd(text, 'Welcome'.length);
    return r.getBoundingClientRect().left;
  });
  expect(welcome).toBeLessThan((box?.x ?? 0) + 40);
  if (shots) await page.screenshot({ path: `${shots}/bidi-en-welcome.png` });
});
