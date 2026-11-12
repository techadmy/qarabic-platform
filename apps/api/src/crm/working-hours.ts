import {
  addDays,
  isValidZone,
  local,
  MINUTE,
  minuteOf,
  timeOfMinute,
  toUtc,
} from '../schedule/time.js';
import type { SettingsMap } from '../settings/settings.service.js';

/**
 * The CRM working day (B84, D136): first-response minutes count only between
 * `crm.working_hours_start` and `crm.working_hours_end` in `crm.working_hours_timezone`
 * (default 10:00–22:00 Africa/Cairo). An end not after the start means "all day".
 * Port of Laravel `WorkingHours`.
 */
export class WorkingHours {
  constructor(
    private readonly zone: string,
    private readonly startMinute: number,
    private readonly endMinute: number,
  ) {}

  static fromSettings(s: SettingsMap): WorkingHours {
    const zone = s['crm.working_hours_timezone'];
    return new WorkingHours(
      isValidZone(zone) ? zone : s['academy.timezone'],
      minuteOfDay(s['crm.working_hours_start'], 0),
      minuteOfDay(s['crm.working_hours_end'], 1440),
    );
  }

  isAllDay(): boolean {
    return this.endMinute <= this.startMinute;
  }

  contains(ms: number): boolean {
    if (this.isAllDay()) return true;
    const minute = minuteOf(local(ms, this.zone).time);
    return minute >= this.startMinute && minute < this.endMinute;
  }

  /** The instant (ms) that is `minutes` working minutes after `from`. */
  addWorkingMinutes(from: number, minutes: number): number {
    if (this.isAllDay()) return from + minutes * MINUTE;
    let remaining = Math.max(0, minutes) * MINUTE;
    let cursor = from;
    // A safety bound: never loop more than a few weeks.
    for (let i = 0; i < 60; i++) {
      const date = local(cursor, this.zone).date;
      const dayStart = this.at(date, this.startMinute);
      const dayEnd = this.at(date, this.endMinute);
      if (cursor < dayStart) cursor = dayStart;
      if (cursor >= dayEnd) {
        cursor = this.at(addDays(date, 1), this.startMinute);
        continue;
      }
      const available = dayEnd - cursor;
      if (remaining <= available) return cursor + remaining;
      remaining -= available;
      cursor = this.at(addDays(date, 1), this.startMinute);
    }
    return cursor;
  }

  /** When a lead created at `createdAt` breaches the first-response SLA. */
  static firstResponseDue(createdAt: number, s: SettingsMap): number {
    return WorkingHours.fromSettings(s).addWorkingMinutes(
      createdAt,
      Math.max(1, s['crm.first_response_minutes']),
    );
  }

  private at(date: string, minute: number): number {
    if (minute >= 1440) return toUtc(addDays(date, 1), '00:00', this.zone);
    return toUtc(date, timeOfMinute(minute), this.zone);
  }
}

function minuteOfDay(hhmm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return fallback;
  return Math.min(1440, Number(m[1]) * 60 + Number(m[2]));
}
