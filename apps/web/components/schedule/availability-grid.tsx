'use client';

import { EventCalendar } from '@qarabic/ui/components/reui/event-calendar/event-calendar';
import { EventCalendarContent } from '@qarabic/ui/components/reui/event-calendar/event-calendar-content';
import { EventCalendarWeekView } from '@qarabic/ui/components/reui/event-calendar/event-calendar-time-grid';
import type { CalendarEvent } from '@qarabic/ui/components/reui/event-calendar/event-calendar-types';
import { TooltipProvider } from '@qarabic/ui/components/tooltip';
import { ar, enUS } from '@qarabic/ui/lib/date-locales';
import { useTranslations } from 'next-intl';
import { useUiLocale } from '@/components/sessions/times';
import {
  addDays,
  dateKeyIn,
  hhmmIn,
  isoWeekday,
  weekdayName,
  zonedInstant,
} from '@/lib/schedule-time';

export type HourRow = { weekday: number; localStartTime: string; localEndTime: string };

/** A fixed Saturday-first reference week: the grid shows weekdays, never dates. */
const REF_SATURDAY = '2026-01-03';
const dayOf = (weekday: number) => addDays(REF_SATURDAY, (weekday + 1) % 7);
const snap = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String(h).padStart(2, '0')}:${String((Math.round((m ?? 0) / 15) * 15) % 60).padStart(2, '0')}`;
};

const WeekView = () => <EventCalendarWeekView showAllDay={false} />;

/**
 * Paint the weekly working hours (A1, docs/42 §4): a week grid in the teacher's zone (ReUI week
 * view over a reference week, weekday names only). Drag on empty time to add hours, drag or
 * stretch a block to change it, click a block to remove it. The same rows are listed in the form
 * beside it, which stays the keyboard way to edit them.
 */
export function AvailabilityGrid({
  rows,
  onChange,
  timezone,
  editable,
}: {
  rows: HourRow[];
  onChange: (rows: HourRow[]) => void;
  timezone: string;
  editable: boolean;
}) {
  const t = useTranslations('timetable.grid');
  const locale = useUiLocale();
  const events: CalendarEvent<number>[] = rows.map((r, i) => {
    const day = dayOf(r.weekday);
    const overnight = r.localEndTime <= r.localStartTime;
    return {
      id: String(i),
      title: t('available'),
      start: new Date(zonedInstant(day, r.localStartTime, timezone)),
      // Hours past midnight are drawn up to the end of the day (the form keeps the real end).
      end: new Date(
        zonedInstant(
          overnight ? addDays(day, 1) : day,
          overnight ? '00:00' : r.localEndTime,
          timezone,
        ),
      ),
      color: 'var(--status-green-emphasis)',
      readOnly: !editable,
      data: i,
    };
  });
  const toRow = (start: Date, end: Date): HourRow => {
    const startKey = dateKeyIn(timezone, start);
    return {
      weekday: isoWeekday(startKey),
      localStartTime: snap(hhmmIn(start.toISOString(), timezone)),
      localEndTime: snap(hhmmIn(end.toISOString(), timezone)),
    };
  };

  return (
    <TooltipProvider>
      <div className="h-[28rem] overflow-hidden rounded-lg border bg-card">
        <EventCalendar<number>
          className="h-full"
          events={events}
          view="week"
          date={new Date(zonedInstant(REF_SATURDAY, '12:00', timezone))}
          views={['week']}
          timeZone={timezone}
          locale={locale === 'ar' ? ar : enUS}
          weekStartsOn={6}
          scrollToHour={12}
          slotDuration={60}
          snapDuration={15}
          nowIndicator={false}
          interactions={{ drag: editable, resize: editable, selectSlot: editable }}
          renderDayHeader={({ day }) => (
            <span className="text-sm font-semibold">
              {weekdayName(isoWeekday(dateKeyIn(timezone, day)), locale)}
            </span>
          )}
          i18n={{ labels: { noEvents: t('empty') } }}
          onSelectSlot={(slot) => {
            if (!editable || slot.allDay) return;
            onChange([...rows, toRow(slot.start, slot.end)]);
          }}
          onEventUpdate={(u) => {
            const i = u.event.data;
            if (i === undefined) return false;
            onChange(rows.map((r, j) => (j === i ? toRow(u.start, u.end) : r)));
            return false;
          }}
          onEventClick={(o) => {
            const i = o.event.data;
            if (!editable || i === undefined) return;
            onChange(rows.filter((_, j) => j !== i));
          }}
        >
          <EventCalendarContent components={{ week: WeekView }} />
        </EventCalendar>
      </div>
      <p className="text-sm text-muted-foreground">{editable ? t('hint') : t('readOnly')}</p>
    </TooltipProvider>
  );
}
