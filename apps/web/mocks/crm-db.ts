import {
  CRM_SETTING_RULES,
  type CrmSettingsDto,
  type LeadActivityDto,
  type LeadChildDto,
  type LeadDetailDto,
  type LeadSource,
  type LeadStatus,
  type LeadTrialDto,
  type LostReason,
  type NotificationDto,
  type TrialOutcome,
} from '@qarabic/shared';

/**
 * Fake CRM data for the mocks (N5): leads in every stage and source, their timelines, trials and
 * the staff bell. Made-up names, `example.com` emails and 555 / 7700 900 phone numbers only.
 * Times are built from the clock when the data is (re)built, so "today" tiles always have rows.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Staff who can work leads: the admin login (1) and two made-up customer-service agents. */
export const CRM_STAFF = [
  { id: 1, name: 'مدير النظام', role: 'admin' },
  { id: 21, name: 'سارة عبد الله', role: 'csr' },
  { id: 22, name: 'خالد منصور', role: 'csr' },
] as const;
export const staffRef = (id: number | null) => {
  const s = CRM_STAFF.find((x) => x.id === id);
  return s ? { id: s.id, name: s.name } : null;
};

export interface LeadStudentRow {
  id: number;
  name: string;
  age: number | null;
  gender: string | null;
  courseId: number | null;
  enrollments: { id: number; kind: string; courseId: number; teacherId: number; status: string }[];
}

export interface LeadRow {
  id: number;
  status: LeadStatus;
  source: LeadSource;
  site: string | null;
  parentName: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  timezone: string;
  city: string | null;
  preferredLanguage: string | null;
  children: LeadChildDto[];
  courseInterest: string | null;
  preferredTimes: string | null;
  preferredSchedule: LeadDetailDto['preferredSchedule'];
  teacherGenderPref: string | null;
  heardFrom: string | null;
  message: string | null;
  assignedToId: number | null;
  nextFollowUpAt: string | null;
  lastContactedAt: string | null;
  firstResponseAt: string | null;
  contactAttempts: number;
  unansweredAttempts: number;
  createdAt: string;
  familyId: number | null;
  familyName: string | null;
  familyStatus: string | null;
  referralFamily: { id: number; name: string | null } | null;
  trialOutcome: TrialOutcome | null;
  lostReason: LostReason | null;
  statusNote: string | null;
  spamScore: number;
  spamFlags: string[];
  submissions: number;
  convertedAt: string | null;
  convertedById: number | null;
  utm: Record<string, string> | null;
  activities: LeadActivityDto[];
  trials: LeadTrialDto[];
  students: LeadStudentRow[];
}

export interface NotificationRow extends NotificationDto {
  userId: number;
}

export interface CrmDb {
  leads: LeadRow[];
  settings: CrmSettingsDto;
  notifications: NotificationRow[];
  referrals: number;
  nextId: { lead: number; activity: number; family: number; student: number; session: number };
}

export const CRM_DEFAULTS: CrmSettingsDto = {
  'crm.auto_assign_enabled': true,
  'crm.auto_assign_roles': ['csr'],
  'crm.shift_source': 'any',
  'crm.lead_admin_user_id': 0,
  'crm.first_response_minutes': 30,
  'crm.working_hours_start': '10:00',
  'crm.working_hours_end': '22:00',
  'crm.working_hours_timezone': 'Africa/Cairo',
  'crm.unanswered_attempts_suggest_lost': 3,
  'crm.trial_offer_expiry_minutes': 120,
  'crm.trial_offer_min_hours_before': 6,
  'crm.trial_offer_max_open_claims': 3,
  'crm.trial_form_confirmation': false,
  'crm.web_lead_confirmation': false,
};
// Keeps the defaults in step with the shared rules (a new key fails type-checking here).
void (CRM_SETTING_RULES satisfies Record<keyof CrmSettingsDto, unknown>);

type Seed = Partial<LeadRow> &
  Pick<LeadRow, 'status' | 'source' | 'parentName'> & { ageMs: number; childNames?: string[] };

