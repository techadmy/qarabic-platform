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
  // N2 class rules (Laravel `Settings::DEFAULTS`, docs/14 §2.9; `GET/PUT /settings/sessions`).
  /** Days ahead the generator keeps classes for. */
  'sessions.horizon_days': 14,
  /** The teacher may activate from N minutes before the start … */
  'sessions.activation_window_before_min': 10,
  /** … until N minutes after the end. */
  'sessions.activation_window_after_min': 30,
  /** The teacher may undo an activation for N minutes. */
  'sessions.undo_activation_min': 10,
  /** Absent may be marked N minutes after the start. */
  'sessions.absent_min_wait_min': 25,
  /** A teacher may end a class N minutes after activation (staff earlier, with a reason). */
  'sessions.min_duration_min': 25,
  /** A teacher-recorded or auto-approved leave needs N hours' notice. */
  'sessions.leave_notice_hours': 2,
  /** A class not activated N minutes after its start is "late". */
  'sessions.late_teacher_min': 5,
  /** Report due N hours after the end (N3 uses it; the board flags `report_missing`). */
  'sessions.report_due_hours': 24,
  /** The teacher may edit a report for N hours (N3). */
  'sessions.report_edit_hours': 48,
  /** A leave class may be made up within N days. */
  'sessions.makeup_window_days': 14,
  /** Minutes the teacher needs between two classes (0 = back-to-back allowed). */
  'sessions.teacher_buffer_min': 0,
  /** D135: a reschedule N hours ahead into the teacher's hours is auto-approved (0 = never). */
  'sessions.reschedule_auto_approve_hours': 12,
  /** Zoom meetings are created N hours before a class (when Zoom is configured). */
  'zoom.create_lead_hours': 24,
} satisfies Record<string, Prisma.InputJsonValue>;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];
export type SettingsMap = { -readonly [K in SettingKey]: SettingValue<K> };

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

  /** Every setting (stored values over the defaults) in one query: for rule-heavy requests. */
  async all(): Promise<SettingsMap> {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: Object.keys(SETTING_DEFAULTS) } },
    });
    const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const row of rows) {
      const fallback = SETTING_DEFAULTS[row.key as SettingKey];
      if (
        typeof row.value === typeof fallback &&
        Array.isArray(row.value) === Array.isArray(fallback)
      ) {
        out[row.key] = row.value;
      }
    }
    return out as SettingsMap;
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
