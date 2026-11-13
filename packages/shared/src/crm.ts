import { z } from 'zod';
import { countryCodeSchema, timeZoneSchema } from './countries.js';
import { dateOnlySchema, PHONE_E164, paginatedSchema, personRefSchema } from './people.js';
import { acknowledgeWarningsSchema, instantSchema, localTimeSchema } from './schedule.js';

/**
 * CRM (N5): leads, the trial class, conversion to a regular family, referrals and the public
 * intake (the app's trial form, the website's WPForms webhook) — `/api/v1/leads…`,
 * `/api/v1/me/referrals`, `/api/v1/public/*` and `/api/v1/settings/crm`. Ported from the Laravel
 * M4 CRM + Leads T1 (docs/26, docs/33 §3; D105–D111, D136, D137, D140). Instants are ISO 8601
 * UTC; local times are the family's wall time (D30).
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryBool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
/** Optional text: trimmed; `""` and `null` clear it. */
const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?([/?#][^\s]*)?$/i.test(v), {
    message: 'Use a full https:// link.',
  });

// ------------------------------------------------------------------ enums + labels

/** Lead pipeline stage (D106). Old system: «New», «Allocated» (= assigned), «Later» (= follow-up). */
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'trial_scheduled',
  'trial_done',
  'converted',
  'lost',
  'spam',
  'job_applicant',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const leadStatusSchema = z.enum(LEAD_STATUSES);
/** Still being worked: the default queue tab («المفتوحة»). */
export const OPEN_LEAD_STATUSES = ['new', 'contacted', 'trial_scheduled', 'trial_done'] as const;
/** Closed by staff and reopenable (undo). `converted` is final. */
export const PARKED_LEAD_STATUSES = ['lost', 'spam', 'job_applicant'] as const;
export const LEAD_STATUS_LABELS: Labels<LeadStatus> = {
  new: { ar: 'جديد', en: 'New' },
  contacted: { ar: 'تم التواصل', en: 'Contacted' },
  trial_scheduled: { ar: 'حصة تجريبية محجوزة', en: 'Trial booked' },
  trial_done: { ar: 'حضر التجريبية', en: 'Trial done' },
  converted: { ar: 'تحوّل إلى منتظم', en: 'Converted' },
  lost: { ar: 'غير مهتم', en: 'Not interested' },
  spam: { ar: 'رسائل مزعجة', en: 'Spam' },
  job_applicant: { ar: 'طلب توظيف', en: 'Job applicant' },
};
export const isOpenLeadStatus = (s: string): boolean =>
  (OPEN_LEAD_STATUSES as readonly string[]).includes(s);
export const isParkedLeadStatus = (s: string): boolean =>
  (PARKED_LEAD_STATUSES as readonly string[]).includes(s);

