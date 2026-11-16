import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  type ZoomAccountHostsDto,
  type ZoomHostsSyncResultDto,
  zoomMeetingIdOf,
} from '@qarabic/shared';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { Clock } from '../common/clock.js';
import { Crypto } from '../common/crypto.js';
import { ApiException, conflict, notFound, validationError } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import { saveTeacherZoomLink } from '../people/teacher-zoom-link.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ZoomApi } from './zoom.api.js';
import { ZoomConfig } from './zoom.config.js';

const PLACEHOLDER = 'teacher-link:';
const unavailable = (message: string) =>
  new ApiException(HttpStatus.SERVICE_UNAVAILABLE, { message, code: 'zoom_unavailable' });

/**
 * D151 (b): the Zoom account's licensed users as the host pool. A daily job (and «sync now») reads
 * them from Zoom (active, type licensed: id, email, name, PMI, personal meeting link) and upserts
 * them by Zoom user id; users Zoom no longer lists are kept but marked inactive. Staff assign one
 * host per teacher, which sets the teacher's link and PMI. Off (`enabled: false`) without the app.
 */
@Injectable()
export class ZoomAccountHosts implements OnApplicationBootstrap {
  private readonly logger = new Logger(ZoomAccountHosts.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: ZoomConfig,
    private readonly api: ZoomApi,
    private readonly crypto: Crypto,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const job = CronJob.from({
      cronTime: '0 20 3 * * *',
      onTick: () => {
        if (!this.config.enabled) return;
        this.sync().catch((e: unknown) => this.logger.error('zoom:hosts-sync failed', e as Error));
      },
    });
    this.registry.addCronJob('zoom:hosts-sync', job);
    job.start();
  }

