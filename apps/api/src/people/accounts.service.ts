import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PasswordsService } from '../auth/passwords.service.js';
import { invalid, type Tx } from './people.common.js';

/**
 * Logins made by the People screens. A new parent, teacher or staff account gets a random
 * password that is never shown or returned; they choose their own with «نسيت كلمة المرور» (D126).
 */
@Injectable()
export class AccountsService {
  constructor(private readonly passwords: PasswordsService) {}

  async create(
    tx: Tx,
    data: {
      roleName: string;
      name: string;
      email: string;
      phone: string;
      timezone?: string | null;
    },
  ): Promise<{ id: number }> {
    const role = await tx.role.findUnique({ where: { name: data.roleName } });
    if (!role) throw invalid('role');
    const passwordHash = await this.passwords.hash(randomBytes(32).toString('base64url'));
    return tx.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        passwordHash,
        roleId: role.id,
        isActive: true,
        ...(data.timezone ? { timezone: data.timezone } : {}),
      },
      select: { id: true },
    });
  }

  /** Closes the login and signs the person out everywhere (deactivation, archive). */
  async closeLogin(tx: Tx, userId: number): Promise<void> {
    await tx.user.update({ where: { id: userId }, data: { isActive: false } });
    await tx.session.deleteMany({ where: { userId } });
  }
}
