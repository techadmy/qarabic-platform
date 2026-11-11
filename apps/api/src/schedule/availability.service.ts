import { Injectable } from '@nestjs/common';
import type { AvailabilityDto, availabilityQuerySchema } from '@qarabic/shared';
import type { z } from 'zod';
import { Clock } from '../common/clock.js';
import { invalid } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { validBetween, zoneOr } from './conflicts.js';
import { LIVE_ENROLLMENT } from './scope.js';
import {
  addDays,
  addMonths,
  fromDbDate,
  isoWeekday,
  localDate,
  minuteOf,
  offsetMinutes,
  timeOfMinute,
  toUtc,
  transitions,
} from './time.js';

const WEEK = 10_080;
type Span = [number, number];
type Query = z.output<typeof availabilityQuerySchema>;

interface Segment {
  from: string;
  to: string;
  offsets: Map<string, number>;
}

interface Weekly {
  weekday: number;
  time: string;
  minutes: number;
  zone: string;
  validFrom: string | null;
  validTo: string | null;
}

const OCCUPYING = [
  'scheduled',
  'activated',
  'in_progress',
  'ended',
  'taken',
  'absent',
  'declined',
] as const;

/**
 * Teacher availability in the student's time zone (docs/14 §5.5), port of Laravel
 * `AvailabilitySearch`. Exact over DST: between two DST transitions of all the zones involved the
 * UTC offsets are constant, so every weekly item becomes a fixed interval in "minutes of the UTC
 * week" per segment, and checks are integer comparisons modulo one week.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async search(q: Query): Promise<AvailabilityDto> {
    const st = await this.settings.all();
    const academy = st['academy.timezone'];
    let zone = q.timezone;
    if (q.studentId) {
      const student = await this.prisma.student.findUnique({
        where: { id: q.studentId },
        include: { family: { select: { timezone: true } } },
      });
      if (!student) throw invalid('studentId');
      zone ??= zoneOr(student.family.timezone, academy);
    }
    return this.run({ ...q, timezone: zone! }, st['sessions.teacher_buffer_min'], academy, true);
  }

  private async run(
    q: Query & { timezone: string },
    buffer: number,
    academy: string,
    allowNearest: boolean,
  ): Promise<AvailabilityDto> {
    const zone = q.timezone;
    const now = this.clock.nowMs();
    const from = q.effectiveFrom ?? nextMonday(localDate(now, zone));
    const until = addMonths(from, 12);
    const step = q.stepMinutes ?? 30;
    const minutes = q.durationMinutes;

    const teachers = (
      await this.prisma.teacher.findMany({
        where: {
          status: 'active',
          archivedAt: null,
          ...(q.courseId ? { courses: { some: { courseId: q.courseId } } } : {}),
          ...(q.gender ? { gender: q.gender } : {}),
          ...(q.teacherIds?.length ? { id: { in: q.teacherIds } } : {}),
        },
        orderBy: { id: 'asc' },
      })
    ).filter((t) => !q.teacherTimezone || zoneOr(t.timezone, academy) === q.teacherTimezone);
    const ids = teachers.map((t) => t.id);
    const fromUtc = new Date(toUtc(from, '00:00', zone));

    const [slots, blocks, hours, oneOffs, studentSlots, studentOneOffs] = await Promise.all([
      this.prisma.scheduleSlot.findMany({
        where: {
          teacherId: { in: ids },
          enrollment: LIVE_ENROLLMENT,
          ...validBetween(from, until),
        },
      }),
      this.prisma.teacherBlock.findMany({
        where: {
          teacherId: { in: ids },
          OR: [{ kind: 'recurring' }, { endsAt: { gt: new Date(now) } }],
        },
      }),
      this.prisma.teacherWorkHour.findMany({ where: { teacherId: { in: ids } } }),
      this.prisma.classSession.findMany({
        where: {
          teacherId: { in: ids },
          stage: { in: [...OCCUPYING] },
          deletedAt: null,
          scheduleSlotId: null,
          startsAt: { gte: fromUtc },
        },
        select: { teacherId: true, startsAt: true, endsAt: true },
      }),
      q.studentId
        ? this.prisma.scheduleSlot.findMany({
            where: {
              enrollment: { ...LIVE_ENROLLMENT, studentId: q.studentId },
              ...validBetween(from, until),
            },
          })
        : Promise.resolve([]),
      q.studentId
        ? this.prisma.classSession.findMany({
            where: {
              studentId: q.studentId,
              stage: { in: [...OCCUPYING] },
              deletedAt: null,
              scheduleSlotId: null,
              startsAt: { gte: fromUtc },
            },
            select: { startsAt: true, endsAt: true },
          })
        : Promise.resolve([]),
    ]);

    const teacherZones = new Map(teachers.map((t) => [t.id, zoneOr(t.timezone, academy)]));
    const slotWeekly = (s: (typeof slots)[number]): Weekly => ({
      weekday: s.weekday,
      time: s.localStartTime,
      minutes: s.durationMinutes,
      zone: s.timezone,
      validFrom: fromDbDate(s.validFrom),
      validTo: s.validTo ? fromDbDate(s.validTo) : null,
    });
    const zones = [
      ...new Set([
        zone,
        ...teacherZones.values(),
        ...slots.map((s) => s.timezone),
        ...studentSlots.map((s) => s.timezone),
        ...blocks.map((b) => zoneOr(b.timezone, academy)),
        ...hours.map((h) => zoneOr(h.timezone, academy)),
      ]),
    ];
    const segments = this.segments(zones, from, until, zone);

    // candidates (student-local weekday + minute)
    const candidates: Array<{ weekday: number; minute: number }> = [];
    for (const wd of q.weekdays) {
      for (let t = minuteOf(q.fromTime); t + minutes <= minuteOf(q.toTime); t += step) {
        candidates.push({ weekday: wd, minute: t });
      }
    }

    const studentBusy = segments.map((seg) => [
      ...weeklyBusy(studentSlots.map(slotWeekly), seg),
      ...oneOffBusy(studentOneOffs, seg),
    ]);

    const result: Array<AvailabilityDto['teachers'][number] & { inHours: number }> = [];
    const notSet: AvailabilityDto['workHoursNotSet'] = [];
    for (const teacher of teachers) {
      const tz = teacherZones.get(teacher.id)!;
      const tSlots = slots.filter((s) => s.teacherId === teacher.id);
      const tBlocks = blocks.filter((b) => b.teacherId === teacher.id);
      const tHours = hours.filter((h) => h.teacherId === teacher.id);
      const busy = segments.map((seg) => [
        ...weeklyBusy(tSlots.map(slotWeekly), seg),
        ...weeklyBusy(
          tBlocks
            .filter((b) => b.kind === 'recurring')
            .map((b) => ({
              weekday: b.weekday ?? 1,
              time: b.localStartTime ?? '00:00',
              minutes: b.durationMinutes ?? 0,
              zone: zoneOr(b.timezone, academy),
              validFrom: b.validFrom ? fromDbDate(b.validFrom) : null,
              validTo: b.validTo ? fromDbDate(b.validTo) : null,
            })),
          seg,
        ),
        ...oneOffBusy(
          oneOffs.filter((o) => o.teacherId === teacher.id),
          seg,
        ),
        ...oneOffBusy(
          tBlocks
            .filter((b) => b.kind === 'one_off' && b.startsAt && b.endsAt)
            .map((b) => ({ startsAt: b.startsAt!, endsAt: b.endsAt! })),
          seg,
        ),
      ]);
      const work = segments.map((seg) =>
        weeklyBusy(
          tHours.map((h) => ({
            weekday: h.weekday,
            time: h.localStartTime,
            minutes: span(h.localStartTime, h.localEndTime),
            zone: zoneOr(h.timezone, academy),
            validFrom: null,
            validTo: null,
          })),
          seg,
        ),
      );
      const name = [teacher.firstName, teacher.lastName].filter(Boolean).join(' ');
      const hasHours = tHours.length > 0;
      if (!hasHours) notSet.push({ id: teacher.id, name, timezone: tz });

      const free: AvailabilityDto['teachers'][number]['free'] = [];
      for (const c of candidates) {
        let ok = true;
        let inHours = false;
        const teacherTimes = new Map<string, { weekday: number; time: string }>();
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]!;
          const start = toUtcWeekMinute(c.weekday, c.minute, seg.offsets.get(zone)!);
          const iv: Span = [start, start + minutes];
          if (hits(iv, busy[i]!, buffer) || hits(iv, studentBusy[i]!, 0)) {
            ok = false;
            break;
          }
          const l = fromUtcWeekMinute(start, seg.offsets.get(tz)!);
          teacherTimes.set(`${l.weekday} ${l.time}`, l);
          if (i === 0) inHours = inside(iv, work[i]!);
        }
        if (!ok) continue;
        const times = [...teacherTimes.values()];
        free.push({
          weekday: c.weekday,
          localStartTime: timeOfMinute(c.minute),
          teacherLocal: times[0]!,
          inWorkHours: hasHours && inHours,
          dstNote: times.length > 1 ? times.map((t) => t.time).join(' / ') : null,
        });
      }

      const load = tSlots
        .filter((s) => fromDbDate(s.validFrom) <= from)
        .reduce((sum, s) => sum + s.durationMinutes, 0);
      result.push({
        teacher: {
          id: teacher.id,
          name,
          timezone: tz,
          gender: teacher.gender,
          weeklyLoadHours: Math.round((load / 60) * 100) / 100,
        },
        matchingWeekdays: new Set(free.map((f) => f.weekday)).size,
        free,
        inHours: free.filter((f) => f.inWorkHours).length,
      });
    }

    const ranked = result
      .filter((r) => r.free.length > 0)
      .sort(
        (a, b) =>
          Number(b.inHours > 0) - Number(a.inHours > 0) ||
          a.teacher.weeklyLoadHours - b.teacher.weeklyLoadHours ||
          b.matchingWeekdays - a.matchingWeekdays,
      )
      .map(({ inHours: _inHours, ...rest }) => rest);

    let nearest: AvailabilityDto['nearest'] = null;
    if (allowNearest && !ranked.length && (q.fromTime !== '00:00' || q.toTime !== '23:59')) {
      const wide = await this.run(
        { ...q, fromTime: '00:00', toTime: '23:59' },
        buffer,
        academy,
        false,
      );
      const target = minuteOf(q.fromTime);
      const hit = wide.teachers
        .flatMap((t) => t.free.map((f) => ({ ...f, teacherId: t.teacher.id })))
        .sort((a, b) => {
          const ma = minuteOf(a.localStartTime);
          const mb = minuteOf(b.localStartTime);
          return (
            Math.abs(ma - target) - Math.abs(mb - target) ||
            Number(ma < target) - Number(mb < target) ||
            a.weekday - b.weekday
          );
        })[0];
      nearest = hit
        ? { weekday: hit.weekday, localStartTime: hit.localStartTime, teacherId: hit.teacherId }
        : null;
    }

    return { timezone: zone, teachers: ranked, workHoursNotSet: notSet, nearest };
  }

  /** Constant-offset segments between the DST transitions of all zones, from the first date. */
  private segments(zones: string[], from: string, until: string, zone: string): Segment[] {
    const start = toUtc(from, '00:00', zone);
    const end = toUtc(until, '00:00', zone);
    const bounds = [start, ...transitions(zones, start, end), end];
    const out: Segment[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const mid = bounds[i]! + 60_000;
      out.push({
        from: localDate(bounds[i]!, 'UTC'),
        to: localDate(bounds[i + 1]!, 'UTC'),
        offsets: new Map(zones.map((z) => [z, offsetMinutes(z, mid)])),
      });
    }
    return out;
  }
}

