import { describe, expect, it } from 'vitest';
import { FieldCipher } from '../common/crypto.js';
import type { Row } from './convert.js';
import { FIXTURE_LEGACY_KEY, laravelEncrypt, legacyFixture } from './fixture.js';
import { checkTarget } from './guard.js';
import { buildPlan, type Plan } from './import.service.js';
import { LaravelCipher, unserializeString } from './laravel-crypt.js';
import { rates, slotTiers } from './mappers/payroll.js';
import { selectModules } from './modules.js';
import { MemorySource } from './source.js';

const target = new FieldCipher(Buffer.alloc(32, 7));

async function plan(data = legacyFixture(), withKey = true): Promise<Plan> {
  return buildPlan(new MemorySource(data), {
    only: null,
    appTimezone: 'UTC',
    legacyCipher: withKey ? new LaravelCipher(FIXTURE_LEGACY_KEY) : null,
    targetCipher: target,
  });
}

const rows = (p: Plan, table: string): Row[] => p.batches.find((b) => b.table === table)!.rows;
const row = (p: Plan, table: string, id: number): Row => rows(p, table).find((r) => r.id === id)!;
const issues = (p: Plan, table: string) =>
  p.ctx.report.issues
    .filter((i) => i.table === table)
    .map((i) => `${i.kind}:${i.id ?? ''}:${i.reason}`);

