import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MyAttendanceView } from '@/components/payroll/attendance-view';
import { PayslipView } from '@/components/payroll/payslip-view';
import { AttendanceRoute, PayrollRoute } from '@/components/payroll/routes';
import { server } from '@/mocks/node';
import { pdb } from '@/mocks/payroll-db';
import { renderPage } from '@/test/people';

const TEACHER = 'teacher@qarabic.test';

describe('Teacher: my attendance and leave', () => {
  it('checks in, then out (server clock); the day shows both times', async () => {
    const user = userEvent.setup();
    renderPage(<MyAttendanceView />, { as: TEACHER, path: '/attendance' });
    expect(await screen.findByText('لم تسجّل حضورك اليوم بعد.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'تسجيل الحضور' }));
    expect(await screen.findByText('سُجّل حضورك.')).toBeInTheDocument();
    expect(await screen.findByText(/سُجّل الحضور الساعة/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'تسجيل الانصراف' }));
    expect(await screen.findByText('سُجّل انصرافك.')).toBeInTheDocument();
    expect(await screen.findByText(/اكتمل يوم العمل/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /تسجيل الحضور|تسجيل الانصراف/ })).toBeNull();
  });

  it('a second check-in is refused with the API reason, in Arabic', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/v1/attendance/check-in', () =>
        HttpResponse.json(
          { code: 'already_checked_in', message: 'You have already checked in today.' },
          { status: 409 },
        ),
      ),
    );
    renderPage(<MyAttendanceView />, { as: TEACHER, path: '/attendance' });
    await user.click(await screen.findByRole('button', { name: 'تسجيل الحضور' }));
    expect(await screen.findByText('سجّلت حضورك اليوم بالفعل.')).toBeInTheDocument();
  });

  it('requests leave: dates in order and a reason; the request shows as pending', async () => {
    const user = userEvent.setup();
    renderPage(<MyAttendanceView />, { as: TEACHER, path: '/attendance' });
    const mine = await screen.findByRole('table', { name: 'طلبات الإجازة' });
    await waitFor(() => expect(within(mine).getAllByRole('row')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'طلب إجازة' }));
    const dialog = await screen.findByRole('dialog', { name: 'طلب إجازة' });
    await user.click(within(dialog).getByRole('button', { name: 'أرسل الطلب' }));
    expect(within(dialog).getByText(/اكتب السبب/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /السبب/ }), 'Family wedding');
    await user.click(within(dialog).getByRole('button', { name: 'أرسل الطلب' }));
    expect(await screen.findByText('أُرسل طلب الإجازة.')).toBeInTheDocument();
    await waitFor(() => expect(within(mine).getAllByRole('row')).toHaveLength(3));
    expect(within(mine).getByText('قيد المراجعة')).toBeInTheDocument();
    // Own pending request: withdraw, not decide.
    expect(within(mine).getByRole('button', { name: 'سحب الطلب' })).toBeInTheDocument();
    expect(within(mine).queryByRole('button', { name: /موافقة/ })).toBeNull();
    expect(pdb.leave.at(-1)).toMatchObject({ userId: 2, status: 'pending' });
  });

  it('the /attendance route gives a teacher «حضوري وإجازاتي»', async () => {
    renderPage(<AttendanceRoute />, { as: TEACHER, path: '/attendance' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'حضوري وإجازاتي' }),
    ).toBeInTheDocument();
  });
});

describe('Teacher: my salary', () => {
  it('lists own approved payslips and the wallet', async () => {
    renderPage(<PayrollRoute />, { as: TEACHER, path: '/payroll' });
    expect(await screen.findByRole('heading', { level: 1, name: 'راتبي' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'قسائم الراتب' });
    expect(within(list).getAllByRole('link')).toHaveLength(2);
    expect(within(list).getAllByText('مصروفة')).toHaveLength(2);
    const history = await screen.findByRole('list', { name: 'حركات المحفظة' });
    expect(within(history).getAllByText(/صرف راتب/).length).toBe(2);
    expect(screen.getByText(/رصيد المحفظة/)).toBeInTheDocument();
  });

  it('opens own payslip without staff actions; another person’s is not found', async () => {
    const own = pdb.slips.find((s) => s.userId === 2)!;
    const { unmount } = renderPage(<PayslipView id={own.id} />, {
      as: TEACHER,
      path: `/payroll/payslips/${own.id}`,
    });
    expect(await screen.findByRole('heading', { level: 1, name: /قسيمة الراتب/ })).toBeVisible();
    expect(screen.getByRole('table', { name: 'بنود القسيمة' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'سجّل الصرف' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'أضف بندًا' })).toBeNull();
    expect(screen.getByRole('button', { name: 'طباعة' })).toBeInTheDocument();
    unmount();
    const other = pdb.slips.find((s) => s.userId === 102)!;
    renderPage(<PayslipView id={other.id} />, {
      as: TEACHER,
      path: `/payroll/payslips/${other.id}`,
    });
    expect(await screen.findByText('لم يُعثر على هذه القسيمة أو لم تُعتمد بعد.')).toBeInTheDocument();
  });
});
