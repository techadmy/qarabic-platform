import { HttpStatus, Injectable } from '@nestjs/common';
import {
  allowedMistakes,
  type createTestSchema,
  needsHifz,
  needsReading,
  orderedSections,
  overallScore,
  type Paginated,
  recordTestResultSchema,
  tajweedScore,
  TEST_ERROR_MESSAGES,
  TEST_RECORD_LEAD_MINUTES,
  TEST_STATUSES,
  type TestDto,
  type TestErrorCode,
  type testListQuerySchema,
  type TestStatus,
  type TestSummaryDto,
  type updateTestSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound, validationError } from '../common/errors.js';
import { pageMeta, statusCounts } from '../common/pagination.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { Prisma, type StudentTest } from '../generated/prisma/client.js';
import { isParentViewer, isTeacherViewer, lockRow, type Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { zoneOr } from '../schedule/conflicts.js';
import { forbidden, LIVE_ENROLLMENT, studentScopeWhere, viewerScope } from '../schedule/scope.js';
import {
  addDays,
  addMonths,
  DAY,
  HOUR,
  isoZ,
  localDate,
  MINUTE,
  startOfLocalDay,
} from '../schedule/time.js';
import { teacherName } from '../sessions/presenter.js';
import { SettingsService, type SettingsMap } from '../settings/settings.service.js';

type CreateInput = z.output<typeof createTestSchema>;
type UpdateInput = z.output<typeof updateTestSchema>;
type ListQuery = z.output<typeof testListQuerySchema>;

export const testInclude = {
  student: { select: { id: true, name: true, family: { select: { timezone: true } } } },
  teacher: { select: { id: true, firstName: true, lastName: true, timezone: true } },
  course: { select: { id: true, nameAr: true, nameEn: true } },
} satisfies Prisma.StudentTestInclude;

export type TestRow = Prisma.StudentTestGetPayload<{ include: typeof testInclude }>;

export type TestAbility = 'view' | 'update' | 'record' | 'refuse' | 'cancel' | 'reopen';

/** A test refusal with its message (Laravel `TestError`, `lang/en/tests.php`). */
export function testError(
  status: HttpStatus,
  code: TestErrorCode,
  errors?: Record<string, string[]>,
): ApiException {
  return new ApiException(status, {
    message: TEST_ERROR_MESSAGES[code].en,
    code,
    ...(errors ? { errors } : {}),
  });
}

/** Staff = not a portal user, with `tests.manage` (Laravel `StudentTestPolicy::isStaff`). */
export const isTestStaff = (u: AuthUser) =>
  !isParentViewer(u) && !isTeacherViewer(u) && u.permissions.has('tests.manage');

/** The examiner: the test's teacher signed in, with `tests.conduct`. */
export const isExaminer = (u: AuthUser, t: Pick<StudentTest, 'teacherId'>) =>
  u.teacherId !== null && u.permissions.has('tests.conduct') && u.teacherId === t.teacherId;

/** Actions on a test (Laravel `StudentTestPolicy`). */
export function testCan(
  u: AuthUser,
  t: StudentTest,
  ability: Exclude<TestAbility, 'view'>,
): boolean {
  const actor = isTestStaff(u) || isExaminer(u, t);
  switch (ability) {
    case 'update':
    case 'refuse':
      return t.status === 'scheduled' && actor;
    case 'record':
      return (t.status === 'scheduled' || t.status === 'taken') && actor;
    case 'cancel':
      return (
        t.status === 'scheduled' && (isTestStaff(u) || (isExaminer(u, t) && t.createdById === u.id))
      );
    case 'reopen':
      return (t.status === 'refused' || t.status === 'cancelled') && isTestStaff(u);
  }
}

/**
 * Student tests (docs/27, D113–D119; Laravel `TestService`, `StudentTestPolicy`): scheduling,
 * results, decisions and the row scope. A test is not a class: nothing here touches the class
 * tables, pay or invoices.
 */
@Injectable()
export class TestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ scope

  /** Tests the viewer may see (D118). */
  async scopeWhere(viewer: AuthUser): Promise<Prisma.StudentTestWhereInput> {
    if (isParentViewer(viewer)) {
      const scope = await viewerScope(this.prisma, viewer);
      const ids = scope.kind === 'family' ? scope.studentIds : [];
      return { studentId: { in: ids }, status: { not: 'cancelled' } };
    }
    if (isTeacherViewer(viewer)) {
      const teacherId = viewer.teacherId ?? -1;
      return {
        OR: [
          { teacherId },
          { student: { teacherId } },
          { student: { enrollments: { some: { teacherId } } } },
        ],
      };
    }
    return {};
  }

  /** One test in the viewer's scope (404 otherwise), then the action (403). */
  async find(id: number, viewer: AuthUser, ability: TestAbility = 'view'): Promise<TestRow> {
    const test = await this.prisma.studentTest.findFirst({
      where: { AND: [{ id }, await this.scopeWhere(viewer)] },
      include: testInclude,
    });
    if (!test) throw notFound();
    if (ability !== 'view' && !testCan(viewer, test, ability)) throw forbidden();
    return test;
  }

  // ------------------------------------------------------------------ reads

  async list(q: ListQuery, viewer: AuthUser): Promise<Paginated<TestDto>> {
    const st = await this.settings.all();
    const and: Prisma.StudentTestWhereInput[] = [await this.scopeWhere(viewer)];
    if (q.month) {
      const [from, to] = monthRange(q.month, st['academy.timezone']);
      and.push({ scheduledAt: { gte: from, lt: to } });
    }
    if (q.date) {
      const tz = st['academy.timezone'];
      and.push({
        scheduledAt: {
          gte: new Date(startOfLocalDay(q.date, tz)),
          lt: new Date(startOfLocalDay(addDays(q.date, 1), tz)),
        },
      });
    }
    if (q.from) and.push({ scheduledAt: { gte: new Date(q.from) } });
    if (q.to) and.push({ scheduledAt: { lt: new Date(q.to) } });
    if (q.teacherId) and.push({ teacherId: q.teacherId });
    if (q.studentId) and.push({ studentId: q.studentId });
    if (q.track) and.push({ track: q.track });
    const all: Prisma.StudentTestWhereInput = { AND: and };
    const where: Prisma.StudentTestWhereInput = q.status?.length
      ? { AND: [...and, { status: { in: q.status } }] }
      : all;

    // Scheduled first (soonest first), then the rest (newest first): two ordered slices.
    const scheduledWhere = { AND: [where, { status: 'scheduled' as const }] };
    const restWhere = { AND: [where, { status: { not: 'scheduled' as const } }] };
    const [scheduledTotal, restTotal, groups] = await Promise.all([
      this.prisma.studentTest.count({ where: scheduledWhere }),
      this.prisma.studentTest.count({ where: restWhere }),
      this.prisma.studentTest.groupBy({ by: ['status'], where: all, _count: { _all: true } }),
    ]);
    const skip = (q.page - 1) * q.perPage;
    const take = q.perPage;
    const first =
      skip < scheduledTotal
        ? await this.prisma.studentTest.findMany({
            where: scheduledWhere,
            include: testInclude,
            orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
            skip,
            take,
          })
        : [];
    const restSkip = Math.max(0, skip - scheduledTotal);
    const restTake = take - first.length;
    const second =
      restTake > 0
        ? await this.prisma.studentTest.findMany({
            where: restWhere,
            include: testInclude,
            orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
            skip: restSkip,
            take: restTake,
          })
        : [];
    return {
      data: [...first, ...second].map((t) => this.dto(t, viewer, st)),
      meta: pageMeta(
        q,
        scheduledTotal + restTotal,
        statusCounts(
          TEST_STATUSES,
          groups.map((g) => ({ status: g.status, _count: g._count })),
        ),
      ),
    };
  }

  /** Month counts (D119): created = every test of the month except cancelled. */
  async summary(month: string, viewer: AuthUser): Promise<TestSummaryDto> {
    if (isParentViewer(viewer)) throw forbidden();
    const st = await this.settings.all();
    const [from, to] = monthRange(month, st['academy.timezone']);
    const rows = await this.prisma.studentTest.findMany({
      where: { AND: [await this.scopeWhere(viewer), { scheduledAt: { gte: from, lt: to } }] },
      select: {
        teacherId: true,
        status: true,
        teacher: { select: { firstName: true, lastName: true } },
      },
    });
    const count = (set: Array<{ status: TestStatus }>) => ({
      created: set.filter((r) => r.status !== 'cancelled').length,
      taken: set.filter((r) => r.status === 'taken').length,
      remaining: set.filter((r) => r.status === 'scheduled').length,
      refused: set.filter((r) => r.status === 'refused').length,
      cancelled: set.filter((r) => r.status === 'cancelled').length,
    });
    const byTeacher = new Map<number, typeof rows>();
    for (const r of rows) byTeacher.set(r.teacherId, [...(byTeacher.get(r.teacherId) ?? []), r]);
    return {
      month,
      counts: count(rows),
      byTeacher: [...byTeacher.entries()]
        .map(([id, set]) => ({
          teacher: { id, name: teacherName(set[0]!.teacher) },
          ...count(set),
        }))
        .sort((a, b) => b.created - a.created || a.teacher.id - b.teacher.id),
    };
  }

  dto(t: TestRow, viewer: AuthUser, st: SettingsMap): TestDto {
    const academy = st['academy.timezone'];
    const family = isParentViewer(viewer);
    const staff = isTestStaff(viewer);
    const until = t.recordedAt
      ? new Date(t.recordedAt.getTime() + st['sessions.report_edit_hours'] * HOUR)
      : null;
    const taken = t.status === 'taken';
    const canRecord = testCan(viewer, t, 'record');
    return {
      id: t.id,
      status: t.status,
      statusReason: t.statusReason,
      track: t.track,
      sections: orderedSections(t.sections),
      scheduledAt: isoZ(t.scheduledAt)!,
      durationMinutes: t.durationMinutes,
      month: localDate(t.scheduledAt.getTime(), academy).slice(0, 7),
      student: {
        id: t.student.id,
        name: t.student.name,
        timezone: zoneOr(t.student.family.timezone, academy),
      },
      teacher: {
        id: t.teacher.id,
        name: teacherName(t.teacher),
        timezone: zoneOr(t.teacher.timezone, academy),
      },
      course: t.course,
      notes: t.notes,
      result: taken
        ? {
            tajweed: t.tajweedScore ?? 0,
            reading: t.readingScore,
            hifz: t.hifzScore,
            overall: t.overallScore ?? 0,
            mistakes: t.mistakes,
            remarks: t.remarks,
            recordedAt: isoZ(t.recordedAt),
            ...(family ? {} : { internalNotes: t.internalNotes, editableUntil: isoZ(until) }),
            ...(staff ? { teacherRating: t.teacherRating } : {}),
          }
        : null,
      decidedAt: isoZ(t.decidedAt),
      createdAt: isoZ(t.createdAt)!,
      can: {
        update: testCan(viewer, t, 'update'),
        record: t.status === 'scheduled' && canRecord,
        editResult:
          taken && canRecord && (staff || (until !== null && until.getTime() > this.clock.nowMs())),
        refuse: testCan(viewer, t, 'refuse'),
        cancel: testCan(viewer, t, 'cancel'),
        reopen: testCan(viewer, t, 'reopen'),
        setExaminer: staff,
      },
    };
  }

  async show(id: number, viewer: AuthUser): Promise<TestDto> {
    return this.dto(await this.find(id, viewer), viewer, await this.settings.all());
  }

  // ------------------------------------------------------------------ writes

  async create(input: CreateInput, by: AuthUser): Promise<number> {
    const scope = await viewerScope(this.prisma, by);
    const student = await this.prisma.student.findFirst({
      where: { AND: [{ id: input.studentId }, studentScopeWhere(scope)] },
      include: { family: { select: { timezone: true } } },
    });
    if (!student) throw notFound();
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { studentId: student.id, ...LIVE_ENROLLMENT },
      orderBy: { id: 'desc' },
    });

    let teacherId: number | null;
    if (isTestStaff(by)) {
      if (input.teacherId) await this.assertTeacher(input.teacherId);
      teacherId = input.teacherId ?? enrollment?.teacherId ?? student.teacherId;
    } else {
      const own = by.teacherId;
      if (!own || !by.permissions.has('tests.conduct')) throw forbidden();
      if (input.teacherId !== undefined && input.teacherId !== own) throw forbidden();
      teacherId = own;
    }
    if (!teacherId) {
      throw testError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_examiner', {
        teacherId: [TEST_ERROR_MESSAGES.no_examiner.en],
      });
    }
    this.assertNotPast(input.scheduledAt);

    const st = await this.settings.all();
    const now = this.clock.now();
    const id = await this.prisma
      .$transaction(async (tx) => {
        // One scheduled test per student and track: serialise on the student row.
        await lockRow(tx, 'students', student.id);
        await assertNoOpenTest(tx, student.id, input.track);
        const test = await tx.studentTest.create({
          data: {
            studentId: student.id,
            teacherId: teacherId,
            courseId: enrollment?.courseId ?? student.regularCourseId,
            track: input.track,
            sections: orderedSections(input.sections),
            scheduledAt: new Date(input.scheduledAt),
            durationMinutes: input.durationMinutes ?? 30,
            studentTimezone: zoneOr(student.family.timezone, st['academy.timezone']),
            notes: input.notes ?? null,
            status: 'scheduled',
            createdById: by.id,
            createdAt: now,
            updatedAt: now,
          },
        });
        await this.audit.record(
          {
            actorId: by.id,
            action: 'created',
            subjectType: 'student_test',
            subjectId: test.id,
            after: snapshot(test),
          },
          tx,
        );
        return test.id;
      })
      .catch(rethrowOpenTest);
    return id;
  }

  async update(test: TestRow, input: UpdateInput, by: AuthUser): Promise<void> {
    const data: Prisma.StudentTestUncheckedUpdateInput = {};
    if (input.teacherId !== undefined && input.teacherId !== test.teacherId) {
      if (!isTestStaff(by)) throw forbidden();
      await this.assertTeacher(input.teacherId);
      data.teacherId = input.teacherId;
    }
    if (input.scheduledAt !== undefined) {
      this.assertNotPast(input.scheduledAt);
      data.scheduledAt = new Date(input.scheduledAt);
    }
    if (input.sections !== undefined) data.sections = orderedSections(input.sections);
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.durationMinutes !== undefined) data.durationMinutes = input.durationMinutes;
    if (!Object.keys(data).length) return;

    await this.prisma.$transaction(async (tx) => {
      const fresh = await lockAndCheck(tx, test.id, ['scheduled']);
      const after = await tx.studentTest.update({
        where: { id: test.id },
        data: { ...data, updatedAt: this.clock.now() },
      });
      const changed = diff(snapshot(fresh), snapshot(after));
      if (changed) {
        await this.audit.record(
          {
            actorId: by.id,
            action: 'updated',
            subjectType: 'student_test',
            subjectId: test.id,
            before: changed[0],
            after: changed[1],
          },
          tx,
        );
      }
    });
  }

  /**
   * Record or correct the result (D115, D116). The body is checked after the scope and the action
   * (Laravel `RecordResultRequest`), so a rule never hints at a hidden test; which scores are
   * needed depends on the track. The examiner corrects inside `sessions.report_edit_hours`; staff
   * at any time with a reason.
   */
  async record(test: StudentTest, raw: unknown, by: AuthUser): Promise<void> {
    const input = new ZodPipe(recordTestResultSchema).transform(raw);
    const errors: Record<string, string[]> = {};
    const present = (v: unknown) => v !== undefined && v !== null;
    if (needsReading(test.track) && !present(input.readingScore)) {
      errors.readingScore = ['The reading score field is required.'];
    }
    if (!needsReading(test.track) && present(input.readingScore)) {
      errors.readingScore = ['The reading score field is prohibited.'];
    }
    if (needsHifz(test.track) && !present(input.hifzScore)) {
      errors.hifzScore = ['The hifz score field is required.'];
    }
    if (!needsHifz(test.track) && present(input.hifzScore)) {
      errors.hifzScore = ['The hifz score field is prohibited.'];
    }
    if (Object.keys(errors).length) throw validationError(errors);

    const staff = isTestStaff(by);
    const st = await this.settings.all();
    await this.prisma.$transaction(async (tx) => {
      const t = await lockAndCheck(tx, test.id, ['scheduled', 'taken']);
      const now = this.clock.nowMs();
      if (now < t.scheduledAt.getTime() - TEST_RECORD_LEAD_MINUTES * MINUTE) {
        throw testError(HttpStatus.CONFLICT, 'test_not_started');
      }
      const correction = t.status === 'taken';
      const reason = input.reason?.trim() ?? '';
      if (correction) {
        const open =
          t.recordedAt !== null &&
          now <= t.recordedAt.getTime() + st['sessions.report_edit_hours'] * HOUR;
        if (!staff && !open) throw testError(HttpStatus.CONFLICT, 'edit_window_closed');
        if (staff && reason === '') {
          throw testError(HttpStatus.UNPROCESSABLE_ENTITY, 'reason_required', {
            reason: [TEST_ERROR_MESSAGES.reason_required.en],
          });
        }
      }
      const mistakes = [...new Set(input.mistakes)].sort((a, b) => a - b);
      const allowed = new Set(allowedMistakes(t.sections));
      if (mistakes.some((m) => !allowed.has(m))) {
        throw testError(HttpStatus.UNPROCESSABLE_ENTITY, 'mistake_outside_sections', {
          mistakes: [TEST_ERROR_MESSAGES.mistake_outside_sections.en],
        });
      }
      const reading = needsReading(t.track) ? input.readingScore! : null;
      const hifz = needsHifz(t.track) ? input.hifzScore! : null;
      const tajweed = tajweedScore(t.sections, mistakes);
      const after = await tx.studentTest.update({
        where: { id: t.id },
        data: {
          mistakes,
          tajweedScore: tajweed,
          readingScore: reading,
          hifzScore: hifz,
          overallScore: overallScore(t.track, tajweed, reading, hifz),
          remarks: input.remarks ?? null,
          internalNotes: input.internalNotes ?? null,
          status: 'taken',
          statusReason: null,
          ...(staff && input.teacherRating !== undefined
            ? { teacherRating: input.teacherRating }
            : {}),
          ...(correction ? {} : { recordedAt: new Date(now), recordedById: by.id }),
          updatedAt: new Date(now),
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: correction ? 'test_result_corrected' : 'test_result_recorded',
          subjectType: 'student_test',
          subjectId: t.id,
          before: correction ? snapshot(t) : null,
          after: { ...snapshot(after), reason: reason || null },
          reason: reason || null,
        },
        tx,
      );
    });
  }

  /** Refuse / cancel (from scheduled) or reopen (staff, from refused / cancelled), with a reason. */
  async decide(test: StudentTest, to: TestStatus, reason: string, by: AuthUser): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        let t: StudentTest;
        if (to === 'scheduled') {
          // Reopen: same one-open-test rule as create, under the student lock.
          await lockRow(tx, 'students', test.studentId);
          t = await lockAndCheck(tx, test.id, ['refused', 'cancelled']);
          await assertNoOpenTest(tx, t.studentId, t.track, t.id);
        } else {
          t = await lockAndCheck(tx, test.id, ['scheduled']);
        }
        const now = this.clock.now();
        await tx.studentTest.update({
          where: { id: t.id },
          data: {
            status: to,
            statusReason: to === 'scheduled' ? null : reason,
            decidedById: by.id,
            decidedAt: now,
            updatedAt: now,
          },
        });
        await this.audit.record(
          {
            actorId: by.id,
            action: `test_${to === 'scheduled' ? 'reopened' : to}`,
            subjectType: 'student_test',
            subjectId: t.id,
            before: { status: t.status },
            after: { status: to, reason },
            reason,
          },
          tx,
        );
      })
      .catch(rethrowOpenTest);
  }

  private assertNotPast(scheduledAt: string): void {
    if (new Date(scheduledAt).getTime() <= this.clock.nowMs() - DAY) {
      throw validationError({
        scheduledAt: ['The scheduled time may not be more than a day in the past.'],
      });
    }
  }

  private async assertTeacher(id: number): Promise<void> {
    const t = await this.prisma.teacher.findUnique({ where: { id }, select: { archivedAt: true } });
    if (!t || t.archivedAt) {
      throw validationError({ teacherId: ['The selected teacher is invalid.'] });
    }
  }
}

