import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { InvoiceDetailView } from '@/components/billing/invoice-detail-view';
import { InvoicesView } from '@/components/billing/invoices-view';
import { PackagesView } from '@/components/billing/packages-view';
import { BillingSettingsView } from '@/components/billing/billing-settings-view';
import { FamilyBillingSection } from '@/components/billing/family-billing';
import { bdb } from '@/mocks/billing-db';
import { server } from '@/mocks/node';
import { lastReplacedUrl, renderPage } from '@/test/people';

async function table(name = 'الفواتير') {
  const t = await screen.findByRole('table', { name });
  await waitFor(() => expect(t).not.toHaveAttribute('aria-busy'));
  return t;
}

describe('Invoices list (staff)', () => {
  it('shows the amounts per currency, the status tabs with counts and the rows', async () => {
    renderPage(<InvoicesView />, { path: '/invoices' });
    const t = await table();
    // 12 invoices in the mock + the header row.
    expect(within(t).getAllByRole('row')).toHaveLength(13);
    const tabs = screen.getByRole('radiogroup', { name: 'حالة الفاتورة' });
    expect(within(tabs).getByRole('radio', { name: /^الكل\s*\(12\)$/ })).toBeChecked();
    expect(within(tabs).getByRole('radio', { name: /^متأخرة\s*\(2\)$/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('radio', { name: /^غير مسددة\s*\(7\)$/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('radio', { name: /^مسودة\s*\(1\)$/ })).toBeInTheDocument();
    const kpi = await screen.findByRole('region', { name: 'ملخص المبالغ حسب العملة' });
    expect(within(kpi).getByRole('heading', { name: 'USD' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إصدار فواتير الشهر' })).toBeInTheDocument();
    // The draft has no number yet; the overdue one says so (icon + text).
    expect(within(t).getByRole('link', { name: 'فاتورة مسودة' })).toHaveAttribute(
      'href',
      '/invoices/5',
    );
    expect(within(t).getAllByText('متأخرة')).toHaveLength(2);
  });

  it('puts the tab and the month in the URL', async () => {
    const user = userEvent.setup();
    renderPage(<InvoicesView />, { path: '/invoices' });
    await table();
    await user.click(screen.getByRole('radio', { name: /^متأخرة/ }));
    expect(lastReplacedUrl().searchParams.get('status')).toBe('overdue');
  });

  it('a search with no match offers to clear the filters', async () => {
    renderPage(<InvoicesView />, { path: '/invoices?q=nobody-here' });
    expect(await screen.findByText('لا فواتير مطابقة')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'مسح عوامل التصفية' })).toBeInTheDocument();
  });

  it('shows the error state with a retry', async () => {
    server.use(http.get('*/api/v1/invoices', () => HttpResponse.json({}, { status: 500 })));
    renderPage(<InvoicesView />, { path: '/invoices' });
    expect(await screen.findByRole('button', { name: 'حاول مرة أخرى' })).toBeInTheDocument();
  });

  it('a teacher has no access', async () => {
    renderPage(<InvoicesView />, { as: 'teacher@qarabic.test', path: '/invoices' });
    expect((await screen.findAllByText(/ليست لديك صلاحية/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('the monthly run previews, then issues once per family', async () => {
    const user = userEvent.setup();
    const before = bdb.invoices.length;
    renderPage(<InvoicesView />, { path: '/invoices' });
    await table();
    await user.click(screen.getByRole('button', { name: 'إصدار فواتير الشهر' }));
    const dialog = await screen.findByRole('dialog', { name: 'إصدار الفواتير الشهرية' });
    await user.click(within(dialog).getByRole('button', { name: 'معاينة' }));
    const preview = await within(dialog).findByRole('table', { name: 'معاينة الفواتير' });
    expect(within(preview).getByText('لم تُحدَّد عملة الفوترة')).toBeInTheDocument();
    const issue = within(dialog).getByRole('button', { name: /^أصدر/ });
    const willIssue = within(preview).getAllByText('ستُصدر').length;
    await user.click(issue);
    await waitFor(() => expect(bdb.invoices.length).toBe(before + willIssue));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
});

describe('Invoice workbench (staff)', () => {
  it('an open invoice: record payment, reminder, print and the ⋯ actions', async () => {
    const user = userEvent.setup();
    renderPage(<InvoiceDetailView id={1} />, { path: '/invoices/1' });
    expect(
      await screen.findByRole('heading', { level: 1, name: /INV-\d{4}-000001/ }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'تسجيل دفعة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'أرسل تذكيرًا' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /طباعة/ })).toHaveAttribute(
      'href',
      'http://api.test/api/v1/invoices/1/print',
    );
    expect(screen.queryByRole('button', { name: 'إصدار الفاتورة' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'إجراءات أخرى' }));
    for (const name of ['إضافة تسوية', 'إضافة خصم', 'تقسيم الفاتورة', 'إلغاء الفاتورة']) {
      expect(await screen.findByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('a draft can be issued (with a confirm), not paid', async () => {
    const user = userEvent.setup();
    renderPage(<InvoiceDetailView id={5} />, { path: '/invoices/5' });
    expect(await screen.findByRole('heading', { level: 1, name: /فاتورة مسودة/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'تسجيل دفعة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /طباعة/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'إصدار الفاتورة' }));
    const dialog = await screen.findByRole('dialog', { name: 'إصدار الفاتورة؟' });
    await user.click(within(dialog).getByRole('button', { name: 'إصدار الفاتورة' }));
    expect(await screen.findByText('أُصدرت الفاتورة.')).toBeInTheDocument();
    expect(bdb.invoices.find((i) => i.id === 5)?.status).toBe('issued');
  });

  it('a paid or void invoice has no money actions; void shows its reason', async () => {
    renderPage(<InvoiceDetailView id={6} />, { path: '/invoices/6' });
    expect(await screen.findByText('أُلغيت هذه الفاتورة')).toBeInTheDocument();
    expect(screen.getByText(/السبب: أُصدرت بالخطأ/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تسجيل دفعة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إجراءات أخرى' })).not.toBeInTheDocument();
  });

  it('a split invoice links its instalments', async () => {
    renderPage(<InvoiceDetailView id={7} />, { path: '/invoices/7' });
    expect(await screen.findByText('قُسّمت هذه الفاتورة إلى:')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /INV-\d{4}-\d{6}/ }).length).toBe(2);
  });

  it('record payment: over the balance is refused, then a partial payment', async () => {
    const user = userEvent.setup();
    renderPage(<InvoiceDetailView id={1} />, { path: '/invoices/1' });
    await user.click(await screen.findByRole('button', { name: 'تسجيل دفعة' }));
    const dialog = await screen.findByRole('dialog', { name: /تسجيل دفعة على الفاتورة/ });
    const amount = within(dialog).getByRole('textbox', { name: /المبلغ/ });
    expect(amount).toHaveValue('145.00');
    await user.clear(amount);
    await user.type(amount, '500');
    await user.click(within(dialog).getByRole('button', { name: 'سجّل الدفعة' }));
    expect(await within(dialog).findByText(/المبلغ أكبر من الرصيد المستحق/)).toBeInTheDocument();
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    await user.clear(amount);
    await user.type(amount, '45');
    await user.click(within(dialog).getByRole('button', { name: 'سجّل الدفعة' }));
    expect(await screen.findByText('سُجّلت الدفعة.')).toBeInTheDocument();
    await waitFor(() =>
      expect(bdb.invoices.find((i) => i.id === 1)?.status).toBe('partially_paid'),
    );
  });

  it('void needs a reason; the API refusal is shown in Arabic', async () => {
    const user = userEvent.setup();
    renderPage(<InvoiceDetailView id={1} />, { path: '/invoices/1' });
    await user.click(await screen.findByRole('button', { name: 'إجراءات أخرى' }));
    await user.click(await screen.findByRole('menuitem', { name: 'إلغاء الفاتورة' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'إلغاء الفاتورة' }));
    expect(within(dialog).getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    server.use(
      http.post('*/api/v1/invoices/:id/void', () =>
        HttpResponse.json({ message: 'x', code: 'has_payments' }, { status: 422 }),
      ),
    );
    await user.type(within(dialog).getByRole('textbox'), 'خطأ في الإصدار');
    await user.click(within(dialog).getByRole('button', { name: 'إلغاء الفاتورة' }));
    expect(
      await within(dialog).findByText(
        'لا يمكن إلغاء فاتورة عليها دفعة. ألغِ الدفعة أو استردها أولًا.',
      ),
    ).toBeInTheDocument();
  });

  it('a reminder while parent emails are off says so', async () => {
    const user = userEvent.setup();
    renderPage(<InvoiceDetailView id={1} />, { path: '/invoices/1' });
    await user.click(await screen.findByRole('button', { name: 'أرسل تذكيرًا' }));
    expect(
      await screen.findByText('رسائل البريد إلى أولياء الأمور متوقفة (billing.notify_parents).'),
    ).toBeInTheDocument();
  });

  it('a discount by percent adds a line', async () => {
    const user = userEvent.setup();
    renderPage(<InvoiceDetailView id={1} />, { path: '/invoices/1' });
    await user.click(await screen.findByRole('button', { name: 'إجراءات أخرى' }));
    await user.click(await screen.findByRole('menuitem', { name: 'إضافة خصم' }));
    const dialog = await screen.findByRole('dialog', { name: 'إضافة خصم' });
    await user.click(within(dialog).getByRole('radio', { name: 'نسبة مئوية' }));
    await user.type(within(dialog).getByRole('textbox', { name: /النسبة/ }), '10');
    await user.click(within(dialog).getByRole('button', { name: 'أضف الخصم' }));
    expect(await within(dialog).findByText(/اكتب السبب/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /السبب/ }), 'خصم الأخوة');
    await user.click(within(dialog).getByRole('button', { name: 'أضف الخصم' }));
    expect(await screen.findByText('أُضيف البند وأُعيد حساب الفاتورة.')).toBeInTheDocument();
    const line = bdb.invoices.find((i) => i.id === 1)!.lines.at(-1)!;
    expect(line).toMatchObject({ type: 'discount', amountMinor: -1450 });
  });

  it('split: the parts must add up to the total', async () => {
    const user = userEvent.setup();
    renderPage(<InvoiceDetailView id={1} />, { path: '/invoices/1' });
    await user.click(await screen.findByRole('button', { name: 'إجراءات أخرى' }));
    await user.click(await screen.findByRole('menuitem', { name: 'تقسيم الفاتورة' }));
    const dialog = await screen.findByRole('dialog', { name: /تقسيم الفاتورة/ });
    const first = within(dialog).getByRole('textbox', { name: /مبلغ الجزء 1/ });
    expect(first).toHaveValue('72.50');
    await user.clear(first);
    await user.type(first, '70');
    await user.type(within(dialog).getByRole('textbox', { name: /السبب/ }), 'طلب ولي الأمر');
    await user.click(within(dialog).getByRole('button', { name: 'قسّم إلى جزأين' }));
    expect(
      await within(dialog).findByText(/يجب أن يساوي مجموع الأجزاء إجمالي الفاتورة/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'وزّع بالتساوي' }));
    await user.click(within(dialog).getByRole('button', { name: 'قسّم إلى جزأين' }));
    expect(await screen.findByText('قُسّمت الفاتورة.')).toBeInTheDocument();
    expect(bdb.invoices.find((i) => i.id === 1)?.status).toBe('split');
  });

  it('a missing invoice shows «not found»', async () => {
    renderPage(<InvoiceDetailView id={999} />, { path: '/invoices/999' });
    expect(await screen.findByText('الفاتورة غير موجودة')).toBeInTheDocument();
  });

  it('with invoices.view only there are no actions', async () => {
    const me = (await import('@/mocks/data')).MOCK_USERS.find((u) => u.id === 4)!;
    const saved = me.permissions;
    me.permissions = [...saved, 'invoices.view'];
    renderPage(<InvoiceDetailView id={1} />, {
      as: 'supervisor@qarabic.test',
      path: '/invoices/1',
    });
    expect(await screen.findByRole('heading', { level: 1, name: /INV-/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'تسجيل دفعة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إجراءات أخرى' })).not.toBeInTheDocument();
    me.permissions = saved;
  });
});

describe('Fee packages, family billing, settings', () => {
  it('lists packages and validates a new one', async () => {
    const user = userEvent.setup();
    renderPage(<PackagesView />, { path: '/packages' });
    const t = await table('الباقات');
    expect(within(t).getByText('باقة يومين')).toBeInTheDocument();
    expect(within(t).getByText('مؤرشفة')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'أضف باقة' }));
    const dialog = await screen.findByRole('dialog', { name: 'أضف باقة' });
    await user.click(within(dialog).getByRole('button', { name: 'احفظ الباقة' }));
    expect(await within(dialog).findByText('هذا الحقل مطلوب.')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /اسم الباقة/ }), 'باقة خمسة أيام');
    await user.type(within(dialog).getByRole('textbox', { name: 'السعر الشهري بعملة USD' }), '140');
    await user.click(within(dialog).getByRole('button', { name: 'احفظ الباقة' }));
    expect(await screen.findByText('حُفظت الباقة.')).toBeInTheDocument();
    expect(bdb.packages.at(-1)).toMatchObject({ name: 'باقة خمسة أيام', prices: { USD: 14000 } });
  });

  it('packages.view without packages.manage: no add or edit', async () => {
    const data = await import('@/mocks/data');
    const me = data.MOCK_USERS.find((u) => u.id === 4)!;
    const saved = me.permissions;
    me.permissions = [...saved, 'packages.view'];
    renderPage(<PackagesView />, { as: 'supervisor@qarabic.test', path: '/packages' });
    await table('الباقات');
    expect(screen.queryByRole('button', { name: /تعديل/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'أضف باقة' })).not.toBeInTheDocument();
    me.permissions = saved;
  });

  it('family billing: next invoice, warnings and saving the profile', async () => {
    const user = userEvent.setup();
    renderPage(
      <div>
        <FamilyBillingSection familyId={4} />
      </div>,
      { path: '/families/4' },
    );
    expect(await screen.findByText('لن تكتمل الفاتورة القادمة')).toBeInTheDocument();
    expect(screen.getByText(/باقة بلا سعر بعملة الأسرة/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'بيانات الفوترة' });
    await user.type(within(form).getByRole('textbox', { name: /رسوم شهرية ثابتة/ }), 'abc');
    await user.click(within(form).getByRole('button', { name: 'احفظ بيانات الفوترة' }));
    expect(await within(form).findByText(/أدخل مبلغًا أكبر من صفر/)).toBeInTheDocument();
    const fee = within(form).getByRole('textbox', { name: /رسوم شهرية ثابتة/ });
    await user.clear(fee);
    await user.type(fee, '150');
    await user.click(within(form).getByRole('button', { name: 'احفظ بيانات الفوترة' }));
    expect(await screen.findByText(/حُفظت بيانات الفوترة/)).toBeInTheDocument();
    expect(bdb.profiles.get(4)?.customFeeMinor).toBe(15000);
    await waitFor(() =>
      expect(screen.queryByText('لن تكتمل الفاتورة القادمة')).not.toBeInTheDocument(),
    );
  });

  it('billing settings: parent emails are shown off and not editable; days are validated', async () => {
    const user = userEvent.setup();
    renderPage(<BillingSettingsView />, { path: '/settings/billing' });
    const notify = await screen.findByRole('switch', { name: 'رسائل البريد إلى أولياء الأمور' });
    expect(notify).toBeDisabled();
    expect(notify).not.toBeChecked();
    const days = screen.getByRole('textbox', { name: 'أيام التذكير' });
    await user.clear(days);
    await user.type(days, '-3, x');
    await user.click(screen.getByRole('button', { name: 'احفظ الإعدادات' }));
    expect(await screen.findByText(/أدخل عشرة أرقام صحيحة/)).toBeInTheDocument();
    await user.clear(days);
    await user.type(days, '-5, 0, 5');
    await user.click(screen.getByRole('checkbox', { name: 'إجازة' }));
    await user.click(screen.getByRole('button', { name: 'احفظ الإعدادات' }));
    expect(await screen.findByText('حُفظت إعدادات الفوترة.')).toBeInTheDocument();
    expect(bdb.settings['billing.reminder_days']).toEqual([-5, 0, 5]);
    expect(bdb.settings['billing.deducting_stages']).toContain('leave');
    expect(bdb.settings['billing.notify_parents']).toBe(false);
  });
});
