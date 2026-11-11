import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Typed settings with defaults (port of Laravel `Settings::DEFAULTS`, docs/14 §2.9). Only the keys
 * N1 needs are ported; later milestones add theirs here. A stored row overrides the default.
 */
export const SETTING_DEFAULTS = {
  /** The academy's own zone (staff are in Egypt, D131). */
  'academy.timezone': 'Africa/Cairo',
  /** Teachers are paid in this currency (Laravel `config/payroll.php` default_currency). */
  'payroll.default_currency': 'EGP',
  /** Currencies a salary profile may use (N7); People only offers the default one. */
  'payroll.currencies': ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'AED', 'PKR', 'EGP', 'SAR'],
} satisfies Record<string, Prisma.InputJsonValue>;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    const fallback = SETTING_DEFAULTS[key];
    if (!row) return fallback;
    // A stored value of the wrong shape never breaks a caller: fall back to the default.
    return (
      typeof row.value === typeof fallback && Array.isArray(row.value) === Array.isArray(fallback)
        ? row.value
        : fallback
    ) as SettingValue<K>;
  }

  async set<K extends SettingKey>(
    key: K,
    value: SettingValue<K>,
    userId: number | null,
  ): Promise<void> {
    const json = value as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({
      where: { key },
      create: { key, value: json, updatedById: userId },
      update: { value: json, updatedById: userId },
    });
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