function nextMonday(date: string): string {
  const wd = isoWeekday(date);
  return addDays(date, wd === 1 ? 7 : 8 - wd);
}

/** Weekly items valid in the segment, in UTC week minutes. */
function weeklyBusy(items: Weekly[], seg: Segment): Span[] {
  const out: Span[] = [];
  for (const it of items) {
    if ((it.validFrom && it.validFrom > seg.to) || (it.validTo && it.validTo < seg.from)) continue;
    const offset =
      seg.offsets.get(it.zone) ?? offsetMinutes(it.zone, toUtc(seg.from, '12:00', 'UTC'));
    const start = toUtcWeekMinute(it.weekday, minuteOf(it.time), offset);
    out.push([start, start + it.minutes]);
  }
  return out;
}

/** Single dated items falling in the segment. */
function oneOffBusy(items: Array<{ startsAt: Date; endsAt: Date }>, seg: Segment): Span[] {
  const out: Span[] = [];
  for (const it of items) {
    const ms = it.startsAt.getTime();
    const date = localDate(ms, 'UTC');
    if (date < seg.from || date > seg.to) continue;
    const d = new Date(ms);
    const start = (isoWeekday(date) - 1) * 1440 + d.getUTCHours() * 60 + d.getUTCMinutes();
    out.push([start, start + Math.round((it.endsAt.getTime() - ms) / 60_000)]);
  }
  return out;
}

function hits(iv: Span, busy: Span[], buffer: number): boolean {
  for (const [s, e] of busy) {
    for (const shift of [-WEEK, 0, WEEK]) {
      if (iv[0] < e + shift + buffer && s + shift < iv[1] + buffer) return true;
    }
  }
  return false;
}

function inside(iv: Span, windows: Span[]): boolean {
  for (const [s, e] of windows) {
    for (const shift of [-WEEK, 0, WEEK]) {
      if (s + shift <= iv[0] && iv[1] <= e + shift) return true;
    }
  }
  return false;
}

function toUtcWeekMinute(weekday: number, minute: number, offset: number): number {
  return ((((weekday - 1) * 1440 + minute - offset) % WEEK) + WEEK) % WEEK;
}

function fromUtcWeekMinute(utc: number, offset: number): { weekday: number; time: string } {
  const l = (((utc + offset) % WEEK) + WEEK) % WEEK;
  return { weekday: Math.floor(l / 1440) + 1, time: timeOfMinute(l % 1440) };
}

function span(start: string, end: string): number {
  const d = minuteOf(end) - minuteOf(start);
  return d > 0 ? d : d + 1440;
}
