import { HttpStatus } from '@nestjs/common';
import type { ArchiveInfo, PersonRef, StatusHistoryEntry } from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { conflict, notFound, rule, validationError } from '../common/errors.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PersonType } from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export type Tx = Prisma.TransactionClient;

/** `{ id, name }` of the user who changed / archived a record. */
export const byUser = { select: { id: true, name: true } } as const;

export function personRef(user: { id: number; name: string } | null | undefined): PersonRef | null {
  return user ? { id: user.id, name: user.name } : null;
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function statusInfo<T extends string>(row: {
  status: T;
  statusReason: string | null;
  statusChangedAt: Date | null;
  statusChangedBy: { id: number; name: string } | null;
}) {
  return {
    value: row.status,
    reason: row.statusReason,
    changedAt: iso(row.statusChangedAt),
    changedBy: personRef(row.statusChangedBy),
  };
}

export function archiveInfo(row: {
  archivedAt: Date | null;
  archiveReason: string | null;
  archivedBy: { id: number; name: string } | null;
}): ArchiveInfo {
  return row.archivedAt
    ? {
        archivedAt: row.archivedAt.toISOString(),
        reason: row.archiveReason,
        by: personRef(row.archivedBy),
      }
    : null;
}

export async function statusHistory(
  prisma: PrismaService,
  subjectType: PersonType,
  subjectId: number,
): Promise<StatusHistoryEntry[]> {
  const rows = await prisma.statusChange.findMany({
    where: { subjectType, subjectId },
    include: { changedBy: byUser },
    orderBy: { id: 'desc' },
    take: 50,
  });
  return rows.map((r) => ({
    from: r.fromStatus,
    to: r.toStatus,
    reason: r.reason,
    at: r.createdAt.toISOString(),
    by: personRef(r.changedBy),
  }));
}

/** Teachers and parents are portal users: their rows are scoped server-side (D138). */
export const isTeacherViewer = (user: AuthUser) => user.role?.kind === 'teacher';
export const isParentViewer = (user: AuthUser) => user.role?.kind === 'parent';
export const isOwner = (user: AuthUser) => user.role?.kind === 'owner';

const LOCKABLE = new Set(['families', 'students', 'teachers', 'users']);

/**
 * Re-reads the row with a write lock inside the caller's transaction, so checks and writes cannot
 * race another request on the same record (Laravel `lockForUpdate`). 404 when it does not exist.
 */
export async function lockRow(tx: Tx, table: string, id: number): Promise<void> {
  if (!LOCKABLE.has(table)) throw new Error(`Not lockable: ${table}`);
  const rows = await tx.$queryRaw<
    Array<{ id: number }>
  >`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw notFound();
}

/** Archived ("deleted", D128) records are read-only until restored. */
export function assertNotArchived(row: { archivedAt: Date | null }): void {
  if (row.archivedAt) throw conflict('archived');
}

export function assertChanged(current: string, next: string): void {
  if (current === next) {
    throw rule(HttpStatus.UNPROCESSABLE_ENTITY, 'same_status', {
      errors: { status: ['The record already has this status.'] },
    });
  }
}

/** Emails are unique across every login (case-insensitive). */
export async function assertEmailFree(
  db: Tx | PrismaService,
  email: string,
  ignoreUserId?: number,
): Promise<void> {
  const taken = await db.user.findFirst({
    where: {
      email: { equals: email, mode: 'insensitive' },
      ...(ignoreUserId ? { id: { not: ignoreUserId } } : {}),
    },
    select: { id: true },
  });
  if (taken) throw validationError({ email: ['The email has already been taken.'] });
}

/** A unique-email race lost at insert time reads like the validation error. */
export function rethrowEmailTaken(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes('email')
  ) {
    throw validationError({ email: ['The email has already been taken.'] });
  }
  throw error;
}

/** Records the status change in the history table (who, when, why). */
export async function recordStatusChange(
  tx: Tx,
  subjectType: PersonType,
  subjectId: number,
  from: string | null,
  to: string,
  reason: string | null,
  by: number,
): Promise<void> {
  await tx.statusChange.create({
    data: { subjectType, subjectId, fromStatus: from, toStatus: to, reason, changedById: by },
  });
}

/** `{ statusReason, statusChangedAt, statusChangedById }` for a status write. */
export function statusStamp(reason: string | null, by: number, at = new Date()) {
  return { statusReason: reason, statusChangedAt: at, statusChangedById: by };
}

export const invalid = (field: string, message = `The selected ${field} is invalid.`) =>
  validationError({ [field]: [message] });
