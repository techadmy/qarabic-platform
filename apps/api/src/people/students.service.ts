import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ACTIVE_STATUSES,
  type activeStatusChangeSchema,
  type createStudentSchema,
  type Paginated,
  type StudentDetailDto,
  type StudentDto,
  type studentListQuerySchema,
  type updateStudentSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiException, conflict, notFound, rule } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { contains, dateOnly, phoneDigits, searchId, toDate } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EnrollmentsService } from '../schedule/enrollments.service.js';
import { LIVE_ENROLLMENT } from '../schedule/scope.js';
import {
  archiveInfo,
  assertChanged,
  assertNotArchived,
  byUser,
  invalid,
  isParentViewer,
  isTeacherViewer,
  iso,
  lockRow,
  recordStatusChange,
  statusHistory,
  statusInfo,
  statusStamp,
  type Tx,
} from './people.common.js';

const course = { select: { id: true, nameAr: true, nameEn: true } } as const;

const include = {
  family: {
    select: {
      id: true,
      countryCode: true,
      timezone: true,
      userId: true,
      user: { select: { name: true } },
    },
  },
  regularCourse: course,
  additionalCourse: course,
  teacher: { select: { id: true, firstName: true, lastName: true } },
  statusChangedBy: byUser,
  archivedBy: byUser,
} satisfies Prisma.StudentInclude;

type Row = Prisma.StudentGetPayload<{ include: typeof include }>;

const teacherName = (t: { firstName: string; lastName: string | null }) =>
  [t.firstName, t.lastName].filter(Boolean).join(' ');

function snapshot(row: Row): Record<string, unknown> {
  return {
    familyId: row.familyId,
    name: row.name,
    email: row.email,
    gender: row.gender,
    age: row.age,
    language: row.language,
    regularCourseId: row.regularCourseId,
    additionalCourseId: row.additionalCourseId,
    teacherId: row.teacherId,
    startDate: dateOnly(row.startDate),
    zoomId: row.zoomId,
    remarkParent: row.remarkParent,
    remarkTeacher: row.remarkTeacher,
  };
}

const forbidden = () =>
  new ApiException(HttpStatus.FORBIDDEN, {
    message: 'You do not have permission to do this.',
    code: 'forbidden',
  });

/**
 * Students (docs/28): list, profile, add, edit, status, archive / restore. Reads are open to staff
 * with `families.view`, a teacher for their own students (`sessions.conduct`, D138) and a parent
 * for their own children; writes need `families.manage`.
 */