function build(): CrmDb {
  const now = Date.now();
  let activityId = 1;
  const leads: LeadRow[] = [];
  const seeds: Seed[] = [
    {
      status: 'new',
      source: 'web_form',
      site: 'app_trial',
      parentName: 'Amina Rahman',
      email: 'amina.rahman@example.com',
      phone: '+447700900101',
      countryCode: 'GB',
      timezone: 'Europe/London',
      ageMs: 50 * MIN,
      childNames: ['Yusuf', 'Maryam'],
      assignedToId: 1,
      preferredSchedule: { days: [6, 7], periods: ['evening'], note: 'After school' },
      teacherGenderPref: 'female',
      heardFrom: 'google',
      courseInterest: 'Quran Hifz',
    },
    {
      status: 'new',
      source: 'web_form',
      site: 'wpforms:4823',
      parentName: 'Omar Haddad',
      email: 'omar.haddad@example.com',
      phone: '+15550100012',
      countryCode: 'US',
      timezone: 'America/New_York',
      ageMs: 3 * HOUR,
      childNames: ['Adam'],
      assignedToId: null,
      submissions: 2,
    },
    {
      status: 'new',
      source: 'phone',
      parentName: 'Huda Saleh',
      phone: '+15550200031',
      countryCode: 'CA',
      timezone: 'America/Toronto',
      ageMs: 20 * MIN,
      childNames: ['Layla'],
      assignedToId: 21,
    },
    {
      status: 'contacted',
      source: 'whatsapp',
      parentName: 'Bilal Ahmed',
      email: 'bilal.ahmed@example.com',
      phone: '+447700900144',
      countryCode: 'GB',
      timezone: 'Europe/London',
      ageMs: 2 * DAY,
      childNames: ['Ibrahim', 'Zainab'],
      assignedToId: 1,
      nextFollowUpAt: iso(now + 2 * HOUR),
      contactAttempts: 2,
      firstResponseAt: iso(now - 2 * DAY + 20 * MIN),
      lastContactedAt: iso(now - DAY),
    },
    {
      status: 'contacted',
      source: 'web_form',
      site: 'app_trial',
      parentName: 'Sara Qureshi',
      email: 'sara.qureshi@example.com',
      phone: '+61555011012',
      countryCode: 'AU',
      timezone: 'Australia/Sydney',
      ageMs: 4 * DAY,
      childNames: ['Hamza'],
      assignedToId: 22,
      nextFollowUpAt: iso(now - 3 * HOUR),
      contactAttempts: 3,
      unansweredAttempts: 3,
      firstResponseAt: iso(now - 4 * DAY + HOUR),
      lastContactedAt: iso(now - DAY),
    },
    {
      status: 'trial_scheduled',
      source: 'referral',
      parentName: 'Khadija Noor',
      email: 'khadija.noor@example.com',
      phone: '+15550100045',
      countryCode: 'US',
      timezone: 'America/New_York',
      ageMs: 5 * DAY,
      childNames: ['Aisha'],
      assignedToId: 1,
      referralFamily: { id: 1, name: 'ولي أمر تجريبي' },
      firstResponseAt: iso(now - 5 * DAY + HOUR),
      lastContactedAt: iso(now - 2 * DAY),
      contactAttempts: 1,
    },
    {
      status: 'trial_done',
      source: 'web_form',
      site: 'wpforms:4823',
      parentName: 'Yasmin Farouk',
      email: 'yasmin.farouk@example.com',
      phone: '+447700900177',
      countryCode: 'GB',
      timezone: 'Europe/London',
      ageMs: 9 * DAY,
      childNames: ['Musa'],
      assignedToId: 21,
      trialOutcome: 'interested',
      firstResponseAt: iso(now - 9 * DAY + HOUR),
      lastContactedAt: iso(now - DAY),
      contactAttempts: 2,
    },
    {
      status: 'converted',
      source: 'phone',
      parentName: 'Nadia Karim',
      email: 'nadia.karim@example.com',
      phone: '+15550200066',
      countryCode: 'CA',
      timezone: 'America/Toronto',
      ageMs: 20 * DAY,
      childNames: ['Ali'],
      assignedToId: 22,
      convertedAt: iso(now - 3 * DAY),
      convertedById: 22,
      firstResponseAt: iso(now - 20 * DAY + HOUR),
      contactAttempts: 2,
    },
    {
      status: 'lost',
      source: 'web_form',
      site: 'app_trial',
      parentName: 'Fatima Hussain',
      email: 'fatima.hussain@example.com',
      phone: '+447700900188',
      countryCode: 'GB',
      timezone: 'Europe/London',
      ageMs: 12 * DAY,
      childNames: ['Sumayya'],
      assignedToId: 1,
      lostReason: 'price',
      statusNote: 'Will come back next term.',
      contactAttempts: 2,
      firstResponseAt: iso(now - 12 * DAY + HOUR),
    },
    {
      status: 'spam',
      source: 'web_form',
      site: 'wpforms:4823',
      parentName: 'cheap seo offer',
      email: 'promo@example.com',
      phone: null,
      countryCode: null,
      timezone: 'Africa/Cairo',
      ageMs: 6 * DAY,
      childNames: [],
      assignedToId: null,
      spamScore: 80,
      spamFlags: ['links', 'odd_name'],
    },
    {
      status: 'job_applicant',
      source: 'web_form',
      site: 'app_trial',
      parentName: 'Mahmoud Teacher',
      email: 'mahmoud.applicant@example.com',
      phone: '+201000000777',
      countryCode: 'EG',
      timezone: 'Africa/Cairo',
      ageMs: 7 * DAY,
      childNames: [],
      assignedToId: 1,
      message: 'I would like to teach Quran with you.',
    },
    {
      status: 'new',
      source: 'walk_in',
      parentName: 'Rania Mostafa',
      phone: '+15550100099',
      countryCode: 'US',
      timezone: 'America/Chicago',
      ageMs: 26 * HOUR,
      childNames: ['Noah', 'Sara', 'Hana'],
      assignedToId: null,
    },
  ];

  seeds.forEach((s, index) => {
    const id = index + 1;
    const createdAt = iso(now - s.ageMs);
    const childNames = s.childNames ?? [];
    const children: LeadChildDto[] = childNames.map((name, i) => ({
      name,
      age: 7 + ((id + i) % 6),
      gender: i % 2 ? 'female' : 'male',
      courseId: 1 + ((id + i) % 3),
    }));
    const hasFamily = ['trial_scheduled', 'trial_done', 'converted'].includes(s.status);
    const familyId = hasFamily ? 500 + id : null;
    const students: LeadStudentRow[] = hasFamily
      ? children.map((c, i) => ({
          id: 900 + id * 10 + i,
          name: c.name ?? `Student ${i + 1}`,
          age: c.age ?? null,
          gender: c.gender ?? null,
          courseId: c.courseId ?? 1,
          enrollments:
            s.status === 'converted'
              ? [
                  {
                    id: 700 + id,
                    kind: 'regular',
                    courseId: c.courseId ?? 1,
                    teacherId: 2,
                    status: 'active',
                  },
                ]
              : [],
        }))
      : [];
    const activities: LeadActivityDto[] = [
      {
        id: activityId++,
        type: 'created',
        body: null,
        callResult: null,
        meta: { source: s.source },
        user: null,
        createdAt,
      },
    ];
    if (s.contactAttempts) {
      activities.push({
        id: activityId++,
        type: 'call',
        body: s.unansweredAttempts ? null : 'Spoke with the parent about the trial.',
        callResult: s.unansweredAttempts ? 'no_answer' : 'reached',
        meta: {},
        user: staffRef(s.assignedToId ?? 1),
        createdAt: iso(now - s.ageMs + HOUR),
      });
    }
    const trials: LeadTrialDto[] = [];
    if (hasFamily && students[0]) {
      const startsAt =
        s.status === 'trial_scheduled' ? now + 26 * HOUR : now - (s.ageMs - 2 * DAY) / 2;
      trials.push(trialOf(500 + id, students[0], startsAt, s.timezone!, s.status));
      activities.push({
        id: activityId++,
        type: 'trial_booked',
        body: null,
        callResult: null,
        meta: { sessionId: 500 + id },
        user: staffRef(s.assignedToId ?? 1),
        createdAt: iso(now - s.ageMs + 2 * HOUR),
      });
    }
    leads.push({
      site: null,
      email: null,
      phone: null,
      countryCode: null,
      timezone: 'Africa/Cairo',
      city: null,
      preferredLanguage: 'ar',
      courseInterest: null,
      preferredTimes: null,
      preferredSchedule: null,
      teacherGenderPref: null,
      heardFrom: null,
      message: null,
      assignedToId: null,
      nextFollowUpAt: null,
      lastContactedAt: null,
      firstResponseAt: null,
      contactAttempts: 0,
      unansweredAttempts: 0,
      familyName: hasFamily ? s.parentName : null,
      familyStatus: hasFamily ? (s.status === 'converted' ? 'regular' : 'trial') : null,
      referralFamily: null,
      trialOutcome: null,
      lostReason: null,
      statusNote: null,
      spamScore: 0,
      spamFlags: [],
      submissions: 1,
      convertedAt: null,
      convertedById: null,
      utm: s.source === 'web_form' ? { source: 'google', medium: 'cpc' } : null,
      ...s,
      id,
      createdAt,
      children,
      familyId,
      students,
      activities: activities.reverse(),
      trials,
    });
  });

  // Duplicates: the walk-in shares a phone prefix family with nobody; Omar's second lead.
  leads.push({
    ...leads[1]!,
    id: leads.length + 1,
    status: 'lost',
    lostReason: 'duplicate',
    assignedToId: 21,
    createdAt: iso(now - 40 * DAY),
    activities: [],
    submissions: 1,
  });

  const notifications: NotificationRow[] = [
    {
      id: 1,
      userId: 1,
      kind: 'lead',
      event: 'assigned',
      data: { leadId: 1, parentName: 'Amina Rahman' },
      readAt: null,
      createdAt: iso(now - 45 * MIN),
    },
    {
      id: 2,
      userId: 1,
      kind: 'lead',
      event: 'unassigned',
      data: { leadId: 2, parentName: 'Omar Haddad' },
      readAt: null,
      createdAt: iso(now - 3 * HOUR),
    },
    {
      id: 3,
      userId: 1,
      kind: 'lead',
      event: 'follow_up_due',
      data: { leadId: 4, parentName: 'Bilal Ahmed' },
      readAt: iso(now - DAY),
      createdAt: iso(now - DAY - HOUR),
    },
    // M8: a task alert and a published announcement for the accounts user (rows open their record).
    {
      id: 90,
      userId: 13,
      kind: 'task',
      event: 'assigned',
      data: { taskId: 7, title: 'متابعة طلب إجازة المعلم Ahmed', by: 'Rana Monitor' },
      readAt: null,
      createdAt: iso(now - 3 * 60 * MIN),
    },
    {
      id: 91,
      userId: 13,
      kind: 'announcement',
      event: 'published',
      data: { announcementId: 3, title: 'إجازة نصف العام' },
      readAt: null,
      createdAt: iso(now - 3 * 60 * MIN - MIN),
    },
  ];

  return {
    leads,
    settings: { ...CRM_DEFAULTS },
    notifications,
    referrals: 0,
    nextId: {
      lead: leads.length + 1,
      activity: activityId,
      family: 600,
      student: 1200,
      session: 800,
    },
  };
}

export function trialOf(
  sessionId: number,
  student: { id: number; name: string; courseId: number | null },
  startsAt: number,
  familyZone: string,
  status: string,
  teacher = { id: 2, name: 'Ahmed Fathy', timezone: 'Africa/Cairo' },
  durationMinutes = 30,
): LeadTrialDto {
  const local = (tz: string) =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(new Date(startsAt))
      .replace(' ', 'T');
  return {
    sessionId,
    student: { id: student.id, name: student.name },
    teacher: { id: teacher.id, name: teacher.name },
    course: student.courseId
      ? { id: student.courseId, nameAr: 'حفظ القرآن الكريم', nameEn: 'Quran Hifz' }
      : null,
    startsAt: iso(startsAt),
    durationMinutes,
    stage: status === 'trial_scheduled' ? 'scheduled' : 'completed',
    familyZone,
    teacherZone: teacher.timezone,
    familyLocal: local(familyZone),
    teacherLocal: local(teacher.timezone),
  };
}

export let crmdb: CrmDb = undefined as unknown as CrmDb;
resetCrmDb();

export function resetCrmDb() {
  crmdb = build();
}
