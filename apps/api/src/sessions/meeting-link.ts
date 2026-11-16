import type { SessionLinkSource } from '@qarabic/shared';
import type { Crypto } from '../common/crypto.js';
import type { PrismaService } from '../prisma/prisma.service.js';

interface LinkRow {
  teacherId: number;
  stage: string;
  deletedAt: Date | null;
  zoomStatus: string;
  zoomJoinUrl: string | null;
}

const NO_LINK_STAGES = ['cancelled', 'moved_out'];

/**
 * D151: where a class's link comes from. A meeting the academy made (`ready`) or the enrollment's
 * fixed link (`external`) wins; otherwise the class uses its teacher's personal Zoom link, read
 * now (so a new link, or a new teacher on the class, applies without touching the class rows).
 */
export function linkSourceOf(s: LinkRow, teacherHasLink: boolean): SessionLinkSource {
  if (s.deletedAt || NO_LINK_STAGES.includes(s.stage)) return 'none';
  if (s.zoomStatus === 'ready') return s.zoomJoinUrl ? 'meeting' : 'none';
  if (s.zoomStatus === 'external') return s.zoomJoinUrl ? 'external' : 'none';
  if (s.zoomStatus === 'deleted') return 'none';
  return teacherHasLink ? 'teacher' : 'missing';
}

/** Teachers (of `ids`) who have a personal Zoom link. */
export async function teachersWithLink(prisma: PrismaService, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await prisma.teacher.findMany({
    where: { id: { in: ids }, zoomJoinUrl: { not: null } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** The class's link, decrypted (null when it has none). Callers check the join windows. */
export async function meetingLinkOf(
  prisma: PrismaService,
  crypto: Crypto,
  s: LinkRow,
): Promise<{ source: SessionLinkSource; url: string | null }> {
  const teacher = await prisma.teacher.findUnique({
    where: { id: s.teacherId },
    select: { zoomJoinUrl: true },
  });
  const source = linkSourceOf(s, !!teacher?.zoomJoinUrl);
  const stored = source === 'meeting' || source === 'external' ? s.zoomJoinUrl : null;
  const url =
    source === 'teacher' ? crypto.tryDecrypt(teacher?.zoomJoinUrl) : crypto.tryDecrypt(stored);
  return { source: url ? source : source === 'teacher' ? 'missing' : source, url };
}
