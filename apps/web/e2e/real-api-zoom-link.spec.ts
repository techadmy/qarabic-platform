import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations } from './helpers';
import { demoAccount, REAL_API, runTag, signInReal } from './real-api-helpers';

/**
 * D151 against the real API and the seeded dev database: staff set teacher 1's personal Zoom link
 * on the profile (it shows with copy and open), the same link on another teacher is refused on the
 * field (409 `zoom_link_taken`), and teacher 1 reads it, read-only, on their home page. The old
 * link is put back at the end.
 */
test.skip(!REAL_API, 'set E2E_REAL_API=1 (needs the API and Postgres)');
test.skip(!demoAccount('teacher1'), 'set SEED_DEMO_PASSWORD (db:seed) / E2E_DEMO_PASSWORD');
test.describe.configure({ mode: 'serial' });

const API = `http://localhost:${Number(process.env.E2E_API_PORT) || 3001}/api/v1`;
const teacherAccount = demoAccount('teacher1')!;

type TeacherRow = { id: number; email: string; zoomJoinUrl?: string | null };

async function teachers(page: Page): Promise<TeacherRow[]> {
  const res = await page.context().request.get(`${API}/teachers?perPage=100`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: TeacherRow[] }).data;
}

/** The profile's «رابط Zoom» section → its edit sheet → the field. */
async function editLink(page: Page, teacherId: number, url: string) {
  await page.goto(`/teachers/${teacherId}`);
  await page.getByRole('button', { name: /^تعديل.*رابط Zoom/ }).click();
  const sheet = page.getByRole('dialog').first();
  const field = sheet.getByLabel('رابط Zoom', { exact: true });
  await field.fill(url);
  await sheet.getByRole('button', { name: 'حفظ' }).click();
  return { sheet, field };
}

let original: string | null = null;
let ownId = 0;

test('staff set a teacher’s Zoom link; another teacher cannot take the same one', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signInReal(page, '/');
  const all = await teachers(page);
  const own = all.find((t) => t.email === teacherAccount.email);
  const other = all.find((t) => t.email !== teacherAccount.email);
  expect(own, 'the seeded teacher 1').toBeTruthy();
  expect(other, 'a second teacher').toBeTruthy();
  ownId = own!.id;
  original = own!.zoomJoinUrl ?? null;

  // 10 digits, unique per run.
  const link = `https://us02web.zoom.us/j/9${runTag().padStart(9, '0')}?pwd=e2e`;
  const saved = await editLink(page, own!.id, link);
  await expect(saved.sheet).toBeHidden();
  await expect(page.getByText(link)).toBeVisible();
  await expect(page.getByRole('link', { name: /^فتح/ })).toHaveAttribute('href', link);
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);

  const taken = await editLink(page, other!.id, link);
  await expect(
    taken.sheet.getByText('هذا الرابط مسجّل لمعلم آخر. لكل معلم رابط Zoom خاص به.'),
  ).toBeVisible();
  await expect(taken.field).toBeFocused();
});

test('the teacher reads their own link on the home page, read-only', async ({ page }) => {
  await signInReal(page, '/', teacherAccount);
  const card = page.getByText('رابط Zoom الخاص بك').locator('xpath=ancestor::*[@data-slot="card"]');
  await expect(card.getByText(/^https:\/\/us02web\.zoom\.us\/j\/9\d{9}\?pwd=e2e$/)).toBeVisible();
  await expect(card.getByRole('textbox')).toHaveCount(0);
  // The portal endpoint returns the same link and its meeting id.
  const res = await page.context().request.get(`${API}/teacher-portal/zoom-link`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: { url: string | null; meetingId: string | null } };
  expect(body.data.meetingId).toMatch(/^9\d{9}$/);
});

test.afterAll(async ({ browser }) => {
  if (!ownId) return;
  // Put teacher 1's link back (blank clears it).
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInReal(page, '/');
  const request = page.context().request;
  await request.get(`${API}/auth/csrf`);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN')?.value ?? '';
  await request.fetch(`${API}/teachers/${ownId}`, {
    method: 'PATCH',
    data: { zoomJoinUrl: original ?? '' },
    headers: { 'X-XSRF-TOKEN': csrf },
  });
  await context.close();
});
