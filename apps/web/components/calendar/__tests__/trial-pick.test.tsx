import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { CalendarView } from '@/components/calendar/calendar-view';
import { TrialPickDialog, trialModeOf } from '@/components/calendar/trial-pick';
import { zonedInstant } from '@/lib/schedule-time';
import { crmdb } from '@/mocks/crm-db';
import { server } from '@/mocks/node';
import { offersForTests } from '@/mocks/trial-offers';
import { renderPage } from '@/test/people';

const LEAD = 6; // has a family and a child; course 2 is taught by teachers 1, 4 and 7

function trial() {
  const lead = crmdb.leads.find((l) => l.id === LEAD)!;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: lead.timezone }).format(
    new Date(Date.now() + 7 * 86_400_000),
  );
  return {
    mode: { leadId: LEAD, studentId: lead.students[0]!.id, courseId: 2, minutes: 30 },
    at: new Date(zonedInstant(day, '19:00', lead.timezone)),
    tz: lead.timezone,
    day,
  };
}

describe('C3: picking a trial teacher on the calendar (docs/42 §3)', () => {
  it('reads the trial from the URL', () => {
    const get = (k: string) =>
      ({ trialLead: '6', trialStudent: '9', trialCourse: '2', trialMinutes: '45' })[k] ?? null;
    expect(trialModeOf(get)).toEqual({ leadId: 6, studentId: 9, courseId: 2, minutes: 45 });
    expect(trialModeOf(() => null)).toBeNull();
  });

  it('the teachers view keeps only the teachers who can take the trial, and says why it is open', async () => {
    const { mode, day } = trial();
    renderPage(<CalendarView />, {
      path: `/schedule?view=teachers&date=${day}&trialLead=${mode.leadId}&trialStudent=${mode.studentId}&trialCourse=2&trialMinutes=30`,
    });
    expect(await screen.findByText(/اختيار معلم للحصة التجريبية/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'العودة إلى العميل المحتمل' })).toHaveAttribute(
      'href',
      `/leads/${LEAD}`,
    );
  });

  it('a time on the calendar checks the teachers then sends the offer to the one chosen', async () => {
    const user = userEvent.setup();
    const { mode, at } = trial();
    renderPage(
      // Shown in Cairo time: the family's own time is added (D30).
      <TrialPickDialog mode={mode} at={at} tz="Africa/Cairo" teacherId={null} onClose={() => {}} />,
      { path: '/schedule' },
    );
    const dialog = await screen.findByRole('dialog', { name: 'إرسال الحصة التجريبية إلى معلم' });
    expect(
      await within(dialog).findByText('اختر معلمًا من المناسبين في هذا الوقت.'),
    ).toBeInTheDocument();
    const others = within(dialog).getByText('معلمون مناسبون آخرون في هذا الوقت').parentElement!;
    await user.click(within(others).getAllByRole('button')[0]!);
    // Suitable; the badge also says when the time is outside their working hours.
    expect(within(dialog).getByText(/^مناسب/)).toBeInTheDocument();
    expect(within(dialog).getByText(/بتوقيت العائلة:/)).toBeInTheDocument();
    // The student already has an open offer (mock seed): the API's refusal is said.
    await user.click(within(dialog).getByRole('button', { name: 'أرسل العرض' }));
    expect(await within(dialog).findByText(/للطالب عرض مفتوح بالفعل/)).toBeInTheDocument();
    offersForTests().splice(0);
    await user.click(within(dialog).getByRole('button', { name: 'أرسل العرض' }));
    expect(await screen.findByText(/أُرسل عرض الحصة التجريبية إلى/)).toBeInTheDocument();
    expect(offersForTests()).toHaveLength(1);
  });

  it('no suitable teacher, or a failed load, is said (not an empty grid)', async () => {
    const { mode, day } = trial();
    const path = `/schedule?view=teachers&date=${day}&trialLead=${mode.leadId}&trialStudent=${mode.studentId}&trialCourse=2`;
    server.use(
      http.get('*/api/v1/leads/:id/trial-teachers', () =>
        HttpResponse.json({
          data: { eligible: [], ineligible: [] },
          meta: {
            startsAt: new Date().toISOString(),
            durationMinutes: 30,
            familyZone: 'UTC',
            adult: null,
            teacherGenderPref: null,
          },
        }),
      ),
    );
    const { unmount } = renderPage(<CalendarView />, { path });
    expect(await screen.findByText(/لا يوجد معلمون مناسبون لهذه الحصة/)).toBeInTheDocument();
    unmount();
    server.use(
      http.get('*/api/v1/leads/:id/trial-teachers', () => HttpResponse.json({}, { status: 500 })),
    );
    renderPage(<CalendarView />, { path });
    expect(await screen.findByText('تعذّر تحميل المعلمين المناسبين.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'أعد المحاولة' })).toBeInTheDocument();
  });
});