/** Where a lead came from. The app's trial form and the website both are `web_form` (`site` tells them apart). */
export const LEAD_SOURCES = [
  'web_form',
  'phone',
  'whatsapp',
  'walk_in',
  'referral',
  'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
/** Sources staff may pick for a lead they type in. */
export const MANUAL_LEAD_SOURCES = ['phone', 'whatsapp', 'walk_in', 'other'] as const;
export const LEAD_SOURCE_LABELS: Labels<LeadSource> = {
  web_form: { ar: 'الموقع', en: 'Website' },
  phone: { ar: 'هاتف', en: 'Phone' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  walk_in: { ar: 'حضور شخصي', en: 'Walk-in' },
  referral: { ar: 'ترشيح من ولي أمر', en: 'Referral' },
  other: { ar: 'أخرى', en: 'Other' },
};

export const LOST_REASONS = [
  'not_interested',
  'no_response',
  'price',
  'schedule',
  'duplicate',
  'other',
] as const;
export type LostReason = (typeof LOST_REASONS)[number];
export const LOST_REASON_LABELS: Labels<LostReason> = {
  not_interested: { ar: 'غير مهتم', en: 'Not interested' },
  no_response: { ar: 'لا يرد', en: 'No response' },
  price: { ar: 'السعر', en: 'Price' },
  schedule: { ar: 'المواعيد غير مناسبة', en: 'Schedule' },
  duplicate: { ar: 'طلب مكرر', en: 'Duplicate' },
  other: { ar: 'سبب آخر', en: 'Other' },
};

export const TRIAL_OUTCOMES = ['interested', 'not_interested', 'no_show'] as const;
export type TrialOutcome = (typeof TRIAL_OUTCOMES)[number];
export const TRIAL_OUTCOME_LABELS: Labels<TrialOutcome> = {
  interested: { ar: 'مهتم بالاشتراك', en: 'Interested' },
  not_interested: { ar: 'غير مهتم', en: 'Not interested' },
  no_show: { ar: 'لم يحضر', en: 'No show' },
};

/** Timeline entries. Staff write the first four by hand; the rest are written by the system. */
export const LEAD_ACTIVITY_TYPES = [
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
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];
export const MANUAL_ACTIVITY_TYPES = ['note', 'call', 'whatsapp', 'email'] as const;
/** A real contact attempt with the family: moves a new lead to contacted. */
export const CONTACT_ACTIVITY_TYPES = ['call', 'whatsapp', 'email'] as const;
export const LEAD_ACTIVITY_LABELS: Labels<LeadActivityType> = {
  note: { ar: 'ملاحظة', en: 'Note' },
  call: { ar: 'مكالمة', en: 'Call' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  email: { ar: 'بريد إلكتروني', en: 'Email' },
  status_changed: { ar: 'تغيير الحالة', en: 'Status changed' },
  assigned: { ar: 'إسناد', en: 'Assigned' },
  account_created: { ar: 'إنشاء الحساب', en: 'Account created' },
  trial_booked: { ar: 'حجز حصة تجريبية', en: 'Trial booked' },
  trial_cancelled: { ar: 'إلغاء الحصة التجريبية', en: 'Trial cancelled' },
  trial_outcome: { ar: 'نتيجة الحصة التجريبية', en: 'Trial outcome' },
  converted: { ar: 'التحويل إلى منتظم', en: 'Converted' },
  resubmitted: { ar: 'طلب مكرر', en: 'Submitted again' },
  created: { ar: 'إنشاء الطلب', en: 'Created' },
};

export const CALL_RESULTS = ['reached', 'no_answer', 'busy', 'wrong_number'] as const;
export type CallResult = (typeof CALL_RESULTS)[number];
export const CALL_RESULT_LABELS: Labels<CallResult> = {
  reached: { ar: 'تم الرد', en: 'Reached' },
  no_answer: { ar: 'لا رد', en: 'No answer' },
  busy: { ar: 'مشغول', en: 'Busy' },
  wrong_number: { ar: 'رقم خاطئ', en: 'Wrong number' },
};

/** `POST /leads/:id/status`: park (lost / spam / job applicant), undo (reopen), or mark contacted. */
export const LEAD_STATUS_ACTIONS = [
  'lost',
  'spam',
  'job_applicant',
  'reopen',
  'contacted',
] as const;
export const BULK_LEAD_STATUS_ACTIONS = ['lost', 'spam'] as const;

/** Server-computed buttons of the workbench (Laravel `allowed_actions`). */
export const LEAD_ALLOWED_ACTIONS = [
  'add_activity',
  'edit',
  'assign_self',
  'release',
  'assign',
  'mark_contacted',
  'lose',
  'spam',
  'job_applicant',
  'create_account',
  'book_trial',
  'convert',
  'record_outcome',
  'reopen',
] as const;
export type LeadAllowedAction = (typeof LEAD_ALLOWED_ACTIONS)[number];

/** The app's public trial form. */
export const PREFERRED_PERIODS = ['morning', 'afternoon', 'evening', 'night'] as const;
export const PREFERRED_PERIOD_LABELS: Labels<(typeof PREFERRED_PERIODS)[number]> = {
  morning: { ar: 'صباحًا', en: 'Morning' },
  afternoon: { ar: 'بعد الظهر', en: 'Afternoon' },
  evening: { ar: 'مساءً', en: 'Evening' },
  night: { ar: 'ليلًا', en: 'Night' },
};
export const HEARD_FROM = [
  'google',
  'facebook',
  'instagram',
  'youtube',
  'tiktok',
  'friend',
  'whatsapp',
  'other',
] as const;
export const HEARD_FROM_LABELS: Labels<(typeof HEARD_FROM)[number]> = {
  google: { ar: 'جوجل', en: 'Google' },
  facebook: { ar: 'فيسبوك', en: 'Facebook' },
  instagram: { ar: 'إنستغرام', en: 'Instagram' },
  youtube: { ar: 'يوتيوب', en: 'YouTube' },
  tiktok: { ar: 'تيك توك', en: 'TikTok' },
  friend: { ar: 'صديق', en: 'A friend' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  other: { ar: 'أخرى', en: 'Other' },
};
export const TEACHER_GENDER_PREFS = ['male', 'female', 'any'] as const;
export const TEACHER_GENDER_PREF_LABELS: Labels<(typeof TEACHER_GENDER_PREFS)[number]> = {
  male: { ar: 'معلم', en: 'Male teacher' },
  female: { ar: 'معلمة', en: 'Female teacher' },
  any: { ar: 'لا فرق', en: 'No preference' },
};

/** Staff alerts about a lead (in-app + email to staff only). */
export const LEAD_NOTIFICATION_EVENTS = [
  'assigned',
  'unassigned',
  'follow_up_due',
  'sla_breach',
  'trial_offer_claimed',
  'trial_offer_volunteer',
  'trial_offer_expired',
] as const;
export type LeadNotificationEvent = (typeof LEAD_NOTIFICATION_EVENTS)[number];
export const LEAD_NOTIFICATION_LABELS: Labels<LeadNotificationEvent> = {
  assigned: { ar: 'أُسند إليك طلب جديد', en: 'A lead was assigned to you' },
  unassigned: { ar: 'طلب جديد بلا مسؤول', en: 'A new lead has no owner' },
  follow_up_due: { ar: 'حان موعد المتابعة', en: 'Follow-up due' },
  sla_breach: { ar: 'تأخر أول تواصل مع الطلب', en: 'First response overdue' },
  trial_offer_claimed: { ar: 'قبل معلم عرض الحصة التجريبية', en: 'A teacher took the trial offer' },
  trial_offer_volunteer: {
    ar: 'معلم يرغب في الحصة التجريبية',
    en: 'A teacher volunteered for the trial',
  },
  trial_offer_expired: {
    ar: 'انتهت مهلة عرض الحصة التجريبية: أسند معلمًا مباشرة',
    en: 'Trial offer expired: assign a teacher directly',
  },
};

/** «في الشيفت» for auto-assignment (D137: `any` = no shift limit). */
export const CRM_SHIFT_SOURCES = ['any', 'attendance', 'hours'] as const;

// ------------------------------------------------------------------ field rules

/** Lead phones are kept as typed (web forms send national numbers); matching uses the digits. */
const leadPhone = z
  .string()
  .trim()
  .max(40)
  .regex(/^\+?[0-9 ()\-.]{6,40}$/, { message: 'The phone number format is invalid.' });
const leadEmail = z.string().trim().toLowerCase().pipe(z.email().max(190));
const countryInput = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(countryCodeSchema);

export const leadChildInputSchema = z.object({
  name: optionalText(80),
  age: z.number().int().min(2).max(99).nullable().optional(),
  gender: z.enum(['male', 'female']).nullable().optional(),
  courseId: id.nullable().optional(),
});
export type LeadChildInput = z.input<typeof leadChildInputSchema>;

const contactFields = {
  parentName: z.string().trim().min(2).max(120),
  email: z.preprocess(blankToNull, leadEmail.nullable()).optional(),
  phone: z.preprocess(blankToNull, leadPhone.nullable()).optional(),
  countryCode: z.preprocess(blankToNull, countryInput.nullable()).optional(),
  city: optionalText(80),
  timezone: z.preprocess(blankToNull, timeZoneSchema.nullable()).optional(),
  preferredLanguage: optionalText(8),
  children: z.array(leadChildInputSchema).max(10).optional(),
  courseInterest: optionalText(120),
  preferredTimes: optionalText(500),
  message: optionalText(5000),
};

const needsContact = (
  v: { email?: string | null; phone?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (!v.email && !v.phone) {
    ctx.addIssue({
      code: 'custom',
      path: ['phone'],
      message: 'Enter a phone number or an email address.',
    });
  }
};

// ------------------------------------------------------------------ staff writes

/** `POST /leads`: a lead typed by staff (call, WhatsApp, walk-in). Assigned to the creator unless `assignedTo` is given. */
export const createLeadSchema = z
  .object({
    ...contactFields,
    source: z.enum(MANUAL_LEAD_SOURCES),
    /** `null` = leave unassigned; another person needs `leads.assign`. */
    assignedTo: id.nullable().optional(),
    nextFollowUpAt: instantSchema.nullable().optional(),
  })
  .superRefine(needsContact);
export type CreateLeadInput = z.input<typeof createLeadSchema>;

/** `PATCH /leads/:id`: contact data and the follow-up time (status has its own routes). */
export const updateLeadSchema = z.object({
  ...contactFields,
  parentName: contactFields.parentName.optional(),
  nextFollowUpAt: instantSchema.nullable().optional(),
});
export type UpdateLeadInput = z.input<typeof updateLeadSchema>;

/** `POST /leads/:id/activities`: a note or a contact attempt; a contact may set the next follow-up. */
export const leadActivityInputSchema = z
  .object({
    type: z.enum(MANUAL_ACTIVITY_TYPES),
    body: optionalText(5000),
    callResult: z.enum(CALL_RESULTS).nullable().optional(),
    nextFollowUpAt: instantSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'note' && !v.body) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'Write the note.' });
    }
    if (v.type === 'call' && !v.callResult) {
      ctx.addIssue({ code: 'custom', path: ['callResult'], message: 'Choose the call result.' });
    }
  });
export type LeadActivityInput = z.input<typeof leadActivityInputSchema>;

/** `POST /leads/:id/assign`: `userId: null` releases the lead. */
export const assignLeadSchema = z.object({ userId: id.nullable() });
export type AssignLeadInput = z.input<typeof assignLeadSchema>;

const bulkIds = z.array(id).min(1).max(100);
/** `POST /leads/bulk/assign` (`leads.assign`). */
export const bulkAssignLeadsSchema = z.object({ ids: bulkIds, userId: id.nullable() });
export type BulkAssignLeadsInput = z.input<typeof bulkAssignLeadsSchema>;

const lostReasonRequired = (
  v: { status: string; lostReason?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (v.status === 'lost' && !v.lostReason) {
    ctx.addIssue({
      code: 'custom',
      path: ['lostReason'],
      message: 'Choose why the lead was lost.',
    });
  }
};

/** `POST /leads/:id/status` */
export const leadStatusChangeSchema = z
  .object({
    status: z.enum(LEAD_STATUS_ACTIONS),
    lostReason: z.enum(LOST_REASONS).nullable().optional(),
    note: optionalText(1000),
  })
  .superRefine(lostReasonRequired);
export type LeadStatusChangeInput = z.input<typeof leadStatusChangeSchema>;

/** `POST /leads/bulk/status`: lost or spam only. */
export const bulkLeadStatusSchema = z
  .object({
    ids: bulkIds,
    status: z.enum(BULK_LEAD_STATUS_ACTIONS),
    lostReason: z.enum(LOST_REASONS).nullable().optional(),
    note: optionalText(1000),
  })
  .superRefine(lostReasonRequired);
export type BulkLeadStatusInput = z.input<typeof bulkLeadStatusSchema>;

// ------------------------------------------------------------------ trial and conversion

/**
 * `POST /leads/:id/account`: the trial family, the parent login and the children. With
 * `familyId` the children join that existing family instead (`422 email_taken` offers it).
 */
export const createLeadAccountSchema = z
  .object({
    familyId: id.nullable().optional(),
    parentName: z.preprocess(blankToNull, z.string().trim().min(2).max(120).nullable()).optional(),
    email: z.preprocess(blankToNull, leadEmail.nullable()).optional(),
    /** E.164 (spaces, dashes, dots, brackets stripped). Defaults to the lead's phone when valid. */
    phone: z
      .preprocess(
        blankToNull,
        z
          .string()
          .transform((v) => v.replace(/[\s\-().]/g, ''))
          .pipe(z.string().regex(PHONE_E164, { message: 'Use the international format.' }))
          .nullable(),
      )
      .optional(),
    countryCode: z.preprocess(blankToNull, countryInput.nullable()).optional(),
    timezone: z.preprocess(blankToNull, timeZoneSchema.nullable()).optional(),
    children: z
      .array(
        z.object({
          name: z.string().trim().min(2).max(80),
          age: z.number().int().min(2).max(99).nullable().optional(),
          gender: z.enum(['male', 'female']).nullable().optional(),
          courseId: id,
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine((v, ctx) => {
    if (v.familyId) return;
    for (const field of ['parentName', 'email', 'timezone'] as const) {
      if (!v[field]) ctx.addIssue({ code: 'custom', path: [field], message: 'Required.' });
    }
  });
export type CreateLeadAccountInput = z.input<typeof createLeadAccountSchema>;

/**
 * `POST /leads/:id/trials`: a trial class typed in the family's wall time (`timezone` defaults to
 * the family's). A rebooking moves the earlier still-scheduled trial out. Without Zoom the class
 * needs a fixed link: `meetingUrl`, else the teacher's own fixed link (422 `meetingUrl`).
 */
export const bookTrialSchema = z.object({
  studentId: id,
  courseId: id,
  teacherId: id,
  localDate: dateOnlySchema,
  localTime: localTimeSchema,
  timezone: timeZoneSchema.nullable().optional(),
  durationMinutes: z
    .number()
    .int()
    .min(15)
    .max(90)
    .refine((n) => n % 5 === 0, { message: 'Use steps of 5 minutes.' })
    .nullable()
    .optional(),
  meetingUrl: z.preprocess(blankToNull, httpsUrl.nullable()).optional(),
  acknowledgeWarnings: acknowledgeWarningsSchema,
  /**
   * Required (≥ 3 characters) to book a teacher who is not eligible (T2, docs/33 §4.2): not
   * teaching the course, not taking trials, weekly cap, gender, age group or leave. 422
   * `teacher_not_eligible` without it, with the reasons in `data.reasons`.
   */
  overrideReason: z
    .preprocess(blankToNull, z.string().trim().min(3).max(500).nullable())
    .optional(),
});
export type BookTrialInput = z.input<typeof bookTrialSchema>;

/** `POST /leads/:id/trial-outcome`: interested → trial_done, no_show → contacted, not_interested → lost. */
export const trialOutcomeSchema = z.object({
  outcome: z.enum(TRIAL_OUTCOMES),
  note: optionalText(2000),
  lostReason: z.enum(LOST_REASONS).nullable().optional(),
});
export type TrialOutcomeInput = z.input<typeof trialOutcomeSchema>;

/**
 * `POST /leads/:id/convert` (D110): one regular enrollment + weekly times per student, in one
 * transaction; any clash keeps nothing. `startsOn` not before today (academy zone). The welcome
 * mail (a set-password link, D111) goes only with `sendWelcome: true` (D140: off by default).
 */
export const convertLeadSchema = z
  .object({
    students: z
      .array(
        z.object({
          studentId: id,
          courseId: id,
          teacherId: id,
          startsOn: dateOnlySchema,
          sessionMinutes: z
            .number()
            .int()
            .min(15)
            .max(120)
            .refine((n) => n % 5 === 0, { message: 'Use steps of 5 minutes.' })
            .nullable()
            .optional(),
          slots: z
            .array(
              z.object({
                weekday: z.number().int().min(1).max(7),
                localStartTime: localTimeSchema,
              }),
            )
            .min(1)
            .max(7),
          /** Fixed class link while Zoom is not set up; defaults to the trial's or the teacher's link. */
          meetingUrl: z.preprocess(blankToNull, httpsUrl.nullable()).optional(),
        }),
      )
      .min(1)
      .max(10),
    sendWelcome: z.boolean().default(false),
    acknowledgeWarnings: acknowledgeWarningsSchema,
  })
  .superRefine((v, ctx) => {
    const seen = new Set<number>();
    v.students.forEach((s, i) => {
      if (seen.has(s.studentId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['students', i, 'studentId'],
          message: 'Each student once.',
        });
      }
      seen.add(s.studentId);
    });
  });
export type ConvertLeadInput = z.input<typeof convertLeadSchema>;

/** `POST /me/referrals` (`leads.refer`): a parent recommends a friend. */
export const referralSchema = z
  .object({
    parentName: z.string().trim().min(2).max(120),
    email: contactFields.email,
    phone: contactFields.phone,
    countryCode: contactFields.countryCode,
    childrenCount: z.number().int().min(1).max(10).nullable().optional(),
    message: optionalText(2000),
  })
  .superRefine(needsContact);
export type ReferralInput = z.input<typeof referralSchema>;

// ------------------------------------------------------------------ public intake

/**
 * `POST /public/trial-requests`: the app's free-trial form (no login). The honeypot field
 * (`website` by default) and the captcha token are read before this schema.
 */
export const publicTrialRequestSchema = z.object({
  parentName: z.string().trim().min(2).max(120),
  /** WhatsApp number in E.164 (the form's country picker builds it). */
  phone: z.string().trim().regex(PHONE_E164, { message: 'Use the international format.' }),
  email: leadEmail,
  countryCode: countryInput,
  timezone: timeZoneSchema,
  children: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(80),
        age: z.number().int().min(3).max(99),
        gender: z.enum(['male', 'female']),
        courseId: id,
      }),
    )
    .min(1)
    .max(10),
  preferredDays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((a) => new Set(a).size === a.length, { message: 'Each day once.' }),
  preferredPeriods: z
    .array(z.enum(PREFERRED_PERIODS))
    .min(1)
    .max(4)
    .refine((a) => new Set(a).size === a.length, { message: 'Each period once.' }),
  preferredNote: optionalText(300),
  teacherGenderPref: z.enum(TEACHER_GENDER_PREFS),
  heardFrom: z.enum(HEARD_FROM).nullable().optional(),
  message: optionalText(2000),
  utm: z
    .object({
      source: optionalText(100),
      medium: optionalText(100),
      campaign: optionalText(100),
      term: optionalText(100),
      content: optionalText(100),
    })
    .nullable()
    .optional(),
  locale: z.enum(['ar', 'en']).nullable().optional(),
});
export type PublicTrialRequestInput = z.input<typeof publicTrialRequestSchema>;

/** Same answer for a new, merged or honeypot submission: the form learns nothing. */
export const receivedSchema = z.object({ data: z.object({ received: z.literal(true) }) });

/**
 * `POST /public/web-leads/wpforms`: the website snippet's payload (docs/integrations/wpforms-webhook.php
 * in the Laravel repo). Kept snake_case and byte-for-byte compatible: the WordPress side is not
 * changed at cut-over. Field ids on form 4823: 1 name, 3 email, 5 phone, 11 course_for,
 * 12 children_count, 13 student_age, 10 course, 9 notes.
 */
const scalarText = (max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .pipe(z.string().max(max))
    .nullable()
    .optional();
export const wpformsLeadSchema = z.object({
  form_id: z.number().int().min(1),
  entry_id: z.number().int().min(1),
  submitted_at: z.string().max(40).nullable().optional(),
  page_url: z.string().max(1000).nullable().optional(),
  referer: z.string().max(1000).nullable().optional(),
  fields: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().max(190).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    course_for: z.string().max(40).nullable().optional(),
    children_count: scalarText(10),
    student_age: scalarText(60),
    course: z.string().max(120).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  }),
});
export type WpformsLeadPayload = z.input<typeof wpformsLeadSchema>;
export const WEB_LEAD_SIGNATURE_HEADER = 'X-Qarabic-Signature';
export const WEB_LEAD_TIMESTAMP_HEADER = 'X-Qarabic-Timestamp';

// ------------------------------------------------------------------ list query

/** `GET /leads`. `status` defaults to `open`; counts in `meta.counts` (+ `open`). */
export const leadListQuerySchema = z.object({
  status: z.enum([...LEAD_STATUSES, 'open', 'all']).default('open'),
  q: z.string().trim().max(120).optional(),
  /** `me`, `none` or a user id. */
  assigned: z
    .string()
    .regex(/^(me|none|[1-9]\d{0,8})$/)
    .optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  /** Follow-up due before the end of today in `tz`. */
  followUp: z.literal('due').optional(),
  awaitingOutcome: queryBool.optional(),
  uncontacted: queryBool.optional(),
  /** The viewer's zone for "today" (defaults to theirs). */
  tz: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type LeadListQuery = z.input<typeof leadListQuerySchema>;

export const leadSummaryQuerySchema = z.object({ tz: z.string().max(64).optional() });
export const leadFunnelQuerySchema = z
  .object({ from: dateOnlySchema.optional(), to: dateOnlySchema.optional() })
  .superRefine((v, ctx) => {
    if (v.from && v.to && v.to < v.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end is before the start.' });
    }
  });

// ------------------------------------------------------------------ responses

export const leadTrialRefSchema = z.object({
  sessionId: z.number().int(),
  startsAt: z.string(),
  stage: z.string(),
});

/** One row of the queue (Laravel `LeadResource`). */
export const leadSchema = z.object({
  id: z.number().int(),
  status: leadStatusSchema,
  source: z.enum(LEAD_SOURCES),
  /** `app_trial`, `wpforms:4823`, or what an old form sent. */
  site: z.string().nullable(),
  parentName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  countryCode: z.string().nullable(),
  timezone: z.string(),
  childrenCount: z.number().int(),
  assignedTo: personRefSchema.nullable(),
  nextFollowUpAt: z.string().nullable(),
  lastContactedAt: z.string().nullable(),
  createdAt: z.string(),
  familyId: z.number().int().nullable(),
  /** Latest non-cancelled trial class of the lead's family. */
  trial: leadTrialRefSchema.nullable(),
  spamScore: z.number().int(),
  submissions: z.number().int(),
  firstResponseAt: z.string().nullable(),
  contactAttempts: z.number().int(),
  /** While a new lead has had no contact: when the first-response SLA runs out (working minutes). */
  firstResponseDueAt: z.string().nullable(),
  firstResponseOverdue: z.boolean(),
});
export type LeadDto = z.infer<typeof leadSchema>;
export const leadListResponseSchema = paginatedSchema(leadSchema);

export const leadChildSchema = z.object({
  name: z.string().optional(),
  age: z.number().int().optional(),
  gender: z.enum(['male', 'female']).optional(),
  courseId: z.number().int().optional(),
});
export type LeadChildDto = z.infer<typeof leadChildSchema>;

export const leadActivitySchema = z.object({
  id: z.number().int(),
  type: z.enum(LEAD_ACTIVITY_TYPES),
  body: z.string().nullable(),
  callResult: z.enum(CALL_RESULTS).nullable(),
  meta: z.record(z.string(), z.unknown()),
  user: personRefSchema.nullable(),
  createdAt: z.string(),
});
export type LeadActivityDto = z.infer<typeof leadActivitySchema>;

/** Both parties' wall times of a class (D30): `YYYY-MM-DDTHH:MM` in each zone. */
export const bothTimesSchema = z.object({
  familyZone: z.string(),
  teacherZone: z.string(),
  familyLocal: z.string(),
  teacherLocal: z.string(),
});

export const leadTrialSchema = z
  .object({
    sessionId: z.number().int(),
    student: personRefSchema,
    teacher: personRefSchema,
    course: z.object({ id: z.number().int(), nameAr: z.string(), nameEn: z.string() }).nullable(),
    startsAt: z.string(),
    durationMinutes: z.number().int(),
    stage: z.string(),
  })
  .extend(bothTimesSchema.shape);
export type LeadTrialDto = z.infer<typeof leadTrialSchema>;

export const leadStudentSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  age: z.number().int().nullable(),
  gender: z.string().nullable(),
  courseId: z.number().int().nullable(),
  enrollments: z.array(
    z.object({
      id: z.number().int(),
      kind: z.string(),
      courseId: z.number().int(),
      teacherId: z.number().int(),
      status: z.string(),
    }),
  ),
});

export const leadDuplicatesSchema = z.object({
  leads: z.array(
    z.object({
      id: z.number().int(),
      parentName: z.string(),
      status: leadStatusSchema,
      createdAt: z.string(),
    }),
  ),
  families: z.array(
    z.object({ id: z.number().int(), name: z.string().nullable(), status: z.string() }),
  ),
});

/** The workbench (Laravel `LeadDetailResource`). */
export const leadDetailSchema = leadSchema.extend({
  children: z.array(leadChildSchema),
  city: z.string().nullable(),
  preferredLanguage: z.string().nullable(),
  courseInterest: z.string().nullable(),
  preferredTimes: z.string().nullable(),
  preferredSchedule: z
    .object({
      days: z.array(z.number().int()).optional(),
      periods: z.array(z.string()).optional(),
      note: z.string().optional(),
    })
    .nullable(),
  teacherGenderPref: z.string().nullable(),
  heardFrom: z.string().nullable(),
  /** Contact attempts without an answer since the family was last reached. */
  unansweredAttempts: z.number().int(),
  /** Suggest «lost: no response» after `crm.unanswered_attempts_suggest_lost` of them. */
  suggestLostNoResponse: z.boolean(),
  message: z.string().nullable(),
  family: z
    .object({
      id: z.number().int(),
      status: z.string(),
      name: z.string().nullable(),
      timezone: z.string(),
    })
    .nullable(),
  referralFamily: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
  trialOutcome: z.enum(TRIAL_OUTCOMES).nullable(),
  lostReason: z.enum(LOST_REASONS).nullable(),
  statusNote: z.string().nullable(),
  spamFlags: z.array(z.string()),
  convertedAt: z.string().nullable(),
  convertedBy: personRefSchema.nullable(),
  utm: z.record(z.string(), z.string()).nullable(),
  activities: z.array(leadActivitySchema),
  trials: z.array(leadTrialSchema),
  students: z.array(leadStudentSchema),
  duplicates: leadDuplicatesSchema,
  allowedActions: z.array(z.enum(LEAD_ALLOWED_ACTIONS)),
});
export type LeadDetailDto = z.infer<typeof leadDetailSchema>;

/** `POST /leads/:id/trials` answers the workbench + `meta.trial`. */
export const bookedTrialSchema = z
  .object({
    sessionId: z.number().int(),
    startsAt: z.string(),
    durationMinutes: z.number().int(),
    stage: z.string(),
  })
  .extend(bothTimesSchema.shape);
export type BookedTrialDto = z.infer<typeof bookedTrialSchema>;

export const bulkResultSchema = z.object({
  updated: z.array(z.number().int()),
  failed: z.array(z.object({ id: z.number().int(), code: z.string() })),
});
export type BulkResultDto = z.infer<typeof bulkResultSchema>;

export const leadAssigneeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  role: z.string().nullable(),
  openCount: z.number().int(),
});
export type LeadAssigneeDto = z.infer<typeof leadAssigneeSchema>;

