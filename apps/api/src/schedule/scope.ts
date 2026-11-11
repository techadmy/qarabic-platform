import { HttpStatus } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiException } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isParentViewer, isTeacherViewer, type Tx } from '../people/people.common.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Row scope of a viewer for schedule and class data (Laravel `App\\Support\\Scope`, D138): staff see
 * what their permission allows, a teacher only their own classes and enrollments, a parent only
 * their children's.
 */
export type ViewerScope =
  | { kind: 'staff' }
  | { kind: 'teacher'; teacherId: number }
  | { kind: 'family'; familyId: number; studentIds: number[] };

export async function viewerScope(db: PrismaService | Tx, user: AuthUser): Promise<ViewerScope> {
  if (isTeacherViewer(user)) {
    const teacher = await db.teacher.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    return { kind: 'teacher', teacherId: teacher?.id ?? -1 };
  }
  if (isParentViewer(user)) {
    const family = await db.family.findUnique({
      where: { userId: user.id },
      select: { id: true, students: { select: { id: true } } },
    });
    return {
      kind: 'family',
      familyId: family?.id ?? -1,
      studentIds: family?.students.map((s) => s.id) ?? [],
    };
  }
  return { kind: 'staff' };
}

export function sessionScopeWhere(scope: ViewerScope): Prisma.ClassSessionWhereInput {
  if (scope.kind === 'teacher') return { teacherId: scope.teacherId };
  if (scope.kind === 'family') return { studentId: { in: scope.studentIds } };
  return {};
}

/**
 * Students a viewer may open (Laravel `Scope::canSeeStudent`): a teacher their own students or any
 * they have an enrollment or a class with (a substitute writes the report), a parent their own
 * children, staff any. Archived students are hidden from portal users.
 */
export function studentScopeWhere(scope: ViewerScope): Prisma.StudentWhereInput {
  if (scope.kind === 'teacher') {
    const teacherId = scope.teacherId;
    return {
      archivedAt: null,
      OR: [
        { teacherId },
        { enrollments: { some: { teacherId } } },
        { sessions: { some: { teacherId } } },
      ],
    };
  }
  if (scope.kind === 'family') return { id: { in: scope.studentIds }, archivedAt: null };
  return {};
}

export function enrollmentScopeWhere(scope: ViewerScope): Prisma.EnrollmentWhereInput {
  if (scope.kind === 'teacher') return { teacherId: scope.teacherId };
  if (scope.kind === 'family') return { studentId: { in: scope.studentIds } };
  return {};
}

export const forbidden = () =>
  new ApiException(HttpStatus.FORBIDDEN, {
    message: 'You do not have permission to do this.',
    code: 'forbidden',
  });

/**
 * Routes open to staff with `permission` or to a teacher for their own rows (D137/D138).
 * `sessions.conduct` on a staff role never widens access.
 */
export function assertStaffOrTeacher(user: AuthUser, permission: string): void {
  if (!user.permissions.has(permission) && !isTeacherViewer(user)) throw forbidden();
}

/** Staff-only screens (availability, schedule check): never a teacher or a family. */
export function assertStaff(user: AuthUser): void {
  if (isTeacherViewer(user) || isParentViewer(user)) throw forbidden();
}

/** The live enrollments: active or paused (at most one per student and course). */
export const LIVE_ENROLLMENT = {
  status: { in: ['active', 'paused'] },
} satisfies Prisma.EnrollmentWhereInput;
