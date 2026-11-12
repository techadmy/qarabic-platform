import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationCentre } from './notification-centre.js';

/**
 * Class reminders (M17; old `auto-remind-student`): N minutes before a scheduled class, one notice
 * to the teacher, and to the family only when `notifications.class_reminders_parents` is on (off by
 * default, D140). The whole job is off until `notifications.class_reminders` is switched on. One
 * reminder per class and person (`class_reminders` claim).
 */
@Injectable()
export class ClassReminderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly notices: NotificationCentre,
  ) {}

  async run(): Promise<number> {
    if (!(await this.settings.get('notifications.class_reminders'))) return 0;
    const minutes = await this.settings.get('notifications.class_reminder_minutes');
    const parents = await this.settings.get('notifications.class_reminders_parents');
    const now = this.clock.nowMs();
    const sessions = await this.prisma.classSession.findMany({
      where: {
        stage: 'scheduled',
        startsAt: { gt: new Date(now), lte: new Date(now + minutes * 60_000) },
      },
      select: {
        id: true,
        startsAt: true,
        teacher: { select: { userId: true } },
        student: { select: { name: true, family: { select: { userId: true } } } },
      },
      take: 1000,
    });
    let sent = 0;
    for (const s of sessions) {
      const wanted = [s.teacher.userId, ...(parents ? [s.student.family.userId] : [])];
      const claimed = await this.prisma.classReminder.createManyAndReturn({
        data: wanted.map((userId) => ({ sessionId: s.id, userId, sentAt: new Date(now) })),
        skipDuplicates: true,
        select: { userId: true },
      });
      if (claimed.length === 0) continue;
      sent += await this.notices.send({
        userIds: claimed.map((c) => c.userId),
        kind: 'class_reminder',
        event: 'upcoming',
        data: { sessionId: s.id, startsAt: s.startsAt.toISOString(), student: s.student.name },
        email: {
          subject: `Class reminder — تذكير بالحصة`,
          text: `${s.student.name}: ${s.startsAt.toISOString()}`,
        },
      });
    }
    return sent;
  }
}
