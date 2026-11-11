import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = Pick<PrismaService, 'auditLog'> | Prisma.TransactionClient;

export interface AuditEntry {
  actorId: number | null;
  /** `created`, `updated`, `status_changed`, `archived`, `unarchived`, `role_created`, … */
  action: string;
  /** `family`, `student`, `teacher`, `user`, `role`, … */
  subjectType: string;
  subjectId: number | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

/** Only the keys whose values differ, as `[before, after]` (null when nothing changed). */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>] | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return Object.keys(a).length ? [b, a] : null;
}

/**
 * The audit log (`audit_logs`): written inside the same transaction as the change it records,
 * so a change is never saved without its row (and vice versa).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
        reason: entry.reason ?? null,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
