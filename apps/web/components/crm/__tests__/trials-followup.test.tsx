import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConvertDialog } from '@/components/crm/convert-dialog';
import { CrmSettingsView } from '@/components/crm/crm-settings-view';
import { TrialsTodayView } from '@/components/crm/trials-today-view';
import { crmdb } from '@/mocks/crm-db';
import { presentDetail } from '@/mocks/crm-handlers';
import { MOCK_USERS } from '@/mocks/data';
import { sdb } from '@/mocks/schedule-db';
import { trialReports } from '@/mocks/teaching-handlers';
import { renderPage } from '@/test/people';

const MINUTE = 60_000;

/** Two of today's classes made trial classes: one not started 30 min in, one ended unreported. */
function seedToday() {
  const rows = sdb.sessions.filter((x) => !x.deleted && x.stage === 'scheduled').slice(0, 2);
  const [late, ended] = rows as [(typeof rows)[0], (typeof rows)[0]];
  Object.assign(late, {
    kind: 'trial',
    startsAt: new Date(Date.now() - 20 * MINUTE).toISOString(),
    durationMinutes: 45,
    startedAt: null,
  });
  Object.assign(ended, {
    kind: 'trial',
    stage: 'ended',
    startsAt: new Date(Date.now() - 90 * MINUTE).toISOString(),
    durationMinutes: 30,
    startedAt: new Date(Date.now() - 88 * MINUTE).toISOString(),
  });
  return { late, ended };
}

describe('T4 «الحصص التجريبية اليوم»', () => {
  it('lists the trial classes that need attention, with why; «الكل» shows every one', async () => {
    const user = userEvent.setup();
    const { late, ended } = seedToday();
    renderPage(<TrialsTodayView />, { as: 'monitor@qarabic.test', path: '/trials' });
    const table = await screen.findByRole('table', { name: 'الحصص التجريبية اليوم' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1));
    expect(table).toHaveTextContent('لم يبدأ المعلم الحصة');
    expect(table).toHaveTextContent('لا يوجد تقرير الحصة التجريبية');
    expect(table).toHaveTextContent(/لم يبدأ منذ \d+ د/);
    await user.click(screen.getByRole('radio', { name: /^الكل/ }));
    expect(late.id).not.toBe(ended.id);
  });

  it('is for monitors and customer service only', async () => {
    renderPage(<TrialsTodayView />, { as: 'teacher@qarabic.test', path: '/trials' });
    expect(await screen.findByText('ليست لديك صلاحية', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('T4 convert prefill from the trial report', () => {
  it('starts each child from the teacher’s recommendation: course, length, weekly times', async () => {
    const row = crmdb.leads.find((l) => l.id === 7)!;
    const trial = row.trials[0]!;
    trialReports.set(trial.sessionId, {
      sessionId: trial.sessionId,
      leadId: row.id,
      attendance: 'on_time',
      level: 'beginner',
      recommendedCourse: { id: 2, nameAr: 'تلاوة القرآن نظرًا', nameEn: 'Quran Reading' },
      classesPerWeek: 3,
      minutesPerClass: 45,
      engagement: 'high',
      notes: null,
      submittedBy: { id: 2, name: 'Ahmed Fathy' },
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const admin = MOCK_USERS.find((u) => u.email === 'admin@qarabic.test')!;
    renderPage(
      <ConvertDialog
        lead={presentDetail(row, admin)}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
      { path: `/leads/${row.id}` },
    );
    const dialog = await screen.findByRole('dialog', { name: 'التحويل إلى منتظم' });
    expect(
      await within(dialog).findByText(/من تقرير المعلم بعد الحصة التجريبية: المستوى مبتدئ/),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByRole('combobox', { name: /^يوم الموعد/ })).toHaveLength(3);
    expect(within(dialog).getByRole('combobox', { name: 'مدة الحصة' })).toHaveTextContent('45');
  });
});

describe('T3/T4 CRM settings', () => {
  it('has the trial settings and saves a change', async () => {
    const user = userEvent.setup();
    renderPage(<CrmSettingsView />, { path: '/settings/crm' });
    const sw = await screen.findByRole('switch', {
      name: 'لا تُغلق الحصة التجريبية إلا بتقرير المعلم',
    });
    expect(screen.getByRole('spinbutton', { name: 'مهلة الرد على العرض (بالدقائق)' })).toHaveValue(
      crmdb.settings['crm.trial_offer_expiry_minutes'],
    );
    const before = crmdb.settings['crm.trial_report_required'];
    await user.click(sw);
    await user.click(screen.getByRole('button', { name: 'احفظ الإعدادات' }));
    await waitFor(() => expect(crmdb.settings['crm.trial_report_required']).toBe(!before));
  });
});