/** Today tiles (`GET /leads/summary?tz=`). */
export const leadSummarySchema = z.object({
  date: z.string(),
  timezone: z.string(),
  new: z.number().int(),
  followUpsDue: z.number().int(),
  trialsToday: z.number().int(),
  awaitingOutcome: z.number().int(),
  convertedThisMonth: z.number().int(),
  lostThisMonth: z.number().int(),
  openTotal: z.number().int(),
  unassigned: z.number().int(),
  /** «طلبات لم يُتواصل معها» and how many are past the first-response time. */
  uncontacted: z.number().int(),
  firstResponseOverdue: z.number().int(),
});
export type LeadSummaryDto = z.infer<typeof leadSummarySchema>;

const funnelRow = z.object({
  created: z.number().int(),
  contacted: z.number().int(),
  trial: z.number().int(),
  converted: z.number().int(),
  lost: z.number().int(),
  spam: z.number().int(),
});
export const leadFunnelSchema = z.object({
  from: z.string(),
  to: z.string(),
  total: funnelRow,
  bySource: z.array(funnelRow.extend({ source: z.enum(LEAD_SOURCES) })),
  byAssignee: z.array(funnelRow.extend({ user: personRefSchema.nullable() })),
});
export type LeadFunnelDto = z.infer<typeof leadFunnelSchema>;