@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  async list(
    q: z.output<typeof studentListQuerySchema>,
    viewer: AuthUser,
  ): Promise<Paginated<StudentDto>> {
    const scope = await this.scopeOf(viewer);
    const and: Prisma.StudentWhereInput[] = [scope];
    // Portal users only ever see live records.
    const portal = isTeacherViewer(viewer) || isParentViewer(viewer);
    and.push({ archivedAt: q.archived && !portal ? { not: null } : null });
    if (q.familyId) and.push({ familyId: q.familyId });
    if (q.teacherId) and.push({ teacherId: q.teacherId });
    if (q.courseId) {
      and.push({ OR: [{ regularCourseId: q.courseId }, { additionalCourseId: q.courseId }] });
    }
    if (q.q) {
      const id = searchId(q.q);
      const digits = phoneDigits(q.q);
      // A teacher never sees emails or the parent's details, so cannot search by them either.
      const byContact = !isTeacherViewer(viewer);
      and.push({
        OR: [
          { name: contains(q.q) },
          { zoomId: contains(q.q) },
          ...(id ? [{ id }] : []),
          ...(byContact
            ? [
                { email: contains(q.q) },
                { family: { user: { name: contains(q.q) } } },
                { family: { user: { email: contains(q.q) } } },
                ...(digits ? [{ family: { user: { phone: { contains: digits } } } }] : []),
              ]
            : []),
        ],
      });
    }
    const where: Prisma.StudentWhereInput = { AND: and };
    const listWhere = q.status ? { AND: [...and, { status: q.status }] } : where;
    const order = q.order ?? (q.sort === 'name' ? 'asc' : 'desc');
    const [rows, total, groups] = await Promise.all([
      this.prisma.student.findMany({
        where: listWhere,
        include,
        orderBy: [{ [q.sort]: order }, { id: order }],
        ...pageArgs(q),
      }),
      this.prisma.student.count({ where: listWhere }),
      this.prisma.student.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    return {
      data: rows.map((r) => this.toDto(r, viewer)),
      meta: pageMeta(q, total, statusCounts(ACTIVE_STATUSES, groups)),
    };
  }

  async show(id: number, viewer: AuthUser): Promise<StudentDetailDto> {
    const scope = await this.scopeOf(viewer, true);
    // 404, not 403: never confirm that another family's child exists (Laravel StudentPolicy).
    const row = await this.prisma.student.findFirst({ where: { AND: [{ id }, scope] }, include });
    if (!row) throw notFound();
    const portal = isTeacherViewer(viewer) || isParentViewer(viewer);
    return {
      ...this.toDto(row, viewer),
      statusHistory: portal ? [] : await statusHistory(this.prisma, 'student', id),
    };
  }

  async create(input: z.output<typeof createStudentSchema>, actor: AuthUser): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertFamily(tx, input.familyId, null);
      await this.assertTeacher(tx, input.teacherId, null);
      await this.assertCourses(tx, input);
      const student = await tx.student.create({
        data: { familyId: input.familyId, name: input.name, ...this.fields(input) },
        include,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'created',
          subjectType: 'student',
          subjectId: student.id,
          after: snapshot(student),
        },
        tx,
      );
      return student.id;
    });
  }

  async update(
    id: number,
    input: z.output<typeof updateStudentSchema>,
    actor: AuthUser,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'students', id);
      const before = await tx.student.findUniqueOrThrow({ where: { id }, include });
      assertNotArchived(before);
      if (input.familyId !== undefined) {
        await this.assertFamily(tx, input.familyId, before.familyId);
      }
      await this.assertTeacher(tx, input.teacherId, before.teacherId);
      await this.assertCourses(tx, input);
      const after = await tx.student.update({
        where: { id },
        data: {
          ...(input.familyId !== undefined ? { familyId: input.familyId } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...this.fields(input),
        },
        include,
      });
      const changes = diff(snapshot(before), snapshot(after));
      if (changes) {
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'updated',
            subjectType: 'student',
            subjectId: id,
            before: changes[0],
            after: changes[1],
          },
          tx,
        );
      }
    });
  }

  /**
   * Active / inactive with a reason for inactive (D123, D125). An inactive student's live
   * enrollments end today (their later generated classes are removed); back to active reopens
   * nothing by itself.
   */
  async changeStatus(
    id: number,
    input: z.output<typeof activeStatusChangeSchema>,
    actor: AuthUser,
  ): Promise<void> {
    const resyncs = await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'students', id);
      const student = await tx.student.findUniqueOrThrow({ where: { id } });
      assertNotArchived(student);
      assertChanged(student.status, input.status);
      await tx.student.update({
        where: { id },
        data: { status: input.status, ...statusStamp(input.reason, actor.id) },
      });
      await recordStatusChange(
        tx,
        'student',
        id,
        student.status,
        input.status,
        input.reason,
        actor.id,
      );
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'status_changed',
          subjectType: 'student',
          subjectId: id,
          before: { status: student.status },
          after: { status: input.status, reason: input.reason },
          reason: input.reason,
        },
        tx,
      );
      return input.status === 'inactive' ? this.enrollments.endForStudent(tx, id, actor.id) : [];
    });
    await this.enrollments.resyncAll(resyncs);
  }

  async archive(id: number, reason: string, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'students', id);
      const student = await tx.student.findUniqueOrThrow({ where: { id } });
      if (student.archivedAt) throw conflict('archived');
      if (student.status !== 'inactive') throw conflict('must_deactivate_first');
      await tx.student.update({
        where: { id },
        data: { archivedAt: new Date(), archivedById: actor.id, archiveReason: reason },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'archived',
          subjectType: 'student',
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
      await lockRow(tx, 'students', id);
      const student = await tx.student.findUniqueOrThrow({
        where: { id },
        include: { family: { select: { archivedAt: true } } },
      });
      if (!student.archivedAt) throw rule(HttpStatus.UNPROCESSABLE_ENTITY, 'not_archived');
      // A child comes back only with (or after) its family.
      if (student.family.archivedAt) throw conflict('family_archived');
      await tx.student.update({
        where: { id },
        data: { archivedAt: null, archivedById: null, archiveReason: null },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'unarchived', subjectType: 'student', subjectId: id },
        tx,
      );
    });
  }

  /**
   * Row scope (D138): a teacher lists the students they teach now (own or a live enrollment) and
   * may open a past one too (any enrollment or class with them: a substitute writes the report);
   * a parent their own children; staff need `families.view` (`sessions.conduct` on a staff role
   * never stands in for it). Portal users never see archived rows.
   */
  private async scopeOf(viewer: AuthUser, single = false): Promise<Prisma.StudentWhereInput> {
    if (isTeacherViewer(viewer)) {
      const teacher = await this.prisma.teacher.findUnique({
        where: { userId: viewer.id },
        select: { id: true },
      });
      const teacherId = teacher?.id ?? -1;
      // The students they teach now: their own (student.teacher) or a live enrollment (D137).
      return {
        archivedAt: null,
        OR: single
          ? [
              { teacherId },
              { enrollments: { some: { teacherId } } },
              { sessions: { some: { teacherId } } },
            ]
          : [{ teacherId }, { enrollments: { some: { teacherId, ...LIVE_ENROLLMENT } } }],
      };
    }
    if (isParentViewer(viewer)) return { family: { userId: viewer.id }, archivedAt: null };
    if (!viewer.permissions.has('families.view') && !viewer.permissions.has('families.manage')) {
      throw forbidden();
    }
    return {};
  }

  private fields(input: z.output<typeof updateStudentSchema>) {
    const keys = [
      'email',
      'gender',
      'age',
      'language',
      'regularCourseId',
      'additionalCourseId',
      'teacherId',
      'zoomId',
      'remarkParent',
      'remarkTeacher',
    ] as const;
    const data: Record<string, unknown> = {};
    for (const key of keys) if (input[key] !== undefined) data[key] = input[key];
    if (input.startDate !== undefined) data.startDate = toDate(input.startDate);
    return data as Partial<Prisma.StudentUncheckedCreateInput>;
  }

  /** Not archived, and (for a new or moved child) not a deactivated family. */
  private async assertFamily(tx: Tx, familyId: number, current: number | null): Promise<void> {
    const family = await tx.family.findUnique({
      where: { id: familyId },
      select: { status: true, archivedAt: true },
    });
    if (!family || family.archivedAt || (family.status === 'deactivated' && familyId !== current)) {
      throw invalid('familyId', 'The selected family is invalid.');
    }
  }

  /** Not archived, and active unless it is the teacher the student already has. */
  private async assertTeacher(
    tx: Tx,
    teacherId: number | null | undefined,
    current: number | null,
  ): Promise<void> {
    if (!teacherId) return;
    const teacher = await tx.teacher.findUnique({
      where: { id: teacherId },
      select: { status: true, archivedAt: true },
    });
    if (!teacher || teacher.archivedAt || (teacher.status !== 'active' && teacherId !== current)) {
      throw invalid('teacherId', 'The selected teacher is invalid.');
    }
  }

  private async assertCourses(
    tx: Tx,
    input: { regularCourseId?: number | null; additionalCourseId?: number | null },
  ): Promise<void> {
    for (const key of ['regularCourseId', 'additionalCourseId'] as const) {
      const id = input[key];
      if (!id) continue;
      const exists = await tx.course.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw invalid(key, 'The selected course is invalid.');
    }
  }

  private toDto(row: Row, viewer: AuthUser): StudentDto {
    const teacherView = isTeacherViewer(viewer);
    const parentView = isParentViewer(viewer);
    const portal = teacherView || parentView;
    const dto: StudentDto = {
      id: row.id,
      familyId: row.familyId,
      family: teacherView
        ? { id: row.family.id, countryCode: row.family.countryCode, timezone: row.family.timezone }
        : {
            id: row.family.id,
            parentName: row.family.user.name,
            countryCode: row.family.countryCode,
            timezone: row.family.timezone,
          },
      name: row.name,
      email: row.email,
      gender: row.gender,
      age: row.age,
      language: row.language,
      regularCourse: row.regularCourse,
      additionalCourse: row.additionalCourse,
      teacher: row.teacher ? { id: row.teacher.id, name: teacherName(row.teacher) } : null,
      startDate: dateOnly(row.startDate),
      zoomId: row.zoomId,
      // ISO-3: each remark only to staff and its own audience; staff reasons stay with staff.
      remarkParent: teacherView ? null : row.remarkParent,
      remarkTeacher: parentView ? null : row.remarkTeacher,
      status: portal ? { ...statusInfo(row), reason: null, changedBy: null } : statusInfo(row),
      archive: archiveInfo(row),
      createdAt: iso(row.createdAt)!,
    };
    // D138: a teacher never receives the student's login email.
    if (teacherView) delete dto.email;
    return dto;
  }
}