describe('legacy mappers', () => {
  it('keeps every primary key and carries bcrypt hashes as they are', async () => {
    const p = await plan();
    expect(rows(p, 'users').map((u) => u.id)).toEqual([1, 5, 10, 20, 21]);
    expect(row(p, 'users', 1).passwordHash).toMatch(/^\$2y\$12\$/);
    expect(rows(p, 'class_sessions').map((s) => s.id)).toEqual([100, 101, 102, 103]);
    expect(rows(p, 'invoices').map((s) => s.id)).toEqual([40, 41]);
  });

  it('normalises users: lower-case email, E.164 phone, zone, deleted = archived', async () => {
    const p = await plan();
    expect(row(p, 'users', 20)).toMatchObject({
      email: 'parent@fixture.test',
      phone: '+447700900020',
      timezone: 'Europe/London',
    });
    expect(row(p, 'users', 5).phone).toBeNull();
    const old = row(p, 'users', 21);
    expect(old).toMatchObject({
      name: 'old.staff',
      locale: 'ar',
      timezone: 'Africa/Cairo',
      isActive: false,
    });
    expect((old.archivedAt as Date).toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(issues(p, 'users').some((i) => i.includes('phone is not E.164'))).toBe(true);
  });

  it('keeps only matrix permissions and reports old Spatie names', async () => {
    const p = await plan();
    expect(rows(p, 'permissions').map((x) => x.name)).toEqual(['families.view']);
    expect(rows(p, 'role_permissions')).toEqual([{ roleId: 5, permissionId: 2 }]);
    expect(issues(p, 'permissions')[0]).toContain('"Dashboard"');
  });

  it('maps families: zone from time_zone_id, legacy status, day-first start date, billing profile', async () => {
    const p = await plan();
    const f = row(p, 'families', 7);
    expect(f).toMatchObject({
      timezone: 'Europe/London',
      countryCode: 'GB',
      status: 'on_leave',
      whatsappGroupId: 'wa-1',
      trialDate: null,
    });
    expect((f.startDate as Date).toISOString().slice(0, 10)).toBe('2026-03-15');
    expect(rows(p, 'family_billing_profiles')[0]).toMatchObject({
      familyId: 7,
      currency: 'GBP',
      billingDay: 15,
      enabled: true,
      customFee: '60.00',
    });
    expect(rows(p, 'student_fee_packages')).toEqual([
      expect.objectContaining({ studentId: 11, feePackageId: 2 }),
    ]);
  });

  it('maps students: codes, bad values reported, soft-deleted kept archived', async () => {
    const p = await plan();
    expect(row(p, 'students', 11)).toMatchObject({
      familyId: 7,
      gender: 'male',
      language: 'english',
      teacherId: 3,
    });
    expect(row(p, 'students', 12)).toMatchObject({
      gender: 'female',
      age: null,
      language: null,
      teacherId: null,
    });
    expect(row(p, 'students', 12).archivedAt).toBeInstanceOf(Date);
  });

  it('times classes: UTC starts_at kept, legacy rows from academy-local date + time (Cairo DST)', async () => {
    const p = await plan();
    expect((row(p, 'class_sessions', 100).startsAt as Date).toISOString()).toBe(
      '2026-10-19T16:00:00.000Z',
    );
    const legacy = row(p, 'class_sessions', 101);
    // 2026-10-28 18:00 Cairo summer time (UTC+3) → 15:00Z; 45 minutes from the TIME duration.
    expect((legacy.startsAt as Date).toISOString()).toBe('2026-10-28T15:00:00.000Z');
    expect((legacy.endsAt as Date).toISOString()).toBe('2026-10-28T15:45:00.000Z');
    expect(legacy).toMatchObject({ stage: 'ended', durationMinutes: 45 });
    expect(p.batches.find((b) => b.table === 'class_sessions')!.selfRefs![0]!.pairs).toEqual([
      [102, 100],
    ]);
  });

  it('re-encrypts Laravel-encrypted links with the new key, or reports them without LEGACY_APP_KEY', async () => {
    const p = await plan();
    expect(target.decrypt(row(p, 'class_sessions', 103).zoomJoinUrl as string)).toBe(
      'https://zoom.example.test/j/900',
    );
    expect(target.decrypt(row(p, 'enrollments', 4).externalMeetingUrl as string)).toBe(
      'https://meet.example.test/room-4',
    );
    expect(target.decrypt(row(p, 'tickets', 51).contactPhone as string)).toBe('+447700900020');
    const bare = await plan(legacyFixture(), false);
    expect(row(bare, 'class_sessions', 103)).toMatchObject({
      zoomJoinUrl: null,
      zoomStatus: 'pending',
    });
    expect(issues(bare, 'enrollments').join()).toContain('LEGACY_APP_KEY is not set');
  });

  it('reads both Laravel encrypt() (serialised) and encryptString()', () => {
    const c = new LaravelCipher(FIXTURE_LEGACY_KEY);
    expect(c.decrypt(laravelEncrypt('plain'))).toBe('plain');
    expect(c.decrypt(laravelEncrypt('s:5:"hello";'))).toBe('hello');
    expect(c.decrypt('garbage')).toBeNull();
    expect(unserializeString('s:3:"abc";')).toBe('abc');
  });

  it('reports what the new schema cannot hold', async () => {
    const p = await plan();
    expect(issues(p, 'session_requests').join()).toContain('extra request without a class');
    expect(issues(p, 'hifz_entries').join()).toContain('half juz');
    expect(issues(p, 'leads').join()).toContain('soft-deleted lead');
    expect(issues(p, 'app_settings').join()).toContain('legacy.flag');
    expect(issues(p, 'fee_package_prices').join()).toContain('price not above 0');
    expect(issues(p, 'payments').join()).toContain('amount not above 0');
    expect(p.unported.map((u) => u.table)).toContain('country');
    expect(
      p.ctx.report.issues.some((i) => i.kind === 'no_counterpart' && i.table === 'class_requests'),
    ).toBe(true);
  });

  it('applies the new CHECK rules: ticket closed_at, scores, signs, check-out', async () => {
    const p = await plan();
    expect(row(p, 'tickets', 50)).toMatchObject({
      closedAt: null,
      subjectType: null,
      subjectId: null,
    });
    expect((row(p, 'tickets', 51).closedAt as Date).toISOString()).toBe('2026-10-05T10:00:00.000Z');
    expect(row(p, 'tickets', 51)).toMatchObject({ category: 'other', queue: 'general' });
    expect(row(p, 'student_tests', 1)).toMatchObject({
      overallScore: null,
      tajweedScore: 80,
      mistakes: [3, 12],
      sections: ['makharij'],
    });
    expect(row(p, 'payslip_lines', 2)).toMatchObject({ sign: -1, amount: '5.00' });
    expect(row(p, 'pay_adjustments', 2)).toMatchObject({ amount: '2.00' });
    expect(row(p, 'staff_attendance', 2).checkOutAt).toBeNull();
    expect(row(p, 'lesson_reports', 1)).toMatchObject({ rating: 4, submittedLate: true });
    expect((row(p, 'lesson_reports', 1).dueAt as Date).toISOString()).toBe(
      '2026-10-20T16:30:00.000Z',
    );
  });

  it('converts money exactly and payroll JSON to the Nest shapes', async () => {
    const p = await plan();
    expect(row(p, 'invoices', 40)).toMatchObject({
      subtotal: '32.00',
      discounts: '-3.20',
      total: '28.80',
      paid: '28.80',
    });
    expect(row(p, 'invoice_lines', 1).meta).toEqual({ source: 'package', fullAmount: '32.00' });
    expect(row(p, 'payments', 60)).toMatchObject({ method: 'stripe', amount: '28.80' });
    expect(row(p, 'payslips', 4)).toMatchObject({
      currency: 'EGP',
      net: '115.50',
      warnings: [{ code: 'unmarked_sessions', count: 1 }],
    });
    expect(
      slotTiers([
        { min_slots: 2, amount_minor: 50000 },
        { min_slots: 0, amount_minor: 10000 },
      ]),
    ).toEqual([
      { minSlots: 0, amount: '100.00' },
      { minSlots: 2, amount: '500.00' },
    ]);
    expect(rates({ hourly_rate_minor: 12050, slot_tiers: [] })).toEqual({
      hourlyRate: '120.50',
      slotTiers: [],
    });
    // Legacy amount_per_hour → a new hourly profile after the highest imported id.
    expect(row(p, 'pay_profiles', 9)).toMatchObject({
      userId: 10,
      teacherId: 3,
      salaryType: 'hourly',
      hourlyRate: '120.50',
    });
    expect(row(p, 'pay_rule_sets', 1).rules).toMatchObject({
      'cancelled:holiday': { paidHolidayOnly: true },
    });
  });

  it('gives notifications integer ids, oldest first', async () => {
    const p = await plan();
    expect(rows(p, 'notifications').map((n) => [n.id, n.kind, n.event])).toEqual([
      [1, 'session_request', 'created'],
      [2, 'lead', 'assigned'],
    ]);
    expect(rows(p, 'notifications')[1]!.data).toEqual({ leadId: 30, parentName: 'Fixture Lead' });
  });
});

describe('legacy import guards', () => {
  it('refuses a target that is not _rehearsal/_dev/_test without the production flag', () => {
    expect(checkTarget('postgresql://u:secret@h:5432/qarabic', false)).toMatchObject({ ok: false });
    const refused = checkTarget('postgresql://u:secret@h:5432/qarabic', false);
    expect(refused.ok ? '' : refused.message).not.toContain('secret');
    expect(checkTarget('postgresql://u@h/qarabic_rehearsal', false)).toEqual({ ok: true });
    expect(checkTarget('postgresql://u@h/qarabic_test', false)).toEqual({ ok: true });
    expect(checkTarget('postgresql://u@h/qarabic', true)).toEqual({ ok: true });
  });

  it('reloads the dependents of a module (--only)', () => {
    expect(selectModules(['billing']).map((m) => m.name)).toEqual(['billing']);
    expect(selectModules(['sessions']).map((m) => m.name)).toEqual([
      'sessions',
      'teaching',
      'payroll',
    ]);
    expect(selectModules(['people'])).toHaveLength(8);
    expect(() => selectModules(['nope'])).toThrow(/Unknown module/);
  });
});
