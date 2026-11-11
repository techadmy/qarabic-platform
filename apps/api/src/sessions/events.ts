import type { Prisma } from '../generated/prisma/client.js';
import type { Clock } from '../common/clock.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * Writes the append-only class timeline (`session_events`, docs/14 §2.5). `actor` null = the
 * system (generator, re-sync, request auto-approval, Zoom jobs).
 */
export async function recordEvent(
  db: Pick<PrismaService, 'sessionEvent'>,
  clock: Clock,
  sessionId: number,
  type: string,
  opts: {
    from?: string | null;
    to?: string | null;
    payload?: Record<string, unknown> | null;
    actor?: AuthUser | null;
  } = {},
): Promise<void> {
  await db.sessionEvent.create({
    data: {
      sessionId,
      type,
      fromStage: opts.from ?? null,
      toStage: opts.to ?? null,
      actorUserId: opts.actor?.id ?? null,
      actorRole: opts.actor?.role?.name ?? null,
      payload: (opts.payload ?? undefined) as Prisma.InputJsonValue | undefined,
      occurredAt: clock.now(),
    },
  });
}
