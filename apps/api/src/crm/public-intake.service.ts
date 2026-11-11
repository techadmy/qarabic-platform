import { HttpStatus, Injectable } from '@nestjs/common';
import type { publicTrialRequestSchema, referralSchema, wpformsLeadSchema } from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { validationError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isValidZone } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { CrmConfig } from './crm.config.js';
import { crmError } from './errors.js';
import { LeadService } from './lead.service.js';
import type { LeadChild } from './lead.types.js';
import { LeadNotifier } from './notifier.js';
import { WebLeadMapper } from './web-lead-mapper.js';

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const cut = (v: string, max: number) => [...v].slice(0, max).join('');
const orNull = (v: string | null, max: number) => (v ? cut(v, max) : null);

/**
 * The public intake routes (Laravel `TrialRequestController`, `WebLeadWebhookController`,
 * `ClassRequestController::store`, `ReferralController`). Every one answers the same way for a
 * new, merged or spam submission, so a form learns nothing about other families.
 */
@Injectable()
export class PublicIntake {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly leads: LeadService,
    private readonly mapper: WebLeadMapper,
    private readonly notifier: LeadNotifier,
    private readonly config: CrmConfig,
  ) {}

  /** The app's free-trial form (`/trial`, docs/33 §3.1). */
  async trialRequest(data: z.output<typeof publicTrialRequestSchema>, ip: string): Promise<void> {
    const courseIds = [...new Set(data.children.map((c) => c.courseId))];
    const courses = await this.prisma.course.findMany({
      where: { id: { in: courseIds } },
      select: { id: true, nameEn: true },
    });
    const byId = new Map(courses.map((c) => [c.id, c.nameEn]));
    const missing = data.children.flatMap((c, i) =>
      byId.has(c.courseId) ? [] : [[`children.${i}.courseId`, ['The selected course is invalid.']]],
    );
    if (missing.length) {
      throw validationError(Object.fromEntries(missing) as Record<string, string[]>);
    }
    const days = [...new Set(data.preferredDays)].sort((a, b) => a - b);
    const periods = [...new Set(data.preferredPeriods)];
    const note = data.preferredNote?.trim() || null;
    const summary =
      `${days.map((d) => DAY_NAMES[d]).join(', ')} · ${periods.join(', ')}` +
      (note ? ` · ${note}` : '');
    const interest = [...new Set(courseIds.map((id) => byId.get(id)!))].join(', ');
    const utm = Object.fromEntries(
      Object.entries(data.utm ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''),
    ) as Record<string, string>;

    const { lead } = await this.leads.intake(
      {
        parentName: data.parentName,
        email: data.email,
        phone: data.phone,
        countryCode: data.countryCode,
        timezone: data.timezone,
        preferredLanguage: data.locale ?? null,
        children: data.children.map((c) => ({
          name: c.name,
          age: c.age,
          gender: c.gender,
          courseId: c.courseId,
        })),
        courseInterest: cut(interest, 120) || null,
        preferredTimes: cut(summary, 500),
        preferredSchedule: { days, periods, ...(note ? { note } : {}) },
        teacherGenderPref: data.teacherGenderPref,
        heardFrom: data.heardFrom ?? null,
        message: data.message ?? null,
        utm: Object.keys(utm).length ? utm : null,
        site: 'app_trial',
        source: 'web_form',
      },
      ip,
    );
    const s = await this.settings.all();
    if (lead && lead.status !== 'spam' && s['crm.trial_form_confirmation']) {
      await this.notifier.confirmTrialRequest(data.email, data.parentName, data.locale ?? 'ar');
    }
  }

  /** The website's WPForms entry (signed; the controller checked the signature). */
  async webLead(
    payload: z.output<typeof wpformsLeadSchema>,
    ip: string,
  ): Promise<{ duplicate: boolean }> {
    if (!this.config.wpformsFormIds.includes(payload.form_id)) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'unknown_form');
    }
    const result = await this.leads.intake(await this.mapper.fromWpforms(payload), ip);
    if (result.duplicate) return { duplicate: true };
    const s = await this.settings.all();
    const lead = result.lead;
    if (lead && lead.status !== 'spam' && lead.email && s['crm.web_lead_confirmation']) {
      await this.notifier.confirmTrialRequest(lead.email, lead.parentName, 'en');
    }
    return { duplicate: false };
  }

  /**
   * The old public "book a free class" form (`POST /api/class-request`, D105): same URL and
   * field names as the developer's endpoint, so an old form keeps working after cut-over.
   */
  async classRequest(input: Record<string, unknown>, ip: string): Promise<void> {
    const str = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = input[k];
        if (typeof v === 'string' && v.trim() !== '') return v.trim();
      }
      return null;
    };
    const name = str('Name', 'parent_name', 'name');
    if (!name) return;
    const age = str('Age', 'age');
    const gender = (str('Gender', 'gender') ?? '').toLowerCase();
    let children: LeadChild[];
    if (Array.isArray(input.children) && input.children.length) {
      children = input.children.slice(0, 10).map((c: unknown) => {
        const r = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
        const out: LeadChild = {};
        if (typeof r.name === 'string' && r.name.trim()) out.name = cut(r.name.trim(), 80);
        if (
          (typeof r.age === 'number' || typeof r.age === 'string') &&
          /^\d{1,2}$/.test(String(r.age))
        ) {
          out.age = Number(r.age);
        }
        if (r.gender === 'male' || r.gender === 'female') out.gender = r.gender;
        return out;
      });
    } else {
      const child: LeadChild = {};
      if (age && /^\d+(\.\d+)?$/.test(age))
        child.age = Math.max(2, Math.min(99, Math.trunc(Number(age))));
      if (gender === 'male' || gender === 'female') child.gender = gender;
      children = [child];
    }
    const country = str('Country', 'country', 'country_code');
    const timezone = str('timezone');
    const email = str('Email', 'email');
    const phone = str('Phone', 'phone');
    const utm = Object.fromEntries(
      Object.entries({
        source: str('utm_source') ?? str('Lead Source', 'lead_source'),
        medium: str('utm_medium'),
        campaign: str('utm_campaign'),
      }).filter(([, v]) => v),
    ) as Record<string, string>;
    const ref = input.referral_id;
    const referral =
      (typeof ref === 'number' || (typeof ref === 'string' && /^\d{1,9}$/.test(ref))) &&
      (await this.prisma.family.findUnique({ where: { id: Number(ref) }, select: { id: true } }))
        ? Number(ref)
        : null;
    await this.leads.intake(
      {
        parentName: cut(name, 120),
        email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? cut(email, 190) : null,
        phone: phone ? cut(phone, 40) : null,
        countryCode: country && /^[A-Za-z]{2}$/.test(country) ? country : null,
        city: country && !/^[A-Za-z]{2}$/.test(country) ? cut(country, 80) : null,
        timezone: timezone && isValidZone(timezone) ? timezone : null,
        courseInterest: orNull(str('Course', 'course'), 120),
        preferredTimes: orNull(str('Date', 'date', 'preferred_times'), 500),
        message: orNull(str('Notes', 'notes', 'message'), 5000),
        site: orNull(str('site'), 40),
        children,
        utm: Object.keys(utm).length ? utm : null,
        source: 'web_form',
        referralFamilyId: referral,
      },
      ip,
    );
  }

  /** A parent recommends a friend (docs/26 §5.6): a referral lead linked to their family. */
  async referral(
    input: z.output<typeof referralSchema>,
    actor: AuthUser,
    ip: string,
  ): Promise<void> {
    const family = await this.prisma.family.findUnique({
      where: { userId: actor.id },
      select: { id: true },
    });
    if (!family) throw crmError(HttpStatus.FORBIDDEN, 'forbidden');
    const count = input.childrenCount ?? 1;
    await this.leads.intake(
      {
        parentName: input.parentName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        countryCode: input.countryCode ?? null,
        message: input.message ?? null,
        children: Array.from({ length: count }, () => ({})),
        source: 'referral',
        referralFamilyId: family.id,
      },
      ip,
    );
  }
}
