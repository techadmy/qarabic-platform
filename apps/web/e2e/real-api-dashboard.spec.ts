import { expect, test } from '@playwright/test';
import { dashboardMetricsSchema } from '@qarabic/shared';
import { z } from 'zod';
import { REAL_API, signInReal } from './real-api-helpers';

/**
 * D2 on the real API (docs/40, D144): the staff home asks `GET /dashboard/metrics` for the URL's
 * range, the answer parses with the shared schema, and the cards show the API's own numbers (no
 * second sum in the browser). Opt-in: `pnpm test:e2e:real`.
 */
test.skip(!REAL_API, 'set E2E_REAL_API=1 (needs the API and Postgres)');

const answer = z.object({ data: dashboardMetricsSchema });

test('real API (D2): the dashboard shows the API’s KPIs for the range, with compare', async ({
  page,
}) => {
  const metrics = page.waitForResponse(
    (r) => r.url().includes('/dashboard/metrics') && r.request().method() === 'GET',
  );
  await signInReal(page, '/?range=last_12_months&compare=1');
  const res = await metrics;
  expect(res.status()).toBe(200);
  const url = new URL(res.url());
  expect(url.searchParams.get('compare')).toBe('prev');
  expect(url.searchParams.get('bucket')).toBe('month');
  const d = answer.parse(await res.json()).data;
  expect(d.currency).toBe('USD');
  expect(d.range.previous).not.toBeNull();

  const dash = page.getByRole('region', { name: 'لوحة المؤشرات' });
  await expect(dash.getByRole('region', { name: 'الفترة الزمنية' })).toBeVisible();
  if (d.kpis.active_students) {
    await expect(dash.getByRole('link', { name: /^الطلاب النشطون/ })).toContainText(
      String(d.kpis.active_students.value),
    );
  }
  // No widget says it failed.
  await expect(dash.getByText('تعذّر التحميل')).toHaveCount(0);
  await expect(dash.getByText('تعذّر تحميل الرسم.')).toHaveCount(0);
  // A missing rate is said, never a USD total of 0; otherwise the card shows the API's total.
  const collected = d.kpis.collected?.value;
  if (collected?.missingRate) {
    await expect(dash.getByText('أسعار صرف ناقصة')).toBeVisible();
  } else if (collected?.usd) {
    const shown = Math.round(Number(collected.usd)).toLocaleString('en');
    await expect(dash.getByRole('link', { name: /^المُحصّل/ })).toContainText(`$${shown}`);
  }

  // Switching the period asks again for that range.
  const next = page.waitForResponse((r) => r.url().includes('/dashboard/metrics?from='));
  await dash.getByRole('combobox', { name: 'الفترة' }).click();
  await page.getByRole('option', { name: 'الشهر الماضي' }).click();
  await expect(page).toHaveURL(/range=last_month/);
  expect((await next).status()).toBe(200);
});