/** A month (YYYY-MM) in the academy zone as a UTC [from, to) range (D119). */
export function monthRange(month: string, zone: string): [Date, Date] {
  const first = `${month}-01`;
  return [
    new Date(startOfLocalDay(first, zone)),
    new Date(startOfLocalDay(addMonths(first, 1), zone)),
  ];
}

/** 422 when the student already has a scheduled test in this track (D117). Under the student lock. */
async function assertNoOpenTest(
  tx: Tx,
  studentId: number,
  track: StudentTest['track'],
  exceptId?: number,
): Promise<void> {
  const open = await tx.studentTest.count({
    where: {
      studentId,
      track,
      status: 'scheduled',
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  if (open) throw testError(HttpStatus.UNPROCESSABLE_ENTITY, 'test_already_scheduled');
}

/** Re-reads the test under a row lock and checks it is still in one of the expected statuses. */
async function lockAndCheck(tx: Tx, id: number, expected: TestStatus[]): Promise<StudentTest> {
  await tx.$queryRaw`SELECT id FROM "student_tests" WHERE id = ${id} FOR UPDATE`;
  const fresh = await tx.studentTest.findUnique({ where: { id } });
  if (!fresh) throw notFound();
  if (!expected.includes(fresh.status)) throw testError(HttpStatus.CONFLICT, 'invalid_test_status');
  return fresh;
}

/** The partial unique index lost a race: same answer as the check. */
function rethrowOpenTest(error: unknown): never {
  // The only unique key these writes can hit is the open-test index (`legacy_id` is never set).
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw testError(HttpStatus.UNPROCESSABLE_ENTITY, 'test_already_scheduled');
  }
  throw error;
}

function snapshot(t: StudentTest): Record<string, unknown> {
  return {
    status: t.status,
    teacherId: t.teacherId,
    track: t.track,
    sections: t.sections,
    scheduledAt: isoZ(t.scheduledAt),
    durationMinutes: t.durationMinutes,
    notes: t.notes,
    mistakes: t.mistakes,
    tajweedScore: t.tajweedScore,
    readingScore: t.readingScore,
    hifzScore: t.hifzScore,
    overallScore: t.overallScore,
    remarks: t.remarks,
    teacherRating: t.teacherRating,
  };
}
