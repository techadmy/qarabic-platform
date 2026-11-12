import { expect, test, type APIResponse, type Page } from '@playwright/test';
import {
  announcementListResponseSchema,
  announcementSchema,
  dashboardSummarySchema,
  journalEntrySchema,
  journalListResponseSchema,
  ledgerAccountSchema,
  meSchema,
  notificationPreferencesResponseSchema,
  outboxRunResultSchema,
  outboxStatusSchema,
  taskAssigneeSchema,
  taskDetailSchema,
  taskListResponseSchema,
  trialBalanceSchema,
} from '@qarabic/shared';
import { z } from 'zod';
import { REAL_API, runTag, signInReal } from './real-api-helpers';

/**
 * M7 accounting and M8 operations against the real API and its seeded dev database (opt-in:
 * `pnpm test:e2e:real`). Their screens are not on `main` yet, so these steps call the API with the
 * signed-in admin's session (cookie + CSRF header, like the web client) and parse every answer
 * with the shared schemas the screens will use: contract drift fails here first. The screen steps
 * join when the M7/M8 screens merge. Runs after real-api-flows.spec.ts (its N6 payment feeds the
 * accounting outbox).
 */
test.skip(!REAL_API, 'set E2E_REAL_API=1 (needs the API and Postgres)');
test.describe.configure({ mode: 'serial' });

const API = `http://localhost:${Number(process.env.E2E_API_PORT) || 3001}/api/v1`;
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

/** The API as the signed-in browser: same cookies, the XSRF cookie echoed in the header. */
async function apiAs(page: Page) {
  await signInReal(page, '/');
  const request = page.context().request;
  await request.get(`${API}/auth/csrf`);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN')?.value ?? '';
  const ok = async <T extends z.ZodType>(res: APIResponse, schema: T): Promise<z.infer<T>> => {
    expect(res.status(), `${res.url()} → ${await res.text()}`).toBeLessThan(300);
    return schema.parse(await res.json());
  };
  return {
    get: async <T extends z.ZodType>(path: string, schema: T) =>
      ok(await request.get(`${API}${path}`), schema),
    send: async <T extends z.ZodType>(
      method: 'POST' | 'PATCH' | 'PUT',
      path: string,
      body: unknown,
      schema: T,
    ) =>
      ok(
        await request.fetch(`${API}${path}`, {
          method,
          data: body as Record<string, unknown>,
          headers: { 'X-XSRF-TOKEN': csrf },
        }),
        schema,
      ),
  };
}

const cairoToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());

test('real API (M8): tasks — own task completes on submit; a given task is closed; dashboard', async ({
  page,
}) => {
  const api = await apiAs(page);
  const { data: people } = await api.get(
    '/tasks/assignees',
    z.object({ data: z.array(taskAssigneeSchema) }),
  );
  expect(people.length).toBeGreaterThan(0);
  const me = await api.get('/auth/me', meSchema);

  const title = `E2E task ${runTag()}`;
  const { data: created } = await api.send(
    'POST',
    '/tasks',
    { title, assigneeId: me.id, priority: 'high' },
    one(taskDetailSchema),
  );
  expect(created).toMatchObject({ title, status: 'pending', assignee: { id: me.id } });

  await api.send('POST', `/tasks/${created.id}/comments`, { body: 'E2E comment' }, z.unknown());
  // A task given to oneself completes on submit (no «awaiting» step).
  const { data: completed } = await api.send(
    'POST',
    `/tasks/${created.id}/submit`,
    { note: 'Done from e2e' },
    one(taskDetailSchema),
  );
  expect(completed.status).toBe('completed');
  expect(completed.events.map((e) => e.kind)).toEqual(
    expect.arrayContaining(['created', 'comment', 'status']),
  );

  // A task given to someone else: the issuer closes it with a reason.
  const someone = people.find((p) => p.id !== me.id)!;
  const { data: given } = await api.send(
    'POST',
    '/tasks',
    { title: `${title} (given)`, assigneeId: someone.id },
    one(taskDetailSchema),
  );
  expect(given).toMatchObject({ status: 'pending', assignee: { id: someone.id } });
  const { data: closed } = await api.send(
    'POST',
    `/tasks/${given.id}/close`,
    { reason: 'E2E: no longer needed' },
    one(taskDetailSchema),
  );
  expect(closed).toMatchObject({ status: 'closed', closeReason: 'E2E: no longer needed' });

  const list = await api.get(
    `/tasks?box=issued&q=${encodeURIComponent(title)}`,
    taskListResponseSchema,
  );
  expect(list.data.map((t) => t.id)).toContain(created.id);
  const { data: summary } = await api.get('/dashboard/summary', one(dashboardSummarySchema));
  expect(summary.queues.myTasks).not.toBeNull();
});

