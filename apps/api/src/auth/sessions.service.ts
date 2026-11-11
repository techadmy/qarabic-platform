import { Injectable } from '@nestjs/common';
import { allPermissions } from '@qarabic/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth.types.js';
import { randomToken, sha256 } from './tokens.js';

export const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SHORT_TTL_MS = 12 * 60 * 60 * 1000;
/** `last_seen_at` is written at most once a minute per session. */
const TOUCH_EVERY_MS = 60_000;

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a session; returns the raw token for the cookie (only its sha256 is stored). */
  async create(
    userId: number,
    remember: boolean,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; ttlMs: number }> {
    const token = randomToken();
    const ttlMs = remember ? REMEMBER_TTL_MS : SHORT_TTL_MS;
    await this.prisma.session.create({
      data: {
        id: sha256(token),
        userId,
        expiresAt: new Date(Date.now() + ttlMs),
        ip: meta.ip?.slice(0, 45) ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      },
    });
    return { token, ttlMs };
  }

  /** The signed-in user for a cookie token, or null (unknown, expired, or inactive user). */
  async resolve(token: string): Promise<{ user: AuthUser; sessionId: string } | null> {
    if (!/^[\w-]{43}$/.test(token)) return null;
    const id = sha256(token);
    const session = await this.prisma.session.findUnique({
      where: { id },
      include: {
        user: {
          include: {
            role: {
              include: { permissions: { include: { permission: { select: { name: true } } } } },
            },
          },
        },
      },
    });
    const now = Date.now();
    if (!session) return null;
    if (session.expiresAt.getTime() <= now || !session.user.isActive) {
      await this.prisma.session.deleteMany({ where: { id } });
      return null;
    }
    if (now - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      await this.prisma.session.update({ where: { id }, data: { lastSeenAt: new Date(now) } });
    }
    const { user } = session;
    const role = user.role;
    // The owner always has every permission, including ones added after the last seed (docs/29 §1).
    const permissions = new Set<string>(
      role?.kind === 'owner'
        ? allPermissions()
        : (role?.permissions.map((p) => p.permission.name) ?? []),
    );
    return {
      sessionId: id,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        locale: user.locale,
        timezone: user.timezone,
        role: role ? { id: role.id, name: role.name, kind: role.kind } : null,
        permissions,
      },
    };
  }

  async destroy(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  async destroyToken(token: string): Promise<void> {
    await this.destroy(sha256(token));
  }

  async destroyAllFor(userId: number): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }
}
