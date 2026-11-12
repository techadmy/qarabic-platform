import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import {
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_KINDS,
  type NotificationChannel,
  type NotificationKind,
  type NotificationPreferenceDto,
} from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import { PushGateway } from '../common/push.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

export interface Notice {
  userIds: readonly number[];
  kind: NotificationKind;
  event: string;
  /** Stored on the in-app row (never contact details). */
  data: Record<string, unknown>;
  /** The email, when the person's preference and the academy allow it. */
  email?: { subject: string; text: string };
  /** The phone push; defaults to the email subject and first line (docs/17 §5). */
  push?: { title: string; body: string };
}

type Prefs = Record<'inApp' | 'email' | 'push' | 'whatsapp', boolean>;

const DEFAULT_PREFS: Prefs = {
  inApp: NOTIFICATION_DEFAULTS.in_app,
  email: NOTIFICATION_DEFAULTS.email,
  push: NOTIFICATION_DEFAULTS.push,
  whatsapp: NOTIFICATION_DEFAULTS.whatsapp,
};

/**
 * The notification centre (M17): one entry point for in-app (the bell), email and WhatsApp, by the
 * person's preference per kind and the academy switches (`notifications.email_enabled`,
 * `notifications.whatsapp_enabled`, `notifications.push_enabled`). WhatsApp has no transport until
 * B50: it is off and skipped. Push goes to the person's registered phones through `PUSH_DRIVER`
 * (`none` by default); tokens the push service reports gone are forgotten.
 * Email goes through the app mailer (in memory until SMTP, B31). Never throws: the change that
 * caused the notice is already saved.
 */
@Injectable()
export class NotificationCentre {
  private readonly logger = new Logger(NotificationCentre.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly push: PushGateway,
  ) {}

  async channels(): Promise<Record<NotificationChannel, boolean>> {
    return {
      in_app: true,
      email: await this.settings.get('notifications.email_enabled'),
      push: this.push.driver !== 'none' && (await this.settings.get('notifications.push_enabled')),
      whatsapp: await this.settings.get('notifications.whatsapp_enabled'),
    };
  }

  async preferences(userId: number): Promise<NotificationPreferenceDto[]> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const byKind = new Map(rows.map((r) => [r.kind, r]));
    return NOTIFICATION_KINDS.map((kind) => {
      const r = byKind.get(kind);
      return {
        kind,
        inApp: r?.inApp ?? DEFAULT_PREFS.inApp,
        email: r?.email ?? DEFAULT_PREFS.email,
        push: r?.push ?? DEFAULT_PREFS.push,
        whatsapp: r?.whatsapp ?? DEFAULT_PREFS.whatsapp,
      };
    });
  }

  async savePreferences(userId: number, prefs: NotificationPreferenceDto[]): Promise<void> {
    await this.prisma.$transaction(
      prefs.map((p) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_kind: { userId, kind: p.kind } },
          create: {
            userId,
            kind: p.kind,
            inApp: p.inApp,
            email: p.email,
            push: p.push,
            whatsapp: p.whatsapp,
          },
          update: { inApp: p.inApp, email: p.email, push: p.push, whatsapp: p.whatsapp },
        }),
      ),
    );
  }

  /** Delivers a notice; returns how many people got the in-app row. */
  async send(notice: Notice): Promise<number> {
    const ids = [...new Set(notice.userIds)];
    if (ids.length === 0) return 0;
    try {
      const [users, prefs, channels] = await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: ids }, isActive: true, archivedAt: null },
          select: { id: true, email: true },
        }),
        this.prisma.notificationPreference.findMany({
          where: { userId: { in: ids }, kind: notice.kind },
        }),
        this.channels(),
      ]);
      const pref = new Map(prefs.map((p) => [p.userId, p]));
      const now = this.clock.now();
      const inApp = users.filter((u) => pref.get(u.id)?.inApp ?? DEFAULT_PREFS.inApp);
      if (inApp.length) {
        await this.prisma.notification.createMany({
          data: inApp.map((u) => ({
            userId: u.id,
            kind: notice.kind,
            event: notice.event,
            data: {
              kind: notice.kind,
              event: notice.event,
              ...notice.data,
            },
            createdAt: now,
          })),
        });
      }
      if (notice.email && channels.email) {
        for (const u of users) {
          if (!(pref.get(u.id)?.email ?? DEFAULT_PREFS.email)) continue;
          try {
            await this.mailer.send({
              kind: `${notice.kind}_${notice.event}`,
              to: u.email,
              subject: notice.email.subject,
              text: notice.email.text,
            });
          } catch (error) {
            this.logger.error(`Email not sent (${notice.kind}): ${(error as Error).message}`);
          }
        }
      }
      if (channels.push) {
        await this.sendPush(
          notice,
          users.filter((u) => pref.get(u.id)?.push ?? DEFAULT_PREFS.push).map((u) => u.id),
        );
      }
      if (channels.whatsapp && users.some((u) => pref.get(u.id)?.whatsapp)) {
        this.logger.warn('WhatsApp notices are switched on but have no transport yet (B50).');
      }
      return inApp.length;
    } catch (error) {
      this.logger.error(`Notice not delivered (${notice.kind}): ${(error as Error).message}`);
      return 0;
    }
  }

  private async sendPush(notice: Notice, userIds: number[]): Promise<void> {
    if (userIds.length === 0) return;
    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    });
    if (devices.length === 0) return;
    const label = NOTIFICATION_KIND_LABELS[notice.kind];
    const title = (
      notice.push?.title ??
      notice.email?.subject ??
      `${label.ar} — ${label.en}`
    ).slice(0, 120);
    const body = (notice.push?.body ?? notice.email?.text.split('\n')[0] ?? '').slice(0, 240);
    // Only ids travel in the push payload: the app loads the details through the API.
    const data: Record<string, string> = { kind: notice.kind, event: notice.event };
    for (const [k, v] of Object.entries(notice.data)) {
      if (k.endsWith('Id') && (typeof v === 'number' || typeof v === 'string')) data[k] = String(v);
    }
    const results = await this.push.send(
      devices.map((d) => ({ token: d.token, title, body, data })),
    );
    const gone = results.filter((r) => r.invalid).map((r) => r.token);
    if (gone.length) await this.prisma.deviceToken.deleteMany({ where: { token: { in: gone } } });
  }
}

@Global()
@Module({ providers: [NotificationCentre], exports: [NotificationCentre] })
export class NotificationCentreModule {}
