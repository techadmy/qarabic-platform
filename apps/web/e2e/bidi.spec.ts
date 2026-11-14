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

test('Arabic: «Admin (2)» stays whole in its delete label, dialog title and toast', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login?next=%2Froles%2Fnew');
  await login(page);
  await page.waitForURL((u) => u.pathname === '/roles/new');
  // A Latin name with punctuation inside an Arabic sentence (docs/39 §5 acceptance).
  await page.getByLabel('اسم الدور بالعربية').fill('Admin (2)');
  await page.getByLabel('اسم الدور بالإنجليزية').fill('Admin (2)');
  await page.getByRole('button', { name: 'أنشئ الدور' }).click();
  await expect(page.getByText(sentence('Admin (2)', { exact: false })).first()).toBeVisible();
  await page.getByRole('link', { name: 'الأدوار' }).first().click();
  await page.waitForURL((u) => u.pathname === '/roles');
  const del = page.getByRole('button', { name: sentence('حذف الدور «Admin (2)»') });
  await expect(del).toHaveAttribute('aria-label', `حذف الدور «${FSI}Admin (2)${PDI}»`);
  await del.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading')).toHaveText(`حذف الدور «${FSI}Admin (2)${PDI}»؟`);
  // Reads in the right order: «Admin (2)» is one left-to-right run inside the Arabic title.
  const order = await dialog.getByRole('heading').evaluate((el) => {
    const text = el.textContent ?? '';
    const node =
      [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent!.includes('Admin')) ??
      el.firstChild!;
    const at = (word: string) => {
      const start = (node.textContent ?? text).indexOf(word);
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, start + word.length);
      return r.getBoundingClientRect().left;
    };
    return { admin: at('Admin'), two: at('(2)'), title: at('حذف') };
  });
  expect(order.admin).toBeLessThan(order.two);
  expect(order.two).toBeLessThan(order.title);
  if (shots) await page.screenshot({ path: `${shots}/bidi-ar-delete-role.png` });
  await dialog.getByRole('button', { name: 'احذف الدور' }).click();
  await expect(page.locator('[data-sonner-toast]').first()).toHaveText(
    `حُذف الدور «${FSI}Admin (2)${PDI}»`,
  );
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
