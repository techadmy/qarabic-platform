import { zoomMeetingIdOf } from '@qarabic/shared';
import type { Crypto } from '../common/crypto.js';
import { conflict } from '../common/errors.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Tx } from './people.common.js';

/**
 * D151: saves the teacher's personal Zoom link (encrypted) and its meeting id, and keeps the
 * teacher's Zoom host PMI (Z1 attendance) in sync:
 * - a host synced from the Zoom account with that PMI and no teacher is assigned to them;
 * - a synced host of theirs with another PMI is freed (its PMI is Zoom's, never rewritten);
 * - otherwise their hand-made host row is updated, or one is created for them.
 * Another teacher's link, or a host of someone else → 409 `zoom_link_taken`.
 */
export async function saveTeacherZoomLink(
  tx: Tx,
  crypto: Crypto,
  teacher: { id: number; zoomMeetingId: string | null; email: string },
  url: string | null,
): Promise<void> {
  const meetingId = zoomMeetingIdOf(url);
  if (meetingId) {
    const other = await tx.zoomHost.findFirst({
      where: { pmiMeetingId: meetingId, NOT: { teacherId: teacher.id } },
    });
    const taken = await tx.teacher.findFirst({
      where: { zoomMeetingId: meetingId, NOT: { id: teacher.id } },
      select: { id: true },
    });
    if (taken) throw conflict('zoom_link_taken');
    if (other) {
      if (other.lastSyncedAt === null || other.teacherId !== null || !other.isActive) {
        throw conflict('zoom_link_taken');
      }
      await tx.zoomHost.update({ where: { id: other.id }, data: { teacherId: teacher.id } });
    }
  }
  await tx.teacher.update({
    where: { id: teacher.id },
    data: { zoomJoinUrl: crypto.encryptOrNull(url), zoomMeetingId: meetingId },
  });

  const hosts = await tx.zoomHost.findMany({
    where: { teacherId: teacher.id },
    orderBy: { id: 'asc' },
  });
  const synced = hosts.filter((h) => h.lastSyncedAt !== null);
  for (const h of synced) {
    if (h.pmiMeetingId !== meetingId) {
      await tx.zoomHost.update({ where: { id: h.id }, data: { teacherId: null } });
    }
  }
  const manual = hosts.filter((h) => h.lastSyncedAt === null);
  if (synced.some((h) => meetingId && h.pmiMeetingId === meetingId)) {
    // The Zoom user carries the PMI: hand-made rows of this teacher keep none.
    for (const h of manual) {
      if (h.pmiMeetingId) {
        await tx.zoomHost.update({ where: { id: h.id }, data: { pmiMeetingId: null } });
      }
    }
    return;
  }
  // The hand-made host that carries the old meeting id (else the teacher's first one).
  const own = manual.find((h) => h.pmiMeetingId === teacher.zoomMeetingId) ?? manual[0];
  if (own) {
    if (own.pmiMeetingId !== meetingId) {
      await tx.zoomHost.update({ where: { id: own.id }, data: { pmiMeetingId: meetingId } });
    }
  } else if (meetingId) {
    // No Zoom user is known yet: a placeholder id until the account sync or staff map the real one.
    await tx.zoomHost.create({
      data: {
        zoomUserId: `teacher-link:${teacher.id}`,
        email: teacher.email,
        label: "From the teacher's Zoom link (D151)",
        teacherId: teacher.id,
        pmiMeetingId: meetingId,
      },
    });
  }
}

/** A unique-index race on the meeting id ends as the same 409. */
export function rethrowZoomLinkTaken(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    /zoom_meeting_id|zoomMeetingId|pmi/i.test(JSON.stringify(error.meta ?? {}))
  ) {
    throw conflict('zoom_link_taken');
  }
  throw error;
}
