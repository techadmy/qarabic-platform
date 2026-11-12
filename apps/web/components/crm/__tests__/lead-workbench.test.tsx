import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { primaryAction } from '@/components/crm/crm-bits';
import { LeadWorkbench } from '@/components/crm/lead-workbench';
import { crmdb } from '@/mocks/crm-db';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';

/** Seeded leads (mocks/crm-db.ts), one per stage. */
const NEW = 1; // Amina Rahman, assigned to the admin
const CONTACTED = 4; // Bilal Ahmed, no family yet
const TRIAL_SCHEDULED = 6; // Khadija Noor
const TRIAL_DONE = 7; // Yasmin Farouk

function open(id: number, as = 'admin@qarabic.test') {
  return renderPage(<LeadWorkbench id={id} />, { as, path: `/leads/${id}` });
}

async function heading(name: string) {
  return screen.findByRole('heading', { level: 1, name });
}

describe('primaryAction (stage → the one contained button)', () => {
  const all = [
    'add_activity',
    'create_account',
    'book_trial',
    'record_outcome',
    'convert',
  ] as const;
  it('follows the pipeline when every action is allowed', () => {
    expect(primaryAction({ status: 'new', allowedActions: [...all] })).toBe('contact');
    expect(primaryAction({ status: 'contacted', allowedActions: [...all] })).toBe('book_trial');
    expect(primaryAction({ status: 'trial_scheduled', allowedActions: [...all] })).toBe(
      'record_outcome',
    );
    expect(primaryAction({ status: 'trial_done', allowedActions: [...all] })).toBe('convert');
    for (const s of ['converted', 'lost', 'spam', 'job_applicant'] as const) {
      expect(primaryAction({ status: s, allowedActions: [...all] })).toBeNull();
    }
  });

  it('falls back or hides when the action is not allowed', () => {
    expect(primaryAction({ status: 'new', allowedActions: [] })).toBeNull();
    expect(primaryAction({ status: 'contacted', allowedActions: ['create_account'] })).toBe(
      'book_trial',
    );
    expect(primaryAction({ status: 'contacted', allowedActions: ['convert'] })).toBe('convert');
    expect(primaryAction({ status: 'contacted', allowedActions: ['add_activity'] })).toBeNull();
    expect(primaryAction({ status: 'trial_scheduled', allowedActions: ['convert'] })).toBeNull();
    expect(primaryAction({ status: 'trial_done', allowedActions: ['book_trial'] })).toBeNull();
  });
});

