import { SLA_DUE_SOON_MINUTES, type SlaState, type TicketQueue } from '@qarabic/shared';
import {
  addDays,
  isoWeekday,
  local,
  minuteOf,
  MINUTE,
  startOfLocalDay,
  timeOfMinute,
  toUtc,
} from '../schedule/time.js';

export interface WorkingHours {
  timezone: string;
  /** ISO weekdays (1 = Monday … 7 = Sunday). Empty = plain clock time. */
  days: number[];
  start: string;
  /** `24:00` = midnight at the end of the day. */
  end: string;
}

/**
 * SLA deadlines in working hours (docs/32 §5, B76/D135), port of Laravel `SlaClock`: the working
 * week (`support.working_hours`, Saturday–Thursday 10:00–22:00 Cairo by default) and a per-queue
 * target in hours (`support.sla_hours`). Class-time items are due by the class start when that is
 * sooner. Pure functions over epoch milliseconds: callers pass the app `Clock`'s now.
 */
export const SlaClock = {
  /** `fromMs` plus `minutes` of working time. Without working days configured, clock time. */
  addWorkingMinutes(fromMs: number, minutes: number, hours: WorkingHours): number {
    const start = minuteOf(hours.start);
    const end = hours.end === '24:00' ? 24 * 60 : minuteOf(hours.end);
    if (!hours.days.length || minutes <= 0 || end <= start) {
      return fromMs + Math.max(0, minutes) * MINUTE;
    }
    let remaining = minutes;
    let cursor = fromMs;
    for (let guard = 0; guard < 800; guard++) {
      const { date } = local(cursor, hours.timezone);
      const dayStart = toUtc(date, timeOfMinute(start), hours.timezone);
      const dayEnd =
        end >= 24 * 60
          ? startOfLocalDay(addDays(date, 1), hours.timezone)
          : toUtc(date, timeOfMinute(end), hours.timezone);
      if (hours.days.includes(isoWeekday(date)) && cursor < dayEnd) {
        const windowStart = Math.max(cursor, dayStart);
        const available = Math.floor((dayEnd - windowStart) / MINUTE);
        if (remaining <= available) return windowStart + remaining * MINUTE;
        remaining -= available;
      }
      cursor = startOfLocalDay(addDays(date, 1), hours.timezone);
    }
    return cursor;
  },

  /** Deadline of an item of `queue` received at `fromMs`, capped by the class start when sooner. */
  dueFor(
    queue: TicketQueue,
    fromMs: number,
    config: { slaHours: Partial<Record<TicketQueue, number>>; workingHours: WorkingHours },
    classStartsAtMs: number | null = null,
  ): number {
    const hours = config.slaHours[queue] ?? 12;
    const due = SlaClock.addWorkingMinutes(fromMs, Math.round(hours * 60), config.workingHours);
    if (classStartsAtMs !== null && classStartsAtMs > fromMs && classStartsAtMs < due) {
      return classStartsAtMs;
    }
    return due;
  },

  /** ok | due_soon | breached | met | none (`met` once answered; `none` without a deadline or closed). */
  state(due: Date | null, respondedAt: Date | null, open: boolean, nowMs: number): SlaState {
    if (respondedAt) return 'met';
    if (!due || !open) return 'none';
    const dueMs = due.getTime();
    if (nowMs > dueMs) return 'breached';
    return dueMs - nowMs <= SLA_DUE_SOON_MINUTES * MINUTE ? 'due_soon' : 'ok';
  },
};
