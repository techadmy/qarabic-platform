import { asText, camelizeJson, int, json, oneOf, type Row, str, text, zoneOr } from '../convert.js';
import { batch, type MapContext, type ModuleMapper, type TargetBatch } from '../plan.js';
import { fit, stamps, t } from './people.js';

const STATUSES = [
  'new',
  'contacted',
  'trial_scheduled',
  'trial_done',
  'converted',
  'lost',
  'spam',
  'job_applicant',
] as const;
const SOURCES = ['web_form', 'phone', 'whatsapp', 'walk_in', 'referral', 'other'] as const;
const ACTIVITY = [
  'note',
  'call',
  'whatsapp',
  'email',
  'status_changed',
  'assigned',
  'account_created',
  'trial_booked',
  'trial_cancelled',
  'trial_outcome',
  'converted',
  'resubmitted',
  'created',
] as const;

export const crmMapper: ModuleMapper = {
  name: 'crm',
  sources: ['leads', 'lead_activities', 'notifications', 'class_requests'],
  dependsOn: ['people'],
  tables: ['leads', 'lead_activities', 'notifications'],
  map(ctx: MapContext): TargetBatch[] {
    const out: TargetBatch[] = [];
    const leads: Row[] = [];
    const refs = new Set<string>();
    for (const r of ctx.rows('leads')) {
      const id = int(r, 'id')!;
      if (t(ctx, r.deleted_at)) {
        ctx.report.skip('leads', id, 'soft-deleted lead (the new schema keeps no deleted leads)');
        continue;
      }
      let status = oneOf(str(r, 'status'), STATUSES);
      if (!status) {
        ctx.report.change('leads', id, `status "${str(r, 'status')}" unknown: new`);
        status = 'new';
      }
      let source = oneOf(str(r, 'source'), SOURCES);
      if (!source) {
        ctx.report.change('leads', id, `source "${str(r, 'source')}" unknown: other`);
        source = 'other';
      }
      let externalRef = fit(ctx, 'leads', id, 'external_ref', text(r, 'external_ref'), 100);
      if (externalRef && refs.has(externalRef)) {
        ctx.report.change('leads', id, `external_ref ${externalRef} repeats: cleared`);
        externalRef = null;
      }
      if (externalRef) refs.add(externalRef);
      const { createdAt, updatedAt } = stamps(ctx, r);
      const statusChangedAt = t(ctx, r.status_changed_at) ?? createdAt;
      const children = camelizeJson(json(r, 'children'));
      leads.push({
        id,
        status,
        source,
        site: fit(ctx, 'leads', id, 'site', text(r, 'site'), 40),
        parentName: fit(ctx, 'leads', id, 'parent_name', text(r, 'parent_name') ?? '-', 120),
        email: fit(ctx, 'leads', id, 'email', text(r, 'email'), 190),
        phone: fit(ctx, 'leads', id, 'phone', text(r, 'phone'), 40),
        phoneDigits: (text(r, 'phone_digits') ?? '').slice(-15) || null,
        countryCode: text(r, 'country_code')?.toUpperCase() ?? null,
        city: fit(ctx, 'leads', id, 'city', text(r, 'city'), 80),
        timezone: zoneOr(text(r, 'timezone'), 'Africa/Cairo'),
        preferredLanguage: fit(
          ctx,
          'leads',
          id,
          'preferred_language',
          text(r, 'preferred_language'),
          8,
        ),
        children: Array.isArray(children) ? children : [],
        courseInterest: fit(ctx, 'leads', id, 'course_interest', text(r, 'course_interest'), 120),
        preferredTimes: fit(ctx, 'leads', id, 'preferred_times', text(r, 'preferred_times'), 500),
        preferredSchedule: camelizeJson(json(r, 'preferred_schedule')) ?? undefined,
        teacherGenderPref: fit(
          ctx,
          'leads',
          id,
          'teacher_gender_pref',
          text(r, 'teacher_gender_pref'),
          8,
        ),
        heardFrom: fit(ctx, 'leads', id, 'heard_from', text(r, 'heard_from'), 16),
        message: text(r, 'message'),
        utm: json(r, 'utm') ?? undefined,
        externalRef,
        referralFamilyId: ctx.ref(
          'families',
          int(r, 'referral_family_id'),
          'leads',
          id,
          'referral_family_id',
        ),
        familyId: ctx.ref('families', int(r, 'family_id'), 'leads', id, 'family_id'),
        assignedToId: ctx.has('users', int(r, 'assigned_to')) ? int(r, 'assigned_to') : null,
        assignedAt: t(ctx, r.assigned_at),
        autoAssignedAt: t(ctx, r.auto_assigned_at),
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        nextFollowUpAt: t(ctx, r.next_follow_up_at),
        followUpNotifiedFor: t(ctx, r.follow_up_notified_for),
        lastContactedAt: t(ctx, r.last_contacted_at),
        firstResponseAt: t(ctx, r.first_response_at),
        slaNotifiedAt: t(ctx, r.sla_notified_at),
        contactAttempts: int(r, 'contact_attempts') ?? 0,
        trialOutcome: oneOf(str(r, 'trial_outcome'), [
          'interested',
          'not_interested',
          'no_show',
        ] as const),
        lostReason: oneOf(str(r, 'lost_reason'), [
          'not_interested',
          'no_response',
          'price',
          'schedule',
          'duplicate',
          'other',
        ] as const),
        statusNote: fit(ctx, 'leads', id, 'status_note', text(r, 'status_note'), 1000),
        statusChangedAt,
        convertedAt: t(ctx, r.converted_at),
        convertedById: ctx.has('users', int(r, 'converted_by')) ? int(r, 'converted_by') : null,
        spamScore: int(r, 'spam_score') ?? 0,
        spamFlags: json(r, 'spam_flags') ?? undefined,
        ipHash: text(r, 'ip_hash'),
        submissions: int(r, 'submissions') ?? 1,
        createdAt,
        updatedAt,
      });
    }
    ctx.remember(
      'leads',
      leads.map((l) => l.id as number),
    );
    ctx.dropped('leads', ['legacy_class_request_id']);
    out.push(batch('leads', 'lead', 'leads', ctx.rows('leads').length, leads));

    const activities: Row[] = [];
    for (const r of ctx.rows('lead_activities')) {
      const id = int(r, 'id')!;
      const type = oneOf(str(r, 'type'), ACTIVITY);
      if (!ctx.has('leads', int(r, 'lead_id')) || !type) {
        ctx.report.skip(
          'lead_activities',
          id,
          !type ? `type "${str(r, 'type')}" unknown` : 'lead not imported',
        );
        continue;
      }
      activities.push({
        id,
        leadId: int(r, 'lead_id'),
        type,
        body: text(r, 'body'),
        callResult: fit(ctx, 'lead_activities', id, 'call_result', text(r, 'call_result'), 16),
        meta: camelizeJson(json(r, 'meta')) ?? undefined,
        userId: ctx.has('users', int(r, 'user_id')) ? int(r, 'user_id') : null,
        createdAt: t(ctx, r.created_at) ?? ctx.opts.fallbackNow,
      });
    }
    out.push(
      batch(
        'lead_activities',
        'leadActivity',
        'lead_activities',
        ctx.rows('lead_activities').length,
        activities,
      ),
    );

    // Notifications: Laravel UUID keys become integers (nothing links to them), oldest first.
    const notes: Row[] = [];
    const sorted = [...ctx.rows('notifications')].sort((a, b) => {
      const d = asText(a.created_at).localeCompare(asText(b.created_at));
      return d !== 0 ? d : asText(a.id).localeCompare(asText(b.id));
    });
    let next = 1;
    for (const r of sorted) {
      const userId = int(r, 'notifiable_id');
      if (!/User$/.test(str(r, 'notifiable_type') ?? '') || !ctx.has('users', userId)) {
        ctx.report.skip('notifications', r.id, 'not addressed to an imported user');
        continue;
      }
      const data = (json(r, 'data') ?? {}) as Record<string, unknown>;
      const { kind, event, ...rest } = typeof data === 'object' && data !== null ? data : {};
      const type = (str(r, 'type') ?? '').split('\\').pop() ?? 'unknown';
      notes.push({
        id: next++,
        userId,
        kind: asText(
          kind ??
            type
              .replace(/Notification$/, '')
              .replace(/([a-z])([A-Z])/g, '$1_$2')
              .toLowerCase(),
        ).slice(0, 32),
        event: asText(event ?? 'created').slice(0, 32),
        data: camelizeJson(rest) ?? {},
        readAt: t(ctx, r.read_at),
        createdAt: stamps(ctx, r).createdAt,
      });
    }
    out.push(
      batch(
        'notifications',
        'notification',
        'notifications',
        ctx.rows('notifications').length,
        notes,
      ),
    );

    if (ctx.rows('class_requests').length) {
      ctx.report.noCounterpart(
        'class_requests',
        ctx.rows('class_requests').length,
        'pre-CRM "book a class" requests (Laravel moved live ones into leads; the table itself is not ported)',
      );
    }
    return out;
  },
};