test('real API (M8): an announcement — draft → publish → read; preferences round-trip', async ({
  page,
}) => {
  const api = await apiAs(page);
  const title = `E2E announcement ${runTag()}`;
  const { data: draft } = await api.send(
    'POST',
    '/announcements',
    { title, body: 'Made by the real-API e2e (fake data).' },
    one(announcementSchema),
  );
  expect(draft.status).toBe('draft');
  const { data: published } = await api.send(
    'POST',
    `/announcements/${draft.id}/publish`,
    {},
    one(announcementSchema),
  );
  expect(published.status).toBe('published');
  await api.send('POST', `/announcements/${draft.id}/read`, {}, z.unknown());
  const current = await api.get(
    `/announcements?q=${encodeURIComponent(title)}`,
    announcementListResponseSchema,
  );
  expect(current.data.find((a) => a.id === draft.id)?.read).toBe(true);

  const prefs = await api.get(
    '/me/notification-preferences',
    notificationPreferencesResponseSchema,
  );
  const saved = await api.send(
    'PUT',
    '/me/notification-preferences',
    { preferences: prefs.data },
    notificationPreferencesResponseSchema,
  );
  expect(saved.data).toEqual(prefs.data);
});

test('real API (M7): a balanced journal entry → reversed; the outbox posts; trial balance balances', async ({
  page,
}) => {
  const api = await apiAs(page);
  const { data: accounts } = await api.get(
    '/accounting/accounts?only=postable',
    z.object({ data: z.array(ledgerAccountSchema) }),
  );
  const any = accounts.filter((a) => a.currency === null || a.currency === 'EGP');
  const cash = any.find((a) => a.isCash) ?? any[0]!;
  const other = any.find((a) => a.id !== cash.id && a.type === 'expense') ?? any[1]!;
  expect(cash && other).toBeTruthy();

  const date = cairoToday();
  const memo = `E2E manual entry ${runTag()}`;
  const { data: entry } = await api.send(
    'POST',
    '/accounting/journal',
    {
      date,
      currency: 'EGP',
      memo,
      lines: [
        { accountId: other.id, debit: '125.50' },
        { accountId: cash.id, credit: '125.50' },
      ],
    },
    one(journalEntrySchema),
  );
  expect(entry).toMatchObject({ source: 'manual', total: '125.50', currency: 'EGP' });

  // An unbalanced entry is refused (422), nothing is stored.
  const bad = await page.context().request.post(`${API}/accounting/journal`, {
    data: {
      date,
      currency: 'EGP',
      memo: `${memo} unbalanced`,
      lines: [
        { accountId: other.id, debit: '10.00' },
        { accountId: cash.id, credit: '9.00' },
      ],
    },
    headers: {
      'X-XSRF-TOKEN':
        (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN')?.value ?? '',
    },
  });
  expect(bad.status()).toBe(422);

  const { data: reversal } = await api.send(
    'POST',
    `/accounting/journal/${entry.id}/reverse`,
    { reason: 'E2E: reverse the test entry' },
    one(journalEntrySchema),
  );
  expect(reversal).toMatchObject({ source: 'reversal', reversesId: entry.id });

  // Billing and payroll events (the N6 payment and N7 payslip of real-api-flows) post here.
  await api.get('/accounting/outbox', one(outboxStatusSchema));
  const { data: run } = await api.send(
    'POST',
    '/accounting/outbox/process',
    {},
    one(outboxRunResultSchema),
  );
  expect(run.failed).toBe(0);
  const billing = await api.get('/accounting/journal?source=billing', journalListResponseSchema);
  expect(billing.data.length, 'the N6 payment posted to the ledger').toBeGreaterThan(0);

  const { data: tb } = await api.get(
    `/accounting/reports/trial-balance?currency=EGP&from=${date.slice(0, 8)}01&to=${date}`,
    one(trialBalanceSchema),
  );
  expect(tb.balanced).toBe(true);
  expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
});
