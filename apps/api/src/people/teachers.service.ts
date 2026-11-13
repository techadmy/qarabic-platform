import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ACTIVE_STATUSES,
  type activeStatusChangeSchema,
  type createTeacherSchema,
  type Paginated,
  type TeacherDetailDto,
  type TeacherDto,
  type teacherListQuerySchema,
  type updateTeacherSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { conflict, notFound, rule } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { contains, phoneDigits, searchId } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { syncTeacherPayProfile, teacherRate } from '../payroll/teacher-pay-rate.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AccountsService } from './accounts.service.js';
import {
  archiveInfo,
  assertChanged,
  assertEmailFree,
  assertNotArchived,
  byUser,
  invalid,
  iso,
  lockRow,
  recordStatusChange,
  rethrowEmailTaken,
  statusHistory,
  statusInfo,
  statusStamp,
  type Tx,
} from './people.common.js';

/** Students that keep a teacher in service: active and not archived. */
const activeStudentsWhere = {
  status: 'active',
  archivedAt: null,
} satisfies Prisma.StudentWhereInput;

const include = {
  user: { select: { id: true, email: true, phone: true } },
  courses: {
    select: { course: { select: { id: true, nameAr: true, nameEn: true } } },
    orderBy: { courseId: 'asc' },
  },
  statusChangedBy: byUser,
  archivedBy: byUser,
  _count: { select: { students: { where: activeStudentsWhere } } },
  // N7: the hourly rate lives on the pay profile (D89).
  payProfile: { select: { hourlyRate: true, currency: true } },
} satisfies Prisma.TeacherInclude;

type Row = Prisma.TeacherGetPayload<{ include: typeof include }>;

const fullName = (first: string, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');

function snapshot(row: Row): Record<string, unknown> {
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.user.email,
    phone: row.user.phone,
    altPhone: row.altPhone,
    gender: row.gender,
    nationality: row.nationality,
    countryCode: row.countryCode,
    timezone: row.timezone,
    age: row.age,
    hourlyRate: row.payProfile?.hourlyRate.toFixed(2) ?? null,
    hourlyRateCurrency: row.payProfile?.currency ?? null,
    courseIds: row.courses.map((c) => c.course.id),
    qualification: row.qualification,
    experience: row.experience,
    address: row.address,
    skypeId: row.skypeId,
    description: row.description,
    acceptsTrials: row.acceptsTrials,
    maxTrialsPerWeek: row.maxTrialsPerWeek,
    audience: row.audience,
    languages: row.languages,
  };
}

/**
 * Teachers (docs/28): list, profile, add (teacher login + profile), edit, status, archive /
 * restore. Reads need `staff.view`, writes `staff.manage`. A teacher never lists the other
 * teachers (D138): they have neither permission.
 */
