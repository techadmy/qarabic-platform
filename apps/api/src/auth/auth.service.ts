import { Inject, Injectable } from '@nestjs/common';
import type { forgotPasswordSchema, loginSchema, Me, resetPasswordSchema } from '@qarabic/shared';
import type { z } from 'zod';
import { validationError } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth.types.js';
import { PasswordsService } from './passwords.service.js';
import { SessionsService } from './sessions.service.js';
import { randomToken, sha256 } from './tokens.js';

export const RESET_TTL_MS = 60 * 60 * 1000;

/** One message for unknown email, wrong password and inactive account: no account enumeration. */
const invalidCredentials = () =>
  validationError(
    { email: ['These credentials do not match our records.'] },
    'These credentials do not match our records.',
    'invalid_credentials',
  );

const invalidResetToken = () =>
  validationError(
    { token: ['This password reset link is invalid or has expired.'] },
    'This password reset link is invalid or has expired.',
    'invalid_reset_token',
  );

export function toMe(user: AuthUser): Me {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    locale: user.locale,
    timezone: user.timezone,
    phone: user.phone,
    role: user.role
      ? {
          name: user.role.name,
          labelAr: user.role.labelAr,
          labelEn: user.role.labelEn,
          kind: user.role.kind,
        }
      : null,
    roles: user.role ? [user.role.name] : [],
    permissions: [...user.permissions].sort(),
    teacherId: user.teacherId,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordsService,
    private readonly sessions: SessionsService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async login(
    input: z.output<typeof loginSchema>,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; ttlMs: number; remember: boolean }> {
    const user = await this.findByEmail(input.email);
    const ok = await this.passwords.verify(user?.passwordHash ?? null, input.password);
    if (!user || !ok || !user.isActive || user.archivedAt) throw invalidCredentials();

    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await this.passwords.hash(input.password) },
      });
    }
    const { token, ttlMs } = await this.sessions.create(user.id, input.remember, meta);
    return { token, ttlMs, remember: input.remember };
  }

  /** Always resolves the same way; a mail goes out only for an existing, active account. */
  async forgotPassword(input: z.output<typeof forgotPasswordSchema>): Promise<void> {
    const user = await this.findByEmail(input.email);
    if (!user?.isActive || user.archivedAt) return;
    const token = randomToken();
    const now = Date.now();
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          createdAt: new Date(now),
          expiresAt: new Date(now + RESET_TTL_MS),
        },
      }),
    ]);
    const link = new URL('/reset-password', this.env.APP_URL);
    link.searchParams.set('token', token);
    await this.mailer.send({
      kind: 'password_reset',
      to: user.email,
      subject: 'Reset your Qarabic password',
      text: `Use this link within 60 minutes to choose a new password:\n${link.toString()}\n\nIf you did not ask for this, ignore this message.`,
    });
  }

  /** Emails are stored lower-case; the lookup is case-insensitive for rows carried over in N8. */
  private findByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      orderBy: { id: 'asc' },
    });
  }

  /** Single use, 60 minutes. Signs the user out everywhere. */
  async resetPassword(input: z.output<typeof resetPasswordSchema>): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(input.token) },
      include: { user: { select: { isActive: true } } },
    });
    if (
      !record ||
      record.usedAt ||
      record.expiresAt.getTime() <= Date.now() ||
      !record.user.isActive
    ) {
      throw invalidResetToken();
    }
    const passwordHash = await this.passwords.hash(input.password);
    // Claim the token atomically so two parallel requests cannot both use it.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (count === 0) return false;
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: record.userId } });
      return true;
    });
    if (!claimed) throw invalidResetToken();
  }
}
