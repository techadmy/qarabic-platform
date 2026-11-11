import { Injectable } from '@nestjs/common';
import {
  allPermissions,
  TICKET_CATEGORIES,
  TICKET_QUEUES,
  type TicketCategory,
  type TicketQueue,
} from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { WorkingHours } from './sla.js';

/** The `support.*` settings, read once per request. */
export interface SupportConfig {
  queueByCategory: Record<string, string>;
  queueMembers: Record<string, string[]>;
  restrictedQueues: string[];
  slaHours: Partial<Record<TicketQueue, number>>;
  workingHours: WorkingHours;
}

/** Who is asking: the user, their teacher record (if any) and the support settings. */
export interface SupportViewer {
  user: AuthUser;
  teacherId: number | null;
  config: SupportConfig;
}

/** The fields of a ticket the policy reads. */
export interface PolicyTicket {
  reporterId: number | null;
  visibility: 'normal' | 'restricted';
  teacherId: number | null;
  queue: TicketQueue;
}

export const has = (user: AuthUser, ...permissions: string[]): boolean =>
  permissions.some((p) => user.permissions.has(p));

const isQueue = (v: unknown): v is TicketQueue =>
  typeof v === 'string' && (TICKET_QUEUES as readonly string[]).includes(v);

/**
 * Queue routing, membership and ticket visibility (docs/32 §4–§5, D99, D135), port of Laravel
 * `SupportQueues` + `FeedbackTicketPolicy`:
 *  - a category goes to the queue of `support.queue_by_category` ("category.subcategory" wins);
 *  - `support.manage` / `feedback.review` see every queue; `support.view` the queues whose
 *    `support.queue_members` list their role; `support.handle` handles those queues;
 *  - a restricted ticket (complaints) is hidden without `support.view_restricted`, and always from
 *    the teacher it is about — whatever their permissions. The reporter always sees their own.
 * Anything not visible answers 404 (never confirms the ticket exists).
 */
export const SupportPolicy = {
  forCategory(config: SupportConfig, category: TicketCategory, sub: string | null): TicketQueue {
    const value =
      (sub ? config.queueByCategory[`${category}.${sub}`] : undefined) ??
      config.queueByCategory[category];
    return isQueue(value) ? value : 'general';
  },

  isRestricted(config: SupportConfig, queue: TicketQueue): boolean {
    return config.restrictedQueues.includes(queue);
  },

  members(config: SupportConfig, queue: TicketQueue): string[] {
    return (config.queueMembers[queue] ?? []).map(String);
  },

  /** The queues the viewer sees, in display order. */
  visibleQueues(v: Pick<SupportViewer, 'user' | 'config'>): TicketQueue[] {
    if (has(v.user, 'support.manage', 'feedback.review')) return [...TICKET_QUEUES];
    if (!has(v.user, 'support.view')) return [];
    const role = v.user.role?.name;
    return TICKET_QUEUES.filter(
      (q) => role !== undefined && SupportPolicy.members(v.config, q).includes(role),
    );
  },

  canHandle(v: Pick<SupportViewer, 'user' | 'config'>, queue: TicketQueue): boolean {
    if (has(v.user, 'support.manage', 'feedback.manage')) return true;
    const role = v.user.role?.name;
    return (
      has(v.user, 'support.handle') &&
      role !== undefined &&
      SupportPolicy.members(v.config, queue).includes(role)
    );
  },

  canSeeRestricted: (user: AuthUser) => has(user, 'support.view_restricted'),

  owns: (user: AuthUser, t: Pick<PolicyTicket, 'reporterId'>) =>
    t.reporterId !== null && t.reporterId === user.id,

  /** Hidden even though the permissions would show it (restricted rules above). */
  hiddenFrom(v: SupportViewer, t: PolicyTicket): boolean {
    if (SupportPolicy.owns(v.user, t)) return false;
    if (t.visibility !== 'restricted') return false;
    if (v.teacherId !== null && t.teacherId === v.teacherId) return true;
    return !SupportPolicy.canSeeRestricted(v.user);
  },

  canView(v: SupportViewer, t: PolicyTicket): boolean {
    if (SupportPolicy.owns(v.user, t)) return true;
    if (SupportPolicy.hiddenFrom(v, t)) return false;
    return has(v.user, 'feedback.review') || SupportPolicy.visibleQueues(v).includes(t.queue);
  },

  canManage(v: SupportViewer, t: PolicyTicket): boolean {
    if (SupportPolicy.hiddenFrom(v, t)) return false;
    return has(v.user, 'feedback.manage') || SupportPolicy.canHandle(v, t.queue);
  },

  canComment(v: SupportViewer, t: PolicyTicket): boolean {
    return (
      SupportPolicy.canManage(v, t) ||
      (SupportPolicy.owns(v.user, t) && has(v.user, 'feedback.request'))
    );
  },

  /** Staff fields and internal rows: `feedback.review` or a member of the ticket's queue. */
  isStaffView(v: SupportViewer, t: PolicyTicket): boolean {
    return has(v.user, 'feedback.review') || SupportPolicy.visibleQueues(v).includes(t.queue);
  },

  /**
   * Staff list scope: only the viewer's queues (unless `limitToQueues` is false), restricted
   * tickets only with `support.view_restricted`, and never those about the viewer as a teacher.
   */
  staffWhere(v: SupportViewer, limitToQueues = true): Prisma.TicketWhereInput {
    const and: Prisma.TicketWhereInput[] = [];
    if (limitToQueues && !has(v.user, 'support.manage', 'feedback.review')) {
      and.push({ queue: { in: SupportPolicy.visibleQueues(v) } });
    }
    if (!SupportPolicy.canSeeRestricted(v.user)) {
      and.push({ visibility: 'normal' });
    } else if (v.teacherId !== null) {
      and.push({
        OR: [{ visibility: 'normal' }, { teacherId: null }, { teacherId: { not: v.teacherId } }],
      });
    }
    return { AND: and };
  },
};

/** Builds the viewer context (teacher record + settings) and loads other users for assignment. */
@Injectable()
export class SupportContext {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async config(): Promise<SupportConfig> {
    const all = await this.settings.all();
    return {
      queueByCategory: all['support.queue_by_category'],
      queueMembers: all['support.queue_members'],
      restrictedQueues: all['support.restricted_queues'],
      slaHours: all['support.sla_hours'],
      workingHours: all['support.working_hours'],
    };
  }

  async viewer(user: AuthUser, config?: SupportConfig): Promise<SupportViewer> {
    return { user, teacherId: user.teacherId, config: config ?? (await this.config()) };
  }

  /** Another user as the services see them (role + permissions), or null. */
  async loadUser(id: number): Promise<(AuthUser & { isActive: boolean }) | null> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        teacher: { select: { id: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      locale: row.locale,
      timezone: row.timezone,
      phone: row.phone,
      isActive: row.isActive && row.archivedAt === null,
      role: row.role
        ? {
            id: row.role.id,
            name: row.role.name,
            kind: row.role.kind,
            labelAr: row.role.labelAr,
            labelEn: row.role.labelEn,
          }
        : null,
      permissions: new Set(
        row.role?.kind === 'owner'
          ? allPermissions()
          : (row.role?.permissions.map((p) => p.permission.name) ?? []),
      ),
      teacherId: row.teacher?.id ?? null,
    };
  }
}

export const isCategory = (v: unknown): v is TicketCategory =>
  typeof v === 'string' && (TICKET_CATEGORIES as readonly string[]).includes(v);