describe('Lead workbench', () => {
  it('new → «سجّل تواصلًا» as the primary action', async () => {
    open(NEW);
    expect(await heading('Amina Rahman')).toBeVisible();
    expect(screen.getByRole('button', { name: 'سجّل تواصلًا' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'احجز حصة تجريبية' })).not.toBeInTheDocument();
  });

  it('contacted → «احجز حصة تجريبية», which opens the booking dialog', async () => {
    const user = userEvent.setup();
    open(CONTACTED);
    expect(await heading('Bilal Ahmed')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'سجّل تواصلًا' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'احجز حصة تجريبية' }));
    expect(await screen.findByRole('dialog', { name: 'حجز حصة تجريبية' })).toBeInTheDocument();
  });

  it('trial booked → «سجّل نتيجة التجريبية» (and «أعد حجز التجريبية» beside it)', async () => {
    const user = userEvent.setup();
    open(TRIAL_SCHEDULED);
    expect(await heading('Khadija Noor')).toBeVisible();
    expect(screen.getByRole('button', { name: 'أعد حجز التجريبية' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'سجّل نتيجة التجريبية' }));
    expect(
      await screen.findByRole('dialog', { name: 'نتيجة الحصة التجريبية' }),
    ).toBeInTheDocument();
  });

  it('trial done → «حوّل إلى منتظم», which opens the conversion dialog', async () => {
    const user = userEvent.setup();
    open(TRIAL_DONE);
    expect(await heading('Yasmin Farouk')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'سجّل نتيجة التجريبية' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'حوّل إلى منتظم' }));
    expect(await screen.findByRole('dialog', { name: 'التحويل إلى منتظم' })).toBeInTheDocument();
  });

  it('a converted lead has no primary action and says who converted it', async () => {
    open(8);
    expect(await heading('Nadia Karim')).toBeVisible();
    for (const name of ['سجّل تواصلًا', 'احجز حصة تجريبية', 'سجّل نتيجة التجريبية', 'حوّل إلى منتظم']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/تحوّل إلى منتظم في .* بواسطة خالد منصور\./)).toBeInTheDocument();
  });

  it('the composer needs a call result, then logs the call and moves the lead to «تم التواصل»', async () => {
    const user = userEvent.setup();
    open(NEW);
    await heading('Amina Rahman');
    const form = screen.getByRole('form', { name: 'سجّل تواصلًا' });
    await user.click(within(form).getByRole('button', { name: 'سجّل' }));
    expect(await within(form).findByText('اختر نتيجة المكالمة.')).toBeInTheDocument();
    expect(within(form).getByRole('combobox', { name: /نتيجة المكالمة/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(crmdb.leads.find((l) => l.id === NEW)!.contactAttempts).toBe(0);

    await user.click(within(form).getByRole('combobox', { name: /نتيجة المكالمة/ }));
    await user.click(await screen.findByRole('option', { name: 'تم الرد' }));
    await user.type(within(form).getByLabelText(/التفاصيل/), 'Asked about evening classes.');
    await user.click(within(form).getByRole('button', { name: 'سجّل' }));
    expect((await screen.findAllByText('سُجّل التواصل.'))[0]).toBeInTheDocument();
    expect(crmdb.leads.find((l) => l.id === NEW)).toMatchObject({
      status: 'contacted',
      contactAttempts: 1,
    });
    // The stage moved on, so does the primary action; the call is on the timeline.
    expect(await screen.findByRole('button', { name: 'احجز حصة تجريبية' })).toBeInTheDocument();
    const timeline = screen.getByRole('list', { name: 'سجل النشاط' });
    expect(within(timeline).getByText('مكالمة: تم الرد')).toBeInTheDocument();
  });

  it('a note needs its text', async () => {
    const user = userEvent.setup();
    open(NEW);
    await heading('Amina Rahman');
    const form = screen.getByRole('form', { name: 'سجّل تواصلًا' });
    await user.click(within(form).getByRole('radio', { name: 'ملاحظة' }));
    expect(within(form).queryByRole('combobox', { name: /نتيجة المكالمة/ })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'سجّل' }));
    expect(await within(form).findByText('اكتب الملاحظة.')).toBeInTheDocument();
  });

  it('shows the forbidden state on a 403', async () => {
    server.use(
      http.get('*/api/v1/leads/:id', () =>
        HttpResponse.json({ message: 'Forbidden.', code: 'forbidden' }, { status: 403 }),
      ),
    );
    open(NEW);
    expect((await screen.findAllByText('ليست لديك صلاحية'))[0]).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'سجّل تواصلًا' })).not.toBeInTheDocument();
  });

  it('shows the forbidden state without leads.view, without asking the API', async () => {
    open(NEW, 'teacher@qarabic.test');
    expect((await screen.findAllByText('ليست لديك صلاحية'))[0]).toBeInTheDocument();
  });

  it('shows the error state with a retry on a server error', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/v1/leads/:id', () => {
        calls++;
        return HttpResponse.json({ message: 'Boom', code: 'server_error' }, { status: 500 });
      }),
    );
    const user = userEvent.setup();
    open(NEW);
    expect((await screen.findAllByText('تعذّر تحميل البيانات'))[0]).toBeInTheDocument();
    const before = calls;
    await user.click(screen.getByRole('button', { name: 'حاول مرة أخرى' }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  it('says the lead is not found on a 404', async () => {
    open(9999);
    expect((await screen.findAllByText('الطلب غير موجود'))[0]).toBeInTheDocument();
  });
});
