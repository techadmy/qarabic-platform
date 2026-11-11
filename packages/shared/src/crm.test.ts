import { describe, expect, it } from 'vitest';
import {
  bookTrialSchema,
  convertLeadSchema,
  createLeadSchema,
  CRM_SETTING_RULES,
  LEAD_ACTIVITY_LABELS,
  LEAD_ACTIVITY_TYPES,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  LEAD_STATUS_LABELS,
  LEAD_STATUSES,
  leadActivityInputSchema,
  leadListQuerySchema,
  leadStatusChangeSchema,
  LOST_REASON_LABELS,
  LOST_REASONS,
  publicTrialRequestSchema,
  updateCrmSettingsSchema,
  wpformsLeadSchema,
} from './index.js';

const errorPaths = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.path.join('.'));

describe('N5 CRM contract', () => {
  it('labels every status, source, lost reason and activity in Arabic and English', () => {
    for (const [values, labels] of [
      [LEAD_STATUSES, LEAD_STATUS_LABELS],
      [LEAD_SOURCES, LEAD_SOURCE_LABELS],
      [LOST_REASONS, LOST_REASON_LABELS],
      [LEAD_ACTIVITY_TYPES, LEAD_ACTIVITY_LABELS],
    ] as const) {
      for (const v of values) {
        const l = (labels as Record<string, { ar: string; en: string }>)[v]!;
        expect(l.ar.length).toBeGreaterThan(0);
        expect(l.en.length).toBeGreaterThan(0);
      }
    }
  });

  it('needs a phone or an email on a manual lead, from a manual source', () => {
    expect(
      errorPaths(createLeadSchema.safeParse({ parentName: 'Abu Omar', source: 'phone' })),
    ).toEqual(['phone']);
    expect(
      createLeadSchema.parse({
        parentName: ' Abu Omar ',
        email: ' A@Example.COM ',
        source: 'walk_in',
        countryCode: 'eg',
      }),
    ).toMatchObject({ parentName: 'Abu Omar', email: 'a@example.com', countryCode: 'EG' });
    expect(
      errorPaths(
        createLeadSchema.safeParse({ parentName: 'X1', phone: '+201', source: 'web_form' }),
      ),
    ).toContain('source');
  });

  it('asks for a note body, a call result and a lost reason', () => {
    expect(errorPaths(leadActivityInputSchema.safeParse({ type: 'note' }))).toEqual(['body']);
    expect(errorPaths(leadActivityInputSchema.safeParse({ type: 'call' }))).toEqual(['callResult']);
    expect(errorPaths(leadStatusChangeSchema.safeParse({ status: 'lost' }))).toEqual([
      'lostReason',
    ]);
    expect(
      leadActivityInputSchema.parse({ type: 'email', nextFollowUpAt: '2026-11-17T10:00:00+02:00' })
        .nextFollowUpAt,
    ).toBe('2026-11-17T08:00:00Z');
  });

  it('defaults the queue to open leads and checks the filters', () => {
    expect(leadListQuerySchema.parse({})).toMatchObject({ status: 'open', page: 1, perPage: 25 });
    expect(leadListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(leadListQuerySchema.safeParse({ assigned: 'me' }).success).toBe(true);
    expect(leadListQuerySchema.safeParse({ assigned: 'x' }).success).toBe(false);
    expect(leadListQuerySchema.parse({ uncontacted: '1' }).uncontacted).toBe(true);
  });

  it('books trials on a 5-minute grid with an https link only', () => {
    const base = {
      studentId: 1,
      courseId: 1,
      teacherId: 1,
      localDate: '2026-11-18',
      localTime: '17:00',
    };
    expect(bookTrialSchema.parse(base).acknowledgeWarnings).toEqual([]);
    expect(errorPaths(bookTrialSchema.safeParse({ ...base, durationMinutes: 33 }))).toEqual([
      'durationMinutes',
    ]);
    expect(errorPaths(bookTrialSchema.safeParse({ ...base, meetingUrl: 'http://x.test' }))).toEqual(
      ['meetingUrl'],
    );
  });

  it('converts each student once, sends no welcome mail unless asked (D140)', () => {
    const row = {
      studentId: 1,
      courseId: 1,
      teacherId: 1,
      startsOn: '2026-11-23',
      slots: [{ weekday: 1, localStartTime: '17:00' }],
    };
    expect(convertLeadSchema.parse({ students: [row] }).sendWelcome).toBe(false);
    expect(errorPaths(convertLeadSchema.safeParse({ students: [row, row] }))).toEqual([
      'students.1.studentId',
    ]);
  });

  it('keeps the website webhook payload in the snippet’s snake_case shape', () => {
    const parsed = wpformsLeadSchema.parse({
      form_id: 4823,
      entry_id: 1,
      fields: { name: 'Umm Adam', children_count: 2, student_age: '7 and 10' },
    });
    expect(parsed.fields.children_count).toBe('2');
    expect(
      wpformsLeadSchema.safeParse({ form_id: 4823, entry_id: 1, fields: { name: '' } }).success,
    ).toBe(false);
  });

  it('wants E.164 and the preferences on the public trial form', () => {
    const r = publicTrialRequestSchema.safeParse({
      parentName: 'Umm Yusuf',
      phone: '07700 900123',
      email: 'u@example.com',
      countryCode: 'GB',
      timezone: 'Europe/London',
      children: [{ name: 'Yusuf', age: 8, gender: 'male', courseId: 1 }],
      preferredDays: [6, 6],
      preferredPeriods: ['evening'],
      teacherGenderPref: 'any',
    });
    expect(errorPaths(r).sort()).toEqual(['phone', 'preferredDays']);
  });

  it('validates every CRM setting and refuses unknown keys', () => {
    expect(Object.keys(CRM_SETTING_RULES)).toHaveLength(11);
    expect(updateCrmSettingsSchema.safeParse({ 'crm.shift_source': 'always' }).success).toBe(false);
    expect(updateCrmSettingsSchema.safeParse({ 'crm.unknown': 1 }).success).toBe(false);
    expect(updateCrmSettingsSchema.safeParse({ 'crm.working_hours_start': '09:30' }).success).toBe(
      true,
    );
  });
});
