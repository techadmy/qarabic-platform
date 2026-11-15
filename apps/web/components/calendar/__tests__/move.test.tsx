import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RescheduleDialog } from '@/components/sessions/reschedule-dialog';
import { fetchCalendarEvents } from '@/lib/api/calendar';
import { viewRange } from '@/lib/calendar/view';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { mockSignIn } from '@/mocks/handlers';
import { sdb } from '@/mocks/schedule-db';
import { renderPage } from '@/test/people';

/** A future weekly class from the mock calendar (C1 contract). */
async function weeklyEvent() {
  mockSignIn('admin@qarabic.test');
  const week = addDays(dateKeyIn('Africa/Cairo'), 1);
  const { events } = await fetchCalendarEvents(viewRange('week', week, 'Africa/Cairo'));
  const e = events.find(
    (x) => x.slotId && x.stage === 'scheduled' && Date.parse(x.startsAt) > Date.now() + 3_600_000,
  );
  if (!e) throw new Error('no weekly class in the mock week');
  return e;
}

describe('calendar move (C2, docs/42 §3.4)', () => {
  it('a weekly class asks «هذه الحصة فقط» or «والتالية», needs a reason, then moves the series', async () => {
    const user = userEvent.setup();
    const e = await weeklyEvent();
    const later = new Date(Date.parse(e.startsAt) + 60 * 60_000).toISOString();
    renderPage(
      <RescheduleDialog
        session={e}
        open
        onOpenChange={() => {}}
        initial={{ startsAt: later, durationMinutes: e.durationMinutes }}
        zone="Africa/Cairo"
        requireReason
      />,
    );
    const dialog = await screen.findByRole('dialog');
    const following = within(dialog).getByRole('radio', { name: 'هذه الحصة والحصص التالية' });
    expect(within(dialog).getByRole('radio', { name: 'هذه الحصة فقط' })).toBeChecked();
    await user.click(following);
    const save = within(dialog).getByRole('button', { name: 'احفظ الموعد' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    expect(within(dialog).getByText(/اكتب سبب النقل/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /السبب/ }), 'طلب ولي الأمر');
    await user.click(save);
    expect(await screen.findByText(/نُقلت حصص .* من هذه الحصة/)).toBeInTheDocument();
    const slot = sdb.slots.find((s) => s.id === e.slotId)!;
    expect(slot.validTo).not.toBeNull();
    expect(sdb.sessions.find((s) => s.id === e.id)!.scheduleSlotId).not.toBe(e.slotId);
  });
});
