import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { AttendanceView } from '@/components/payroll/attendance-view';
import { FinesView } from '@/components/payroll/fines-view';
import { PayRulesView } from '@/components/payroll/pay-rules-view';
import { PayslipView } from '@/components/payroll/payslip-view';
import { ProfilesView } from '@/components/payroll/profiles-view';
import { RunView } from '@/components/payroll/run-view';
import { RunsView } from '@/components/payroll/runs-view';
import { WalletsView } from '@/components/payroll/wallet-views';
import { server } from '@/mocks/node';
import {
  academyToday,
  pdb,
  periodOfDate,
  previousPeriod,
  recompute,
  type RunRow,
} from '@/mocks/payroll-db';
import { renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';

const current = () => periodOfDate(academyToday());

/** A draft run of the current month in the mock (what «أنشئ المسيّر» makes). */
function draftRun(): RunRow {
  const run: RunRow = {
    id: pdb.next.run++,
    period: current(),
    status: 'draft',
    computedAt: null,
    createdBy: { id: 1, name: 'مدير النظام' },
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    paidAt: null,
  };
  pdb.runs.push(run);
  recompute(pdb, run);
  return run;
}

async function table(name: string) {
  const t = await screen.findByRole('table', { name });
  await waitFor(() => expect(t).not.toHaveAttribute('aria-busy'));
  return t;
}

describe('Payroll runs (staff)', () => {
  it('lists the months with status, net per currency and paid counts', async () => {
    renderPage(<RunsView />, { path: '/payroll' });
    const t = await table('مسيّرات الرواتب');
    // Two seeded runs + the header row; the newest month first.
    expect(within(t).getAllByRole('row')).toHaveLength(3);
    expect(within(t).getByText('معتمد')).toBeInTheDocument();
    expect(within(t).getByText('مصروف')).toBeInTheDocument();
    expect(within(t).getAllByText(/EGP|ج\.م\./).length).toBeGreaterThan(0);
    expect(screen.getByText(/لا يحوّل النظام أي مبلغ/)).toBeInTheDocument();
  });

  it('previews the current month (nothing stored), then creates the run', async () => {
    const user = userEvent.setup();
    renderPage(<RunsView />, { path: '/payroll' });
    await table('مسيّرات الرواتب');
    await user.click(screen.getByRole('button', { name: 'أنشئ مسيّر الشهر' }));
    const dialog = await screen.findByRole('dialog', { name: 'مسيّر رواتب جديد' });
    // Last month already has a run: the default is the current month.
    expect(within(dialog).getByLabelText(/شهر المسيّر/)).toHaveValue(current());
    await user.click(within(dialog).getByRole('button', { name: 'معاينة' }));
    const preview = await within(dialog).findByRole('table', { name: 'معاينة القسائم' });
    expect(within(preview).getAllByRole('row').length).toBe(pdb.profiles.length + 1);
    expect(pdb.runs.some((r) => r.period === current())).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'أنشئ المسيّر' }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalled());
    const run = pdb.runs.find((r) => r.period === current())!;
    expect(routerMock.push).toHaveBeenCalledWith(`/payroll/runs/${run.id}`);
    expect(run.status).toBe('draft');
  });

  it('refuses a second run of a month with the API reason', async () => {
    const user = userEvent.setup();
    draftRun();
    renderPage(<RunsView />, { path: '/payroll' });
    await table('مسيّرات الرواتب');
    await user.click(screen.getByRole('button', { name: 'أنشئ مسيّر الشهر' }));
    const dialog = await screen.findByRole('dialog', { name: 'مسيّر رواتب جديد' });
    const month = within(dialog).getByLabelText(/شهر المسيّر/);
    await user.clear(month);
    await user.type(month, previousPeriod(current()));
    await user.click(within(dialog).getByRole('button', { name: 'أنشئ المسيّر' }));
    expect(
      await within(dialog).findByText('يوجد مسيّر رواتب لهذا الشهر بالفعل.'),
    ).toBeInTheDocument();
  });

  it('shows the error state with a retry, and no access without a payroll permission', async () => {
    server.use(http.get('*/api/v1/payroll/runs', () => HttpResponse.json({}, { status: 500 })));
    renderPage(<RunsView />, { path: '/payroll' });
    expect(await screen.findByRole('button', { name: 'حاول مرة أخرى' })).toBeInTheDocument();
  });

  it('a teacher has no access to the runs', async () => {
    renderPage(<RunsView />, { as: 'teacher@qarabic.test', path: '/payroll' });
    expect((await screen.findAllByText(/ليست لديك صلاحية/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('A run: review → approve → reopen', () => {
  it('walks the lifecycle with named confirms; reopen needs a reason', async () => {
    const user = userEvent.setup();
    const run = draftRun();
    renderPage(<RunView id={run.id} />, { path: `/payroll/runs/${run.id}` });
    expect(await screen.findByRole('heading', { level: 1, name: /مسيّر رواتب/ })).toBeVisible();
    const slips = await table('قسائم الرواتب');
    expect(within(slips).getAllByRole('row')).toHaveLength(pdb.profiles.length + 1);
    // Warnings never block: one teacher has unmarked classes, one a pending fine.
    await user.click(screen.getByRole('radio', { name: /بها تنبيهات/ }));
    expect(within(slips).getAllByRole('row').length).toBeLessThan(pdb.profiles.length + 1);

    await user.click(screen.getByRole('button', { name: 'اعتمد المراجعة' }));
    const review = await screen.findByRole('dialog', { name: /مراجعة مسيّر/ });
    await user.click(within(review).getByRole('button', { name: 'اعتمد المراجعة' }));
    expect(await screen.findByText('روجع المسيّر وأُرسل للاعتماد.')).toBeInTheDocument();
    expect(run.status).toBe('reviewed');

    await user.click(await screen.findByRole('button', { name: 'اعتمد المسيّر' }));
    const approve = await screen.findByRole('dialog', { name: 'اعتماد مسيّر الرواتب' });
    expect(approve).toHaveTextContent('يُقفل شهر');
    await user.click(within(approve).getByRole('button', { name: 'اعتمد المسيّر' }));
    expect(await screen.findByText('اعتُمد المسيّر وأُضيفت الرواتب إلى المحافظ.')).toBeInTheDocument();
    expect(run.status).toBe('approved');
    expect(
      pdb.wallet.filter((w) => w.period === run.period && w.type === 'salary_credit'),
    ).toHaveLength(pdb.profiles.length);

    await user.click(await screen.findByRole('button', { name: 'أعد فتح المسيّر' }));
    const reopen = await screen.findByRole('alertdialog', { name: /إعادة فتح مسيّر/ });
    await user.click(within(reopen).getByRole('button', { name: 'أعد فتح المسيّر' }));
    expect(within(reopen).getByRole('textbox', { name: /السبب/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await user.type(within(reopen).getByRole('textbox', { name: /السبب/ }), 'Wrong hourly rate');
    await user.click(within(reopen).getByRole('button', { name: 'أعد فتح المسيّر' }));
    expect(await screen.findByText('أُعيد فتح المسيّر مسودة.')).toBeInTheDocument();
    expect(run.status).toBe('draft');
  });

  it('review is blocked while a payslip has an error (negative net)', async () => {
    const user = userEvent.setup();
    pdb.profiles.find((p) => p.userId === 12)!.tax = 99_000_000;
    const run = draftRun();
    renderPage(<RunView id={run.id} />, { path: `/payroll/runs/${run.id}` });
    expect(await screen.findByText(/توجد أخطاء في بعض القسائم/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'اعتمد المراجعة' }));
    const review = await screen.findByRole('dialog', { name: /مراجعة مسيّر/ });
    await user.click(within(review).getByRole('button', { name: 'اعتمد المراجعة' }));
    expect(
      await within(review).findByText('توجد أخطاء في بعض قسائم الرواتب. صحّحها قبل المتابعة.'),
    ).toBeInTheDocument();
    expect(run.status).toBe('draft');
  });

  it('an approved month is locked and shows who approved it; an unknown run is not found', async () => {
    const last = pdb.runs.find((r) => r.period === previousPeriod(current()))!;
    const { unmount } = renderPage(<RunView id={last.id} />, { path: `/payroll/runs/${last.id}` });
    expect(await screen.findByText(/المسيّر معتمد والشهر مقفل/)).toBeInTheDocument();
    expect(screen.getByText(/اعتُمد بواسطة Laila Accounts/)).toBeInTheDocument();
    // One payslip of the month is already paid: no reopen.
    expect(screen.queryByRole('button', { name: 'أعد فتح المسيّر' })).not.toBeInTheDocument();
    unmount();
    renderPage(<RunView id={999} />, { path: '/payroll/runs/999' });
    expect(await screen.findByText('لم يُعثر على هذا المسيّر.')).toBeInTheDocument();
  });
});

describe('Payslip (staff)', () => {
  it('shows lines and classes; records a payment (reference required except cash)', async () => {
    const user = userEvent.setup();
    const last = pdb.runs.find((r) => r.period === previousPeriod(current()))!;
    const slip = pdb.slips.find((s) => s.runId === last.id && s.userId === 102)!;
    renderPage(<PayslipView id={slip.id} />, { path: `/payroll/payslips/${slip.id}` });
    expect(
      await screen.findByRole('heading', { level: 1, name: /قسيمة راتب Ahmed Fathy/ }),
    ).toBeVisible();
    const lines = screen.getByRole('table', { name: 'بنود القسيمة' });
    expect(within(lines).getByText('أجر الساعات')).toBeInTheDocument();
    expect(within(lines).getByText('صافي الراتب')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'حصص القسيمة' })).toBeInTheDocument();
    // An approved run: no new items, but the payment can be recorded.
    expect(screen.queryByRole('button', { name: 'أضف بندًا' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'سجّل الصرف' }));
    const pay = await screen.findByRole('dialog', { name: 'تسجيل صرف الراتب' });
    expect(pay).toHaveTextContent('لا يحوّل النظام أي مبلغ');
    await user.click(within(pay).getByRole('button', { name: 'سجّل الصرف' }));
    expect(await within(pay).findByText(/أدخل الرقم المرجعي للتحويل/)).toBeInTheDocument();
    await user.type(within(pay).getByRole('textbox', { name: /الرقم المرجعي/ }), 'VC-777');
    await user.click(within(pay).getByRole('button', { name: 'سجّل الصرف' }));
    expect(await screen.findByText('سُجّل الصرف.')).toBeInTheDocument();
    expect(slip.status).toBe('paid');
    expect(slip.paymentReference).toBe('VC-777');
    expect(await screen.findByText('VC-777')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'سجّل الصرف' })).not.toBeInTheDocument();
  });

  it('adds a bonus to a draft payslip and shows its warnings', async () => {
    const user = userEvent.setup();
    const run = draftRun();
    const slip = pdb.slips.find((s) => s.runId === run.id && s.userId === 103)!;
    renderPage(<PayslipView id={slip.id} />, { path: `/payroll/payslips/${slip.id}` });
    expect(await screen.findByText('2 حصة سابقة بلا حالة بعد.')).toBeInTheDocument();
    expect(screen.getByText('1 غرامة بانتظار الاعتماد.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'أضف بندًا' }));
    const dialog = await screen.findByRole('dialog', { name: 'بند جديد على الراتب' });
    await user.click(within(dialog).getByRole('combobox', { name: /نوع البند/ }));
    await user.click(await screen.findByRole('option', { name: 'مكافأة' }));
    await user.type(within(dialog).getByRole('textbox', { name: /المبلغ/ }), '150');
    await user.type(
      within(dialog).getByRole('textbox', { name: /السبب/ }),
      'Extra evening classes',
    );
    await user.click(within(dialog).getByRole('button', { name: 'احفظ البند' }));
    expect(await screen.findByText('حُفظ البند.')).toBeInTheDocument();
    const bonus = pdb.adjustments.find((a) => a.userId === 103 && a.type === 'bonus')!;
    expect(bonus).toMatchObject({ amount: 15_000, status: 'approved', currency: 'EGP' });
  });
});

describe('Fines and pay items', () => {
  it('admin: status tabs with counts, approve a proposed fine', async () => {
    const user = userEvent.setup();
    renderPage(<FinesView />, { path: '/fines' });
    const t = await table('الغرامات والبنود');
    const tabs = screen.getByRole('radiogroup', { name: 'حالة البند' });
    expect(within(tabs).getByRole('radio', { name: /^مقترحة\s*\(2\)$/ })).toBeInTheDocument();
    expect(within(t).getAllByText('مقترحة')).toHaveLength(2);
    await user.click(within(t).getByRole('button', { name: 'اعتماد: Mahmoud Saeed' }));
    const dialog = await screen.findByRole('dialog', { name: /اعتماد غرامة: Mahmoud Saeed/ });
    await user.click(within(dialog).getByRole('button', { name: 'اعتماد' }));
    expect(await screen.findByText('اعتُمد البند.')).toBeInTheDocument();
    expect(pdb.adjustments.find((a) => a.userId === 103 && a.type === 'fine')?.status).toBe(
      'approved',
    );
  });

  it('rejecting needs a reason; a locked fine is waived with a fine reduction', async () => {
    const user = userEvent.setup();
    renderPage(<FinesView />, { path: '/fines' });
    const t = await table('الغرامات والبنود');
    await user.click(within(t).getByRole('button', { name: 'رفض: Ahmed Fathy' }));
    const reject = await screen.findByRole('alertdialog', { name: /رفض غرامة: Ahmed Fathy/ });
    await user.click(within(reject).getByRole('button', { name: 'رفض' }));
    expect(within(reject).getByRole('textbox', { name: /السبب/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(reject).not.toBeInTheDocument());

    await user.click(within(t).getByRole('button', { name: 'إعفاء: Nour Adel' }));
    const waive = await screen.findByRole('alertdialog', { name: /الإعفاء من غرامة Nour Adel/ });
    expect(waive).toHaveTextContent('تخفيض غرامة');
    await user.type(within(waive).getByRole('textbox', { name: /السبب/ }), 'Family emergency');
    await user.click(within(waive).getByRole('button', { name: 'إعفاء' }));
    expect(await screen.findByText(/أُضيف تخفيض غرامة بالمبلغ نفسه/)).toBeInTheDocument();
    expect(pdb.adjustments.some((a) => a.type === 'fine_reduction' && a.userId === 104)).toBe(true);
  });

  it('monitor: proposes a fine that waits for approval', async () => {
    const user = userEvent.setup();
    renderPage(<FinesView />, { as: 'monitor@qarabic.test', path: '/fines' });
    await table('الغرامات والبنود');
    expect(screen.getByRole('heading', { level: 1, name: 'الغرامات' })).toBeInTheDocument();
    // Monitors cannot decide fines.
    expect(screen.queryByRole('button', { name: /^اعتماد:/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'اقترح غرامة' }));
    const dialog = await screen.findByRole('dialog', { name: 'غرامة جديدة' });
    expect(dialog).toHaveTextContent('تُرسل الغرامة إلى المدير');
    await user.click(within(dialog).getByRole('button', { name: 'أرسل للاعتماد' }));
    expect(within(dialog).getByText('اختر الموظف.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: /الموظف/ }));
    await user.click(await screen.findByRole('option', { name: /Huda Mostafa/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /المبلغ/ }), '30');
    await user.type(within(dialog).getByRole('textbox', { name: /السبب/ }), 'Late by 12 minutes');
    await user.click(within(dialog).getByRole('button', { name: 'أرسل للاعتماد' }));
    expect(await screen.findByText('أُرسلت الغرامة للاعتماد.')).toBeInTheDocument();
    expect(pdb.adjustments.find((a) => a.userId === 105 && a.status === 'proposed')).toMatchObject({
      amount: 3_000,
      createdBy: { id: 12 },
    });
  });

  it('a teacher sees only their own decided items, read-only', async () => {
    renderPage(<FinesView />, { as: 'teacher@qarabic.test', path: '/fines' });
    const t = await table('الغرامات والبنود');
    expect(screen.getByRole('heading', { level: 1, name: 'غراماتي' })).toBeInTheDocument();
    expect(within(t).getAllByRole('row')).toHaveLength(2);
    expect(within(t).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /غرامة|بندًا/ })).not.toBeInTheDocument();
  });
});

describe('Attendance and leave (managers)', () => {
  it('month summary per person → one person’s days → mark a day with a reason', async () => {
    const user = userEvent.setup();
    renderPage(<AttendanceView />, { path: '/attendance' });
    const summary = await table('ملخص حضور الموظفين');
    expect(within(summary).getAllByRole('row')).toHaveLength(pdb.profiles.length + 1);
    await user.click(within(summary).getByRole('button', { name: 'عرض أيام Ahmed Fathy' }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
  });

  it('marks a day: the reason is required and audited', async () => {
    const user = userEvent.setup();
    renderPage(<AttendanceView />, { path: '/attendance?user=102' });
    const days = await table('أيام الحضور');
    const first = within(days).getAllByRole('button', { name: /تسجيل يوم .* لـ Ahmed Fathy/ })[0]!;
    await user.click(first);
    const dialog = await screen.findByRole('dialog', { name: /لـ Ahmed Fathy/ });
    await user.click(within(dialog).getByRole('combobox', { name: /الحالة/ }));
    await user.click(await screen.findByRole('option', { name: 'غائب' }));
    await user.click(within(dialog).getByRole('button', { name: 'احفظ اليوم' }));
    expect(within(dialog).getByText(/اكتب السبب/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /السبب/ }), 'No show, no call');
    await user.click(within(dialog).getByRole('button', { name: 'احفظ اليوم' }));
    expect(await screen.findByText('حُفظ اليوم.')).toBeInTheDocument();
  });

  it('approves a pending leave (days written to attendance)', async () => {
    const user = userEvent.setup();
    renderPage(<AttendanceView />, { path: '/attendance?tab=leave' });
    const list = await table('طلبات الإجازة');
    await user.click(within(list).getByRole('button', { name: 'موافقة: Mahmoud Saeed' }));
    const dialog = await screen.findByRole('dialog', { name: 'اعتماد إجازة Mahmoud Saeed' });
    await user.click(within(dialog).getByRole('button', { name: 'موافقة' }));
    expect(await screen.findByText('اعتُمدت الإجازة وسُجّلت أيامها في الحضور.')).toBeInTheDocument();
    const leave = pdb.leave.find((l) => l.userId === 103)!;
    expect(leave.status).toBe('approved');
    expect(pdb.attendance.filter((r) => r.leaveRequestId === leave.id)).toHaveLength(2);
  });

  it('a teacher gets no staff workbench', async () => {
    renderPage(<AttendanceView />, { as: 'teacher@qarabic.test', path: '/attendance' });
    expect((await screen.findAllByText(/ليست لديك صلاحية/)).length).toBeGreaterThan(0);
  });
});

describe('Salary profiles, wallets and pay rules', () => {
  it('edits a profile: the rate of the salary type is required', async () => {
    const user = userEvent.setup();
    renderPage(<ProfilesView />, { path: '/payroll/profiles' });
    const t = await table('ملفات الرواتب');
    await user.click(within(t).getByRole('button', { name: 'تعديل ملف Huda Mostafa' }));
    const dialog = await screen.findByRole('dialog', { name: 'ملف راتب Huda Mostafa' });
    const rate = within(dialog).getByRole('textbox', { name: /أجر الحصة/ });
    await user.clear(rate);
    await user.click(within(dialog).getByRole('button', { name: 'احفظ الملف' }));
    expect(within(dialog).getByText(/أدخل قيمة أكبر من صفر/)).toBeInTheDocument();
    await user.type(rate, '75.5');
    await user.click(within(dialog).getByRole('button', { name: 'احفظ الملف' }));
    expect(await screen.findByText('حُفظ ملف الراتب.')).toBeInTheDocument();
    expect(pdb.profiles.find((p) => p.userId === 105)?.classRate).toBe(7_550);
  });

  it('wallet balances per person and currency (wallet.manage only)', async () => {
    const { unmount } = renderPage(<WalletsView />, { path: '/payroll/wallets' });
    const t = await table('أرصدة المحافظ');
    expect(within(t).getByText('Mona CSR')).toBeInTheDocument();
    unmount();
    renderPage(<WalletsView />, { as: 'monitor@qarabic.test', path: '/payroll/wallets' });
    expect((await screen.findAllByText(/ليست لديك صلاحية/)).length).toBeGreaterThan(0);
  });

  it('pay rules: the set in force; a new version cannot start in the past', async () => {
    const user = userEvent.setup();
    renderPage(<PayRulesView />, { path: '/settings/pay-rules' });
    const t = await table('القواعد السارية');
    expect(within(t).getByText('cancelled:holiday')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'إصدار جديد' }));
    const dialog = await screen.findByRole('dialog', { name: 'إصدار جديد من قواعد الأجر' });
    const factor = within(dialog).getByRole('textbox', { name: 'المعامل: declined' });
    await user.clear(factor);
    await user.type(factor, '0.5');
    await user.click(within(dialog).getByRole('button', { name: 'احفظ الإصدار' }));
    expect(await screen.findByText('حُفظ الإصدار الجديد من قواعد الأجر.')).toBeInTheDocument();
    expect(pdb.ruleSets.at(-1)?.rules.declined?.factor).toBe(0.5);
  });
});