/** `GET /public/courses`: what the trial form may show (no internal fields). */
export const publicCourseSchema = z.object({
  id: z.number().int(),
  nameAr: z.string(),
  nameEn: z.string(),
  category: z.enum(['regular', 'additional']),
});
export type PublicCourseDto = z.infer<typeof publicCourseSchema>;

// ------------------------------------------------------------------ settings

/** `GET/PUT /settings/crm` (Laravel `crm.*` in `Settings::DEFAULTS`). */
export const CRM_SETTING_RULES = {
  'crm.auto_assign_enabled': z.boolean(),
  /** Roles in the round-robin pool (`[]` = every active user with `leads.manage`). */
  'crm.auto_assign_roles': z.array(z.string().min(1).max(100)).max(20),
  'crm.shift_source': z.enum(CRM_SHIFT_SOURCES),
  /** Fallback owner when nobody is in the pool (0 = none: `leads.assign` holders are told). */
  'crm.lead_admin_user_id': z.number().int().min(0),
  'crm.first_response_minutes': z.number().int().min(5).max(1440),
  'crm.working_hours_start': localTimeSchema,
  'crm.working_hours_end': localTimeSchema,
  'crm.working_hours_timezone': timeZoneSchema,
  'crm.unanswered_attempts_suggest_lost': z.number().int().min(1).max(20),
  /** Confirmation email to the family after the app's trial form (D140: off). */
  'crm.trial_form_confirmation': z.boolean(),
  /** Confirmation to the family for website leads (D140: off). */
  'crm.web_lead_confirmation': z.boolean(),
  /** T3 open offers: how long teachers have to answer (docs/33 §4.3). */
  'crm.trial_offer_expiry_minutes': z.number().int().min(15).max(1440),
  /** An offer always closes at least this many hours before the trial. */
  'crm.trial_offer_min_hours_before': z.number().int().min(0).max(72),
  /** Fairness guard: upcoming trials a teacher may hold from offers at once. */
  'crm.trial_offer_max_open_claims': z.number().int().min(1).max(20),
} as const;
export type CrmSettingKey = keyof typeof CRM_SETTING_RULES;
export const crmSettingsSchema = z.object(CRM_SETTING_RULES);
export type CrmSettingsDto = z.infer<typeof crmSettingsSchema>;
export const updateCrmSettingsSchema = z.strictObject(CRM_SETTING_RULES).partial();
export type UpdateCrmSettingsInput = z.input<typeof updateCrmSettingsSchema>;
