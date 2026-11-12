'use client';

import { useCurrentUser } from '@/components/shell/app-shell';
import { can } from '@/lib/auth/use-me';
import { AttendanceView, MyAttendanceView } from './attendance-view';
import { RunsView } from './runs-view';
import { MyPayrollView } from './wallet-views';

/** `/attendance`: the staff workbench with `attendance.manage`, «حضوري وإجازاتي» for everyone else. */
export function AttendanceRoute() {
  const me = useCurrentUser();
  return can(me, 'attendance.manage') ? <AttendanceView /> : <MyAttendanceView />;
}

/** `/payroll`: the runs for payroll staff, «راتبي» (own payslips and wallet) for everyone else. */
export function PayrollRoute() {
  const me = useCurrentUser();
  const staff =
    can(me, 'payroll.manage') || can(me, 'payroll.review') || can(me, 'payroll.approve');
  return staff ? <RunsView /> : <MyPayrollView />;
}
