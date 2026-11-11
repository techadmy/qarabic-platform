import { Injectable } from '@nestjs/common';
import {
  HIFZ_TYPES,
  type HifzCoverageDto,
  type LastPositionDto,
  type ProgressDto,
  type progressQuerySchema,
  QURAN_AYAH_COUNT,
  QURAN_SURAHS,
  rangePieces,
  type SurahDto,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import type { HifzEntry } from '../generated/prisma/client.js';
import { isParentViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { zoneOr } from '../schedule/conflicts.js';
import { assertStaffOrTeacher, studentScopeWhere, viewerScope } from '../schedule/scope.js';
import { addMonths, isoZ, localDate, startOfLocalDay } from '../schedule/time.js';
import { teacherName } from '../sessions/presenter.js';
import { hifzDto, ratingVisible } from '../sessions/lesson-reports.js';
import { SettingsService } from '../settings/settings.service.js';

type Query = z.output<typeof progressQuerySchema>;

/** Last positions per type (one row each). */
export async function lastPositions(
  prisma: PrismaService,
  studentIds: number[],
): Promise<Map<number, LastPositionDto[]>> {
  const rows = await prisma.hifzEntry.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: [{ lessonAt: 'desc' }, { id: 'desc' }],
    distinct: ['studentId', 'type'],
  });
  const out = new Map<number, LastPositionDto[]>();
  for (const id of studentIds) out.set(id, []);
  for (const type of HIFZ_TYPES) {
    for (const e of rows.filter((r) => r.type === type)) {
      out.get(e.studentId)!.push({
        ...hifzDto(e),
        sessionId: e.sessionId,
        date: isoZ(e.lessonAt)!,
      });
    }
  }
  return out;
}

/**
 * What a student has memorised: the union of the reported ranges, an ayah counted once. Every
 * type counts (revising a passage means it was memorised), except rows graded `not_memorised`.
 */
export function coverage(
  entries: Array<Pick<HifzEntry, 'fromSurah' | 'fromAyah' | 'toSurah' | 'toAyah' | 'grade'>>,
): HifzCoverageDto {
  const marks = new Map<number, Uint8Array>();
  for (const e of entries) {
    if (e.grade === 'not_memorised') continue;
    for (const p of rangePieces(
      { surah: e.fromSurah, ayah: e.fromAyah },
      { surah: e.toSurah, ayah: e.toAyah },
    )) {
      const count = QURAN_SURAHS[p.surah - 1]?.ayahCount ?? 0;
      if (!count) continue;
      let bits = marks.get(p.surah);
      if (!bits) marks.set(p.surah, (bits = new Uint8Array(count + 1)));
      for (let a = Math.max(1, p.first); a <= Math.min(count, p.last); a++) bits[a] = 1;
    }
  }
  const surahs = [...marks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, bits]) => {
      const memorised = bits.reduce((n, b) => n + b, 0);
      const ayahCount = QURAN_SURAHS[number - 1]!.ayahCount;
      return { number, memorisedAyahs: memorised, ayahCount, complete: memorised === ayahCount };
    })
    .filter((s) => s.memorisedAyahs > 0);
  const memorisedAyahs = surahs.reduce((n, s) => n + s.memorisedAyahs, 0);
  return {
    memorisedAyahs,
    totalAyahs: QURAN_AYAH_COUNT,
    percent: Math.round((memorisedAyahs / QURAN_AYAH_COUNT) * 1000) / 10,
    completeSurahs: surahs.filter((s) => s.complete).length,
    surahs,
  };
}

/**
 * Student progress (D72, Laravel `ProgressController`), computed from the lesson reports: last
 * positions, the timeline (newest class first), new ayahs per academy month and the coverage.
 * Staff with `families.view`, a teacher their own students, a parent their own children (404
 * outside the scope); parents never get the internal notes.
 */
@Injectable()
export class ProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async surahs(): Promise<SurahDto[]> {
    return this.prisma.quranSurah.findMany({ orderBy: { number: 'asc' } });
  }

  async progress(studentId: number, q: Query, viewer: AuthUser): Promise<ProgressDto> {
    assertStaffOrTeacher(viewer, 'families.view');
    const scope = await viewerScope(this.prisma, viewer);
    const student = await this.prisma.student.findFirst({
      where: { AND: [{ id: studentId }, studentScopeWhere(scope)] },
      include: { family: { select: { timezone: true } } },
    });
    if (!student) throw notFound();
    const st = await this.settings.all();
    const academy = st['academy.timezone'];
    const parent = isParentViewer(viewer);
    const rating = ratingVisible(viewer, st);

    const startsAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lt: new Date(q.to) } : {}),
    };
    const thisMonth = localDate(this.clock.nowMs(), academy).slice(0, 7);
    const firstMonth = addMonths(`${thisMonth}-01`, -11);

    const [reports, last, monthly, all] = await Promise.all([
      this.prisma.lessonReport.findMany({
        where: { studentId, session: { deletedAt: null, startsAt } },
        include: {
          session: {
            select: {
              startsAt: true,
              teacher: { select: { id: true, firstName: true, lastName: true } },
            },
          },
          hifz: {
            ...(q.type ? { where: { type: q.type } } : {}),
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ session: { startsAt: 'desc' } }, { id: 'desc' }],
        take: 200,
      }),
      lastPositions(this.prisma, [studentId]),
      this.prisma.hifzEntry.findMany({
        where: {
          studentId,
          type: 'sabaq',
          lessonAt: { gte: new Date(startOfLocalDay(firstMonth, academy)) },
        },
        select: { lessonAt: true, ayahs: true },
      }),
      this.prisma.hifzEntry.findMany({
        where: { studentId },
        select: { fromSurah: true, fromAyah: true, toSurah: true, toAyah: true, grade: true },
      }),
    ]);

    const byMonth = new Map<string, number>();
    for (const e of monthly) {
      const month = localDate(e.lessonAt.getTime(), academy).slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + e.ayahs);
    }

    return {
      studentId,
      student: {
        id: student.id,
        name: student.name,
        timezone: zoneOr(student.family.timezone, academy),
      },
      lastPositions: last.get(studentId) ?? [],
      timeline: reports.map((r) => ({
        sessionId: r.sessionId,
        reportId: r.id,
        startsAt: isoZ(r.session.startsAt)!,
        teacher: r.session.teacher
          ? { id: r.session.teacher.id, name: teacherName(r.session.teacher) }
          : null,
        summary: r.summary,
        homework: r.homework,
        tajweedNotes: r.tajweedNotes,
        ...(parent ? {} : { teacherNotes: r.teacherNotes }),
        ...(rating ? { rating: r.rating } : {}),
        submittedAt: isoZ(r.submittedAt)!,
        late: r.submittedLate,
        hifz: r.hifz.map(hifzDto),
      })),
      monthlyAyahs: [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, ayahs]) => ({ month, ayahs })),
      coverage: coverage(all),
    };
  }
}