  async list(): Promise<ZoomAccountHostsDto> {
    if (!this.config.enabled) return { enabled: false };
    const rows = await this.prisma.zoomHost.findMany({
      where: { lastSyncedAt: { not: null } },
      include: { teacher: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: [{ isActive: 'desc' }, { email: 'asc' }],
    });
    const last = rows.reduce<Date | null>(
      (m, r) => (r.lastSyncedAt && (!m || r.lastSyncedAt > m) ? r.lastSyncedAt : m),
      null,
    );
    return {
      enabled: true,
      lastSyncedAt: last?.toISOString() ?? null,
      hosts: rows.map((r) => ({
        id: r.id,
        zoomUserId: r.zoomUserId,
        email: r.email,
        displayName: r.displayName,
        pmiMeetingId: r.pmiMeetingId,
        licenseType: r.licenseType,
        isActive: r.isActive,
        lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
        teacher: r.teacher
          ? {
              id: r.teacher.id,
              name: [r.teacher.firstName, r.teacher.lastName].filter(Boolean).join(' '),
            }
          : null,
      })),
    };
  }

  async sync(): Promise<ZoomHostsSyncResultDto> {
    if (!this.config.enabled) throw unavailable('Zoom is not connected.');
    let users;
    try {
      users = await this.api.licensedUsers();
    } catch {
      throw unavailable('Zoom could not be reached. Try again.');
    }
    const now = this.clock.now();
    const conflicts: ZoomHostsSyncResultDto['conflicts'] = [];
    for (const u of users) {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.zoomHost.findUnique({ where: { zoomUserId: u.id } });
        let pmi = u.pmi;
        let teacherId = existing?.teacherId ?? null;
        if (pmi) {
          const holder = await tx.zoomHost.findFirst({
            where: { pmiMeetingId: pmi, NOT: { zoomUserId: u.id } },
          });
          const owner = await tx.teacher.findFirst({ where: { zoomMeetingId: pmi } });
          // A teacher typed this user's link by hand: the synced host takes over their placeholder.
          const adopt =
            owner &&
            (teacherId === null || teacherId === owner.id) &&
            (!holder ||
              (holder.teacherId === owner.id && holder.zoomUserId.startsWith(PLACEHOLDER)));
          if (adopt) {
            if (holder) await tx.zoomHost.delete({ where: { id: holder.id } });
            teacherId = owner.id;
          } else if (holder || (owner && owner.id !== teacherId)) {
            conflicts.push({ email: u.email, pmiMeetingId: pmi });
            pmi = null;
          }
        }
        const url = u.personalMeetingUrl ?? (pmi ? `https://zoom.us/j/${pmi}` : null);
        const data = {
          email: u.email,
          displayName: u.displayName,
          pmiMeetingId: pmi,
          joinUrl: this.crypto.encryptOrNull(url),
          licenseType: 'licensed',
          lastSyncedAt: now,
          isActive: true,
          teacherId,
        };
        const host = existing
          ? await tx.zoomHost.update({ where: { id: existing.id }, data })
          : await tx.zoomHost.create({ data: { zoomUserId: u.id, ...data } });
        // An assigned teacher follows a new link or PMI from Zoom.
        if (host.teacherId && url && pmi && zoomMeetingIdOf(url) === pmi) {
          const t = await tx.teacher.findUniqueOrThrow({
            where: { id: host.teacherId },
            include: { user: { select: { email: true } } },
          });
          if (this.crypto.tryDecrypt(t.zoomJoinUrl) !== url) {
            await saveTeacherZoomLink(
              tx,
              this.crypto,
              { id: t.id, zoomMeetingId: t.zoomMeetingId, email: t.user.email },
              url,
            );
          }
        }
      });
    }
    const gone = await this.prisma.zoomHost.updateMany({
      where: {
        lastSyncedAt: { not: null },
        isActive: true,
        zoomUserId: { notIn: users.map((u) => u.id) },
      },
      data: { isActive: false, licenseType: null },
    });
    return {
      synced: users.length,
      deactivated: gone.count,
      conflicts,
      lastSyncedAt: now.toISOString(),
    };
  }

  /** Assigns a synced host to a teacher (their link and PMI follow), or frees it (`null`). */
  async assign(hostId: number, teacherId: number | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM zoom_hosts WHERE id = ${hostId} FOR UPDATE`;
      const host = await tx.zoomHost.findUnique({ where: { id: hostId } });
      if (!host || host.lastSyncedAt === null) throw notFound();

      if (teacherId === null) {
        if (!host.teacherId) return;
        const t = await tx.teacher.findUniqueOrThrow({ where: { id: host.teacherId } });
        await tx.zoomHost.update({ where: { id: host.id }, data: { teacherId: null } });
        if (t.zoomMeetingId && t.zoomMeetingId === host.pmiMeetingId) {
          await tx.teacher.update({
            where: { id: t.id },
            data: { zoomJoinUrl: null, zoomMeetingId: null },
          });
        }
        return;
      }

      const teacher = await tx.teacher.findUnique({
        where: { id: teacherId },
        include: { user: { select: { email: true } } },
      });
      if (!teacher || teacher.archivedAt) {
        throw validationError({ teacherId: ['The selected teacher is invalid.'] });
      }
      if (!host.isActive) throw conflict('zoom_host_inactive');
      if (host.teacherId && host.teacherId !== teacherId) throw conflict('zoom_host_taken');
      const url =
        this.crypto.tryDecrypt(host.joinUrl) ??
        (host.pmiMeetingId ? `https://zoom.us/j/${host.pmiMeetingId}` : null);
      if (!url || !zoomMeetingIdOf(url)) {
        throw validationError({ teacherId: ['This Zoom user has no personal meeting link.'] });
      }
      // One host per teacher: their hand-typed placeholder goes, any other host is freed.
      await tx.zoomHost.deleteMany({
        where: { teacherId, zoomUserId: { startsWith: PLACEHOLDER } },
      });
      await tx.zoomHost.updateMany({
        where: { teacherId, NOT: { id: host.id } },
        data: { teacherId: null },
      });
      await tx.zoomHost.update({ where: { id: host.id }, data: { teacherId } });
      await saveTeacherZoomLink(
        tx,
        this.crypto,
        { id: teacher.id, zoomMeetingId: teacher.zoomMeetingId, email: teacher.user.email },
        url,
      );
    });
  }
}
