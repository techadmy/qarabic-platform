import { describe, expect, it } from 'vitest';
import { local, toUtc } from '../schedule/time.js';
import { SUPPORT_SETTING_DEFAULTS } from './settings-defaults.js';
import { SlaClock } from './sla.js';

/* Port of the SLA cases of Laravel tests/Feature/Feedback/SupportS2Test.php. */

const hours = SUPPORT_SETTING_DEFAULTS['support.working_hours'];
const cairo = (date: string, time: string) => toUtc(date, time, 'Africa/Cairo');
const show = (ms: number) => {
  const l = local(ms, 'Africa/Cairo');
  return `${l.date} ${l.time}`;
};

describe('SlaClock', () => {
  it('counts SLA in working hours, Saturday to Thursday 10:00–22:00 Cairo', () => {
    // Tuesday 12:00 + 4 h = Tuesday 16:00.
    expect(show(SlaClock.addWorkingMinutes(cairo('2026-11-10', '12:00'), 240, hours))).toBe(
      '2026-11-10 16:00',
    );
    // Thursday 21:00 + 4 h: 1 h Thursday, Friday off, 3 h Saturday → Saturday 13:00.
    expect(show(SlaClock.addWorkingMinutes(cairo('2026-11-12', '21:00'), 240, hours))).toBe(
      '2026-11-14 13:00',
    );
    // Before opening: Saturday 07:00 + 4 h = Saturday 14:00.
    expect(show(SlaClock.addWorkingMinutes(cairo('2026-11-14', '07:00'), 240, hours))).toBe(
      '2026-11-14 14:00',
    );
    // Friday evening + 12 h (one working day) = Saturday 22:00.
    expect(show(SlaClock.addWorkingMinutes(cairo('2026-11-13', '20:00'), 720, hours))).toBe(
      '2026-11-14 22:00',
    );
  });

  it('uses plain clock time without working days', () => {
    const from = Date.UTC(2026, 10, 13, 20, 0);
    expect(SlaClock.addWorkingMinutes(from, 90, { ...hours, days: [] })).toBe(from + 90 * 60_000);
  });

  it('supports a day that ends at 24:00', () => {
    const allDay = { timezone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00' };
    const from = Date.UTC(2026, 10, 10, 23, 0);
    expect(SlaClock.addWorkingMinutes(from, 120, allDay)).toBe(from + 120 * 60_000);
  });

  it('caps the deadline at the class start when it is sooner', () => {
    const cfg = { slaHours: { scheduling: 4 }, workingHours: hours };
    const from = cairo('2026-11-10', '12:00');
    const soon = from + 2 * 3_600_000;
    expect(SlaClock.dueFor('scheduling', from, cfg, soon)).toBe(soon);
    expect(SlaClock.dueFor('scheduling', from, cfg, from + 48 * 3_600_000)).toBe(
      cairo('2026-11-10', '16:00'),
    );
    // A class in the past never caps it.
    expect(SlaClock.dueFor('scheduling', from, cfg, from - 1)).toBe(cairo('2026-11-10', '16:00'));
  });

  it('reports ok, due soon, breached, met and none', () => {
    const due = new Date('2026-11-10T14:00:00Z');
    const at = (iso: string) => Date.parse(iso);
    expect(SlaClock.state(due, null, true, at('2026-11-10T12:00:00Z'))).toBe('ok');
    expect(SlaClock.state(due, null, true, at('2026-11-10T13:30:00Z'))).toBe('due_soon');
    expect(SlaClock.state(due, null, true, at('2026-11-10T14:01:00Z'))).toBe('breached');
    expect(SlaClock.state(due, new Date(), true, at('2026-11-10T15:00:00Z'))).toBe('met');
    expect(SlaClock.state(due, null, false, at('2026-11-10T15:00:00Z'))).toBe('none');
    expect(SlaClock.state(null, null, true, at('2026-11-10T15:00:00Z'))).toBe('none');
  });
});