@Injectable()
export class TeachersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async list(q: z.output<typeof teacherListQuerySchema>): Promise<Paginated<TeacherDto>> {
    const and: Prisma.TeacherWhereInput[] = [{ archivedAt: q.archived ? { not: null } : null }];
    if (q.courseId) and.push({ courses: { some: { courseId: q.courseId } } });
    if (q.q) {
      const id = searchId(q.q);
      const digits = phoneDigits(q.q);
      // Name, email, phone, ID (docs/28 §10).
      and.push({
        OR: [
          { firstName: contains(q.q) },
          { lastName: contains(q.q) },
          { user: { name: contains(q.q) } },
          { user: { email: contains(q.q) } },
          ...(digits ? [{ user: { phone: { contains: digits } } }] : []),
          ...(id ? [{ id }] : []),
        ],
      });
    }
    const where: Prisma.TeacherWhereInput = { AND: and };
    const listWhere = q.status ? { AND: [...and, { status: q.status }] } : where;
    const order = q.order ?? (q.sort === 'name' ? 'asc' : 'desc');
    const orderBy: Prisma.TeacherOrderByWithRelationInput[] =
      q.sort === 'name'
        ? [{ firstName: order }, { lastName: { sort: order, nulls: 'first' } }, { id: order }]
        : [{ [q.sort]: order }, { id: order }];
    const [rows, total, groups, currency] = await Promise.all([
      this.prisma.teacher.findMany({ where: listWhere, include, orderBy, ...pageArgs(q) }),
      this.prisma.teacher.count({ where: listWhere }),
      this.prisma.teacher.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.settings.get('payroll.default_currency'),
    ]);
    return {
      data: rows.map((r) => this.toDto(r, currency)),
      meta: pageMeta(q, total, statusCounts(ACTIVE_STATUSES, groups)),
    };
  }

  async show(id: number): Promise<TeacherDetailDto> {
    const row = await this.prisma.teacher.findUnique({ where: { id }, include });
    if (!row) throw notFound();
    const currency = await this.settings.get('payroll.default_currency');
    return {
      ...this.toDto(row, currency),
      statusHistory: await statusHistory(this.prisma, 'teacher', id),
    };
  }

  async create(input: z.output<typeof createTeacherSchema>, actor: AuthUser): Promise<number> {
    const currency = await this.currency(input.hourlyRateCurrency);
    return this.prisma
      .$transaction(async (tx) => {
        await assertEmailFree(tx, input.email);
        await this.assertCourses(tx, input.courseIds);
        const user = await this.accounts.create(tx, {
          roleName: 'teacher',
          name: fullName(input.firstName, input.lastName),
          email: input.email,
          phone: input.phone,
          timezone: input.timezone,
        });
        const created = await tx.teacher.create({
          data: {
            userId: user.id,
            firstName: input.firstName,
            timezone: input.timezone,
            ...this.fields(input),
          },
        });
        await syncTeacherPayProfile(tx, this.audit, created, input.hourlyRate, currency, actor.id);
        if (input.courseIds?.length) {
          await tx.teacherCourse.createMany({
            data: input.courseIds.map((courseId) => ({ teacherId: created.id, courseId })),
          });
        }
        const row = await tx.teacher.findUniqueOrThrow({ where: { id: created.id }, include });
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'created',
            subjectType: 'teacher',
            subjectId: created.id,
            after: snapshot(row),
          },
          tx,
        );
        return created.id;
      })
      .catch(rethrowEmailTaken);
  }

  async update(
    id: number,
    input: z.output<typeof updateTeacherSchema>,
    actor: AuthUser,
  ): Promise<void> {
    const currency = await this.currency(input.hourlyRateCurrency);
    await this.prisma
      .$transaction(async (tx) => {
        await lockRow(tx, 'teachers', id);
        const before = await tx.teacher.findUniqueOrThrow({ where: { id }, include });
        assertNotArchived(before);
        if (input.email !== undefined) await assertEmailFree(tx, input.email, before.userId);
        await this.assertCourses(tx, input.courseIds);

        await tx.teacher.update({
          where: { id },
          data: {
            ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...this.fields(input),
          },
        });
        await syncTeacherPayProfile(tx, this.audit, before, input.hourlyRate, currency, actor.id);
        const nameChanged = input.firstName !== undefined || input.lastName !== undefined;
        await tx.user.update({
          where: { id: before.userId },
          data: {
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(nameChanged
              ? {
                  name: fullName(
                    input.firstName ?? before.firstName,
                    input.lastName !== undefined ? input.lastName : before.lastName,
                  ),
                }
              : {}),
          },
        });
        if (input.courseIds !== undefined) {
          const ids = input.courseIds ?? [];
          await tx.teacherCourse.deleteMany({ where: { teacherId: id, courseId: { notIn: ids } } });
          if (ids.length) {
            await tx.teacherCourse.createMany({
              data: ids.map((courseId) => ({ teacherId: id, courseId })),
              skipDuplicates: true,
            });
          }
        }
        const after = await tx.teacher.findUniqueOrThrow({ where: { id }, include });
        const changes = diff(snapshot(before), snapshot(after));
        if (changes) {
          await this.audit.record(
            {
              actorId: actor.id,
              action: 'updated',
              subjectType: 'teacher',
              subjectId: id,
              before: changes[0],
              after: changes[1],
            },
            tx,
          );
        }
      })
      .catch(rethrowEmailTaken);
  }

  /**
   * Deactivation is refused while the teacher still has active students or live (active or
   * paused) enrollments (old `deactivate-teacher` rule, D125). The login stays (payslips, history).
   */
  async changeStatus(
    id: number,
    input: z.output<typeof activeStatusChangeSchema>,
    actor: AuthUser,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'teachers', id);
      const teacher = await tx.teacher.findUniqueOrThrow({ where: { id } });
      assertNotArchived(teacher);
      assertChanged(teacher.status, input.status);
      if (input.status === 'inactive') {
        // Locked, so a student cannot be given to this teacher between the check and the write.
        await tx.$queryRaw`SELECT id FROM "students" WHERE teacher_id = ${id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "enrollments" WHERE teacher_id = ${id} FOR UPDATE`;
        const active = await tx.student.count({ where: { teacherId: id, ...activeStudentsWhere } });
        // Laravel (N2) counts live enrollments (`teacher_has_enrollments`); the N1 code and its
        // `activeStudents` stay, so both block and both counts are returned.
        const liveEnrollments = await tx.enrollment.count({
          where: { teacherId: id, status: { in: ['active', 'paused'] } },
        });
        if (active > 0 || liveEnrollments > 0) {
          throw conflict('teacher_has_students', { activeStudents: active, liveEnrollments });
        }
      }
      await tx.teacher.update({
        where: { id },
        data: { status: input.status, ...statusStamp(input.reason, actor.id) },
      });
      await recordStatusChange(
        tx,
        'teacher',
        id,
        teacher.status,
        input.status,
        input.reason,
        actor.id,
      );
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'status_changed',
          subjectType: 'teacher',
          subjectId: id,
          before: { status: teacher.status },
          after: { status: input.status, reason: input.reason },
          reason: input.reason,
        },
        tx,
      );
    });
  }

  /** Archive: only an inactive teacher; the login closes until restored (D128). */
  async archive(id: number, reason: string, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'teachers', id);
      const teacher = await tx.teacher.findUniqueOrThrow({ where: { id } });
      if (teacher.archivedAt) throw conflict('archived');
      if (teacher.status !== 'inactive') throw conflict('must_deactivate_first');
      await tx.teacher.update({
        where: { id },
        data: { archivedAt: new Date(), archivedById: actor.id, archiveReason: reason },
      });
      await this.accounts.closeLogin(tx, teacher.userId);
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'archived',
          subjectType: 'teacher',
          subjectId: id,
          after: { reason },
          reason,
        },
        tx,
      );
    });
  }

  async restore(id: number, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'teachers', id);
      const teacher = await tx.teacher.findUniqueOrThrow({ where: { id } });
      if (!teacher.archivedAt) throw rule(HttpStatus.UNPROCESSABLE_ENTITY, 'not_archived');
      await tx.teacher.update({
        where: { id },
        data: { archivedAt: null, archivedById: null, archiveReason: null },
      });
      await tx.user.update({ where: { id: teacher.userId }, data: { isActive: true } });
      await this.audit.record(
        { actorId: actor.id, action: 'unarchived', subjectType: 'teacher', subjectId: id },
        tx,
      );
    });
  }

  /** Teachers are paid in the academy's pay currency (EGP); only payroll sets another (N7). */
  private async currency(requested: string | undefined): Promise<string> {
    const fallback = await this.settings.get('payroll.default_currency');
    if (requested !== undefined && requested !== fallback) {
      throw invalid('hourlyRateCurrency', `The hourly rate is paid in ${fallback}.`);
    }
    return fallback;
  }

  private fields(input: z.output<typeof updateTeacherSchema>) {
    const keys = [
      'lastName',
      'altPhone',
      'gender',
      'nationality',
      'countryCode',
      'age',
      'qualification',
      'experience',
      'address',
      'skypeId',
      'description',
      'acceptsTrials',
      'maxTrialsPerWeek',
      'audience',
      'languages',
    ] as const;
    const data: Record<string, unknown> = {};
    for (const key of keys) if (input[key] !== undefined) data[key] = input[key];
    return data as Partial<Prisma.TeacherUncheckedCreateInput>;
  }

  private async assertCourses(tx: Tx, ids: number[] | null | undefined): Promise<void> {
    if (!ids?.length) return;
    const found = await tx.course.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw invalid('courseIds', 'The selected courses are invalid.');
  }

  private toDto(row: Row, defaultCurrency: string): TeacherDto {
    return {
      id: row.id,
      userId: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      name: fullName(row.firstName, row.lastName),
      email: row.user.email,
      phone: row.user.phone,
      altPhone: row.altPhone,
      gender: row.gender,
      nationality: row.nationality,
      countryCode: row.countryCode,
      timezone: row.timezone,
      age: row.age,
      ...teacherRate(row.payProfile, defaultCurrency),
      courses: row.courses.map((c) => c.course),
      acceptsTrials: row.acceptsTrials,
      maxTrialsPerWeek: row.maxTrialsPerWeek,
      audience: row.audience,
      languages: row.languages as TeacherDto['languages'],
      qualification: row.qualification,
      experience: row.experience,
      address: row.address,
      skypeId: row.skypeId,
      description: row.description,
      status: statusInfo(row),
      archive: archiveInfo(row),
      activeStudents: row._count.students,
      createdAt: iso(row.createdAt)!,
    };
  }
}
