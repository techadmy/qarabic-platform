import { permissionsFor, ROLES, type Role } from '@qarabic/shared';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStorage } from '../src/common/storage.js';
import { auditRoutes } from '../src/common/route-audit.js';
import {
  type Client,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  makeFamily,
  m2Teacher,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import { fbTicket, PNG } from './n4-helpers.js';
import { crmLead } from './n5-helpers.js';
import { issuedInvoice, makeFeePackage, resetBilling } from './n6-helpers.js';
import { m6At, m6Profile, userWithRole } from './payroll-helpers.js';

/**
 * docs/39 P1-6 (RBAC-2). Three layers:
 * 1. Every system role × every permission route: 403 exactly when `ROLE_PERMISSIONS` does not grant
 *    the route's permission(s) — generated, so a role/route change is tested the day it lands.
 * 2. The routes a parent and a teacher pass at the guard are pinned: a portal role gaining a staff
 *    permission (or a new portal route) changes the list and fails here until reviewed.
 * 3. Those routes depend on handler scoping: for every one with an id, family B's / teacher 2's id
 *    answers 404 to parent A / teacher 1 and their own id does not; every list answers without B's
 *    names. A last test fails if a portal route is in none of the tables.
 */

let ctx: TestContext;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
async function call(client: Client, route: string, params: Record<string, number> = {}, body = {}) {
  const [method, path] = route.split(' ') as [Method, string];
  const url = '/' + path.replace(/:(\w+)/g, (_, k: string) => String(params[k] ?? 999_999));
  switch (method) {
    case 'GET':
      return client.get(url);
    case 'POST':
      return client.post(url, body);
    case 'PATCH':
      return client.patch(url, body);
    case 'PUT':
      return client.put(url, body);
    default:
      return client.delete(url, body);
  }
}

/**
 * Routes a handler also gates by profile (a parent's family, a teacher's record): a bare role user
 * has none, so the matrix leaves them to the scoping tests below, which use real profiles.
 */
const KIND_ONLY: Record<string, Role> = {
  'GET parent/home': 'parent',
  'GET teacher-portal/students': 'teacher',
  'GET teacher-portal/week': 'teacher',
};

/** Queries a route validates before its handler runs (so the handler's own rule is reached). */
const REQUIRED_QUERY: Record<string, string> = { 'GET tests/summary': '?month=2026-11' };

/** Routes a role passes at the guard but the handler refuses to that role outright (403). */
const HANDLER_DENIES: Record<string, Role[]> = {
  'GET lesson-reports': ['parent'],
  'GET tests/summary': ['parent'],
};

const permissionRoutes = () => auditRoutes(ctx.app).filter((r) => r.access === 'permission');
const grants = (role: Role, r: { mode?: string | null; permissions: string[] }) => {
  if (role === 'admin') return true;
  const mine = new Set<string>(permissionsFor(role));
  return r.mode === 'any'
    ? r.permissions.some((p) => mine.has(p))
    : r.permissions.every((p) => mine.has(p));
};

beforeAll(async () => {
  ctx = await createTestApp();
  await resetState(ctx);
  resetBilling(ctx);
  m6At(ctx, '2026-11-15T08:00:00Z');
});
afterAll(async () => {
  await ctx.app.close();
});

// ------------------------------------------------------------------ 1. the matrix

describe('role × route matrix (generated from ROLE_PERMISSIONS)', () => {
  it.each(ROLES)(
    '%s: 403 on exactly the permission routes its role does not grant',
    async (role) => {
      const { client } = await signedIn(ctx, role);
      const wrong: string[] = [];
      // Kind-gated routes need a real family / teacher profile: covered by the scoping tests.
      for (const r of permissionRoutes().filter((x) => !KIND_ONLY[x.route])) {
        const res = await call(client, r.route + (REQUIRED_QUERY[r.route] ?? ''));
        const denied = res.status === 403 && res.body?.code === 'forbidden';
        const expected = grants(role, r) && !HANDLER_DENIES[r.route]?.includes(role);
        if (expected === denied) {
          wrong.push(`${r.route} → ${res.status} ${res.body?.code ?? ''} (granted: ${expected})`);
        }
      }
      expect(wrong).toEqual([]);
    },
  );
});

// ------------------------------------------------------------------ 2. the portal surfaces

/** Pinned on purpose: review any change (docs/39 RBAC-2; a portal role must never gain staff rights). */
const PARENT_ROUTES = [
  'GET announcements',
  'GET announcements/:id',
  'GET billing/providers',
  'GET enrollments',
  'GET enrollments/:id',
  'GET families',
  'GET families/:familyId/billing',
  'GET families/:id',
  'GET feedback/attachments/:id',
  'GET feedback/summary',
  'GET feedback/tickets',
  'GET feedback/tickets/:id',
  'GET holidays',
  'GET invoices',
  'GET invoices/:id',
  'GET invoices/:id/print',
  'GET lesson-reports',
  'GET parent/home',
  'GET schedule/availability',
  'GET session-requests',
  'GET session-requests/:id',
  'GET sessions',
  'GET sessions/:id',
  'GET sessions/:id/report',
  'GET sessions/:id/zoom/join',
  'GET sessions/board',
  'GET students',
  'GET students/:id',
  'GET students/:id/progress',
  'GET support/mine',
  'GET teachers/:teacherId/blocks',
  'GET teachers/:teacherId/timetable',
  'GET teachers/:teacherId/work-hours',
  'GET tests',
  'GET tests/:id',
  'GET tests/summary',
  'POST announcements/:id/read',
  'POST feedback/tickets',
  'POST feedback/tickets/:id/comments',
  'POST feedback/tickets/:id/confirm',
  'POST feedback/tickets/:id/seen',
  'POST invoices/:id/checkout',
  'POST invoices/:id/paypal/capture',
  'POST me/referrals',
  'POST schedule/check',
  'POST session-requests',
  'POST session-requests/:id/cancel',
  'POST support/tickets/:id/request/answer',
];

const TEACHER_ROUTES = [
  'GET announcements',
  'GET announcements/:id',
  'GET attendance',
  'GET attendance/today',
  'GET enrollments',
  'GET enrollments/:id',
  'GET feedback/attachments/:id',
  'GET feedback/summary',
  'GET feedback/tickets',
  'GET feedback/tickets/:id',
  'GET leave-requests',
  'GET leave-requests/:id',
  'GET lesson-reports',
  'GET me/payslips',
  'GET me/trial-offers',
  'GET me/wallet',
  'GET payroll/adjustments',
  'GET payroll/adjustments/:id',
  'GET payslips/:id',
  'GET session-requests',
  'GET session-requests/:id',
  'GET sessions',
  'GET sessions/:id',
  'GET sessions/:id/report',
  'GET sessions/:id/trial-report',
  'GET sessions/:id/zoom/join',
  'GET sessions/:id/zoom/start',
  'GET sessions/board',
  'GET students',
  'GET students/:id',
  'GET students/:id/progress',
  'GET support/mine',
  'GET teacher-portal/students',
  'GET teacher-portal/week',
  'GET teachers/:teacherId/blocks',
  'GET teachers/:teacherId/timetable',
  'GET teachers/:teacherId/work-hours',
  'GET tests',
  'GET tests/:id',
  'GET tests/summary',
  'PATCH tests/:id',
  'POST announcements/:id/read',
  'POST attendance/check-in',
  'POST attendance/check-out',
  'POST feedback/tickets',
  'POST feedback/tickets/:id/comments',
  'POST feedback/tickets/:id/confirm',
  'POST feedback/tickets/:id/seen',
  'POST leave-requests',
  'POST leave-requests/:id/cancel',
  'POST me/trial-offers/:id/accept',
  'POST me/trial-offers/:id/decline',
  'POST session-requests',
  'POST session-requests/:id/cancel',
  'POST sessions/:id/transitions',
  'POST support/tickets/:id/request/answer',
  'POST tests',
  'POST tests/:id/cancel',
  'POST tests/:id/refuse',
  'PUT sessions/:id/report',
  'PUT sessions/:id/trial-report',
  'PUT teachers/:teacherId/work-hours',
  'PUT tests/:id/result',
];

describe('portal surfaces (what a parent / teacher passes at the guard)', () => {
  it.each([
    ['parent', PARENT_ROUTES],
    ['teacher', TEACHER_ROUTES],
  ] as const)('%s: exactly the pinned routes', (role, pinned) => {
    const passes = permissionRoutes()
      .filter((r) => grants(role, r))
      .map((r) => r.route)
      .sort();
    expect(passes).toEqual([...pinned].sort());
  });
});

// ------------------------------------------------------------------ 3. row scoping

/**
 * Two families and two teachers. Family A (parent A) is taught by teacher 1, family B by teacher 2.
 * Every name of the B side contains «Bravo»: no portal answer of A's side may contain it.
 */
interface World {
  parentA: Client;
  teacher1: Client;
  A: Record<string, number>;
  B: Record<string, number>;
}
let w: World;

async function side(tag: 'Alpha' | 'Bravo', pkg: { id: number }) {
  const teacher = await m2Teacher(ctx, 'Africa/Cairo', `${tag}Teacher`);
  await m6Profile(ctx, teacher.userId, { teacherId: teacher.id, hourlyRate: '300.00' });
  const family = await makeFamily(ctx, { user: { name: `${tag} Parent` } });
  await ctx.prisma.familyBillingProfile.create({
    data: { familyId: family.id, currency: 'USD', billingDay: 1, enabled: true },
  });
  const student = await m2Student(ctx, 'Europe/London', family, `${tag} Child`);
  await ctx.prisma.studentFeePackage.create({
    data: { studentId: student.id, feePackageId: pkg.id },
  });
  const enrollment = await m2Enrollment(ctx, student, teacher);
  // A taken class last month (report, payslip) and a scheduled one ahead (requests, transitions).
  const taken = await m2Session(ctx, enrollment, '2026-10-05T10:00:00Z', { stage: 'taken' });
  const ahead = await m2Session(ctx, enrollment, '2026-11-20T10:00:00Z');
  const trial = await m2Session(ctx, enrollment, '2026-11-21T10:00:00Z', { kind: 'trial' });
  await ctx.prisma.lessonReport.create({
    data: {
      sessionId: taken.id,
      studentId: student.id,
      teacherId: teacher.id,
      summary: `${tag} lesson`,
      dueAt: new Date('2026-10-05T12:00:00Z'),
      submittedAt: new Date('2026-10-05T11:00:00Z'),
    },
  });
  const invoice = await issuedInvoice(ctx, family);
  const parentTicket = await fbTicket(ctx, family.user, {}, `${tag} parent ticket`);
  const teacherTicket = await fbTicket(ctx, teacher.user, {}, `${tag} teacher ticket`);
  const attach = async (ticketId: number, key: string) => {
    await ctx.app.get(FileStorage).put(key, PNG);
    return ctx.prisma.ticketAttachment.create({
      data: {
        ticketId,
        source: 'upload',
        storageKey: key,
        mime: 'image/png',
        size: PNG.length,
        sha256: createHash('sha256').update(PNG).digest('hex'),
        originalName: 'screen.png',
      },
    });
  };
  const attachment = await attach(parentTicket.id, `tickets/${tag.toLowerCase()}-p.png`);
  const teacherAttachment = await attach(teacherTicket.id, `tickets/${tag.toLowerCase()}-t.png`);
  const request = await ctx.prisma.sessionRequest.create({
    data: {
      type: 'leave',
      sessionId: ahead.id,
      enrollmentId: enrollment.id,
      studentId: student.id,
      requestedById: family.userId,
      requesterRole: 'parent',
      reason: `${tag} family trip`,
    },
  });
  const test = await ctx.prisma.studentTest.create({
    data: {
      studentId: student.id,
      teacherId: teacher.id,
      courseId: enrollment.courseId,
      track: 'hifz',
      scheduledAt: new Date('2026-11-25T10:00:00Z'),
      studentTimezone: 'Europe/London',
    },
  });
  const leave = await ctx.prisma.leaveRequest.create({
    data: {
      userId: teacher.userId,
      startsOn: new Date('2026-12-01T00:00:00Z'),
      endsOn: new Date('2026-12-01T00:00:00Z'),
      days: 1,
      leaveType: 'paid',
      reason: `${tag} leave`,
    },
  });
  const adjustment = await ctx.prisma.payAdjustment.create({
    data: {
      userId: teacher.userId,
      type: 'bonus',
      amount: '10.00',
      currency: 'EGP',
      effectiveOn: new Date('2026-11-10T00:00:00Z'), // not in the October run below
      reason: `${tag} bonus`,
      // Approved: a teacher sees their own approved items (a proposal stays with payroll staff).
      status: 'approved',
    },
  });
  const lead = await crmLead(ctx, { parentName: `${tag} Lead` });
  const offer = await ctx.prisma.trialOffer.create({
    data: {
      leadId: lead.id,
      studentId: student.id,
      courseId: enrollment.courseId,
      startsAt: new Date('2026-11-28T10:00:00Z'),
      durationMinutes: 30,
      timezone: 'Europe/London',
      audience: 'all',
      expiresAt: new Date('2026-11-27T10:00:00Z'),
      teachers: { create: [{ teacherId: teacher.id, rank: 1 }] },
    },
  });
  return {
    teacher,
    family,
    ids: {
      family: family.id,
      student: student.id,
      enrollment: enrollment.id,
      taken: taken.id,
      ahead: ahead.id,
      trial: trial.id,
      invoice: invoice.id,
      parentTicket: parentTicket.id,
      teacherTicket: teacherTicket.id,
      attachment: attachment.id,
      teacherAttachment: teacherAttachment.id,
      request: request.id,
      test: test.id,
      leave: leave.id,
      adjustment: adjustment.id,
      offer: offer.id,
      teacherId: teacher.id,
      teacherUser: teacher.userId,
    },
  };
}

/** [route, params from a side's ids, body]. Own side: not 404/403. Other side: 404. */
type Row = [
  string,
  (ids: Record<string, number>) => Record<string, number>,
  object?,
  /** The other side's status when not 404 (see the row's note). */
  number?,
];
const id = (k: string) => (ids: Record<string, number>) => ({ id: ids[k]! });
const teacherOf = (ids: Record<string, number>) => ({ teacherId: ids.teacherId! });

const PARENT_ROWS: Row[] = [
  ['GET enrollments/:id', id('enrollment')],
  ['GET families/:familyId/billing', (ids) => ({ familyId: ids.family! })],
  ['GET families/:id', id('family')],
  ['GET feedback/attachments/:id', id('attachment')],
  ['GET feedback/tickets/:id', id('parentTicket')],
  ['POST feedback/tickets/:id/comments', id('parentTicket'), { body: 'E2E comment' }],
  ['POST feedback/tickets/:id/confirm', id('parentTicket'), { resolved: true }],
  ['POST feedback/tickets/:id/seen', id('parentTicket')],
  ['GET invoices/:id', id('invoice')],
  ['GET invoices/:id/print', id('invoice')],
  ['POST invoices/:id/checkout', id('invoice'), { provider: 'stripe' }],
  ['POST invoices/:id/paypal/capture', id('invoice'), { orderId: 'ORDER-1' }],
  ['GET session-requests/:id', id('request')],
  ['POST session-requests/:id/cancel', id('request'), {}],
  ['GET sessions/:id', id('taken')],
  ['GET sessions/:id/report', id('taken')],
  ['GET sessions/:id/zoom/join', id('ahead')],
  ['GET students/:id', id('student')],
  ['GET students/:id/progress', id('student')],
  ['GET tests/:id', id('test')],
  ['POST support/tickets/:id/request/answer', id('parentTicket'), { accept: true }],
];

const TEACHER_ROWS: Row[] = [
  ['GET enrollments/:id', id('enrollment')],
  ['GET feedback/attachments/:id', id('teacherAttachment')],
  ['GET feedback/tickets/:id', id('teacherTicket')],
  ['POST feedback/tickets/:id/comments', id('teacherTicket'), { body: 'E2E comment' }],
  ['POST feedback/tickets/:id/confirm', id('teacherTicket'), { resolved: true }],
  ['POST feedback/tickets/:id/seen', id('teacherTicket')],
  ['GET leave-requests/:id', id('leave')],
  ['POST leave-requests/:id/cancel', id('leave'), { note: 'E2E cancel' }],
  ['GET payroll/adjustments/:id', id('adjustment')],
  ['GET payslips/:id', id('payslip')],
  ['GET session-requests/:id', id('request')],
  ['POST session-requests/:id/cancel', id('request'), {}],
  ['GET sessions/:id', id('taken')],
  ['GET sessions/:id/report', id('taken')],
  ['GET sessions/:id/trial-report', id('trial')],
  ['GET sessions/:id/zoom/join', id('ahead')],
  ['GET sessions/:id/zoom/start', id('ahead')],
  [
    'POST sessions/:id/transitions',
    id('ahead'),
    { action: 'activate', expectedStage: 'scheduled' },
  ],
  ['PUT sessions/:id/report', id('taken'), { summary: 'E2E edit' }],
  [
    'PUT sessions/:id/trial-report',
    id('trial'),
    {
      attendance: 'on_time',
      level: 'beginner',
      classesPerWeek: 2,
      minutesPerClass: 30,
      engagement: 'high',
    },
  ],
  ['GET students/:id', id('student')],
  ['GET students/:id/progress', id('student')],
  ['GET teachers/:teacherId/blocks', teacherOf],
  ['GET teachers/:teacherId/timetable', teacherOf],
  ['GET teachers/:teacherId/work-hours', teacherOf],
  // Another teacher's hours: refused with 403, not 404 (no data leaks; reported as an
  // inconsistency with the 404 reads, docs/39-evidence/p1-6-role-route-matrix.md).
  ['PUT teachers/:teacherId/work-hours', teacherOf, { workHours: [] }, 403],
  ['GET tests/:id', id('test')],
  ['PATCH tests/:id', id('test'), { notes: 'E2E' }],
  ['POST tests/:id/cancel', id('test'), { reason: 'E2E cancel' }],
  ['POST tests/:id/refuse', id('test'), { reason: 'E2E refuse' }],
  ['PUT tests/:id/result', id('test'), { mistakes: [] }],
  ['POST me/trial-offers/:id/accept', id('offer'), {}],
  ['POST me/trial-offers/:id/decline', id('offer'), {}],
  ['POST support/tickets/:id/request/answer', id('teacherTicket'), { accept: true }],
];

/** Lists and creates: answered without any of B's names. */
const PARENT_LISTS = [
  'GET enrollments',
  'GET families',
  'GET feedback/summary',
  'GET feedback/tickets',
  'GET invoices',
  'GET parent/home',
  'GET session-requests',
  'GET sessions',
  'GET sessions/board',
  'GET students',
  'GET support/mine',
  'GET tests',
];
const TEACHER_LISTS = [
  'GET attendance',
  'GET attendance/today',
  'GET enrollments',
  'GET feedback/summary',
  'GET feedback/tickets',
  'GET leave-requests',
  'GET lesson-reports',
  'GET me/payslips',
  'GET me/trial-offers',
  'GET me/wallet',
  'GET payroll/adjustments',
  'GET session-requests',
  'GET sessions',
  'GET sessions/board',
  'GET students',
  'GET support/mine',
  'GET teacher-portal/students',
  'GET teacher-portal/week',
  'GET tests',
  'GET tests/summary?month=2026-11',
];

/**
 * Routes a parent passes at the guard but the handler refuses to every parent (any id): the
 * status, and why.
 */
const PARENT_DENIED: Array<[string, number, string]> = [
  ['GET lesson-reports', 403, 'the reports list is for staff and teachers'],
  ['GET tests/summary?month=2026-11', 403, 'the month summary is for staff and teachers'],
  ['GET teachers/:teacherId/blocks', 404, 'a parent reads no teacher calendar'],
  ['GET teachers/:teacherId/timetable', 404, 'a parent reads no teacher calendar'],
  ['GET teachers/:teacherId/work-hours', 404, 'a parent reads no teacher calendar'],
];

/** Not row-scoped by family/teacher, each for a stated reason. */
const NOT_ROW_SCOPED: Record<string, string> = {
  'GET announcements': 'academy-wide, by audience role',
  'GET announcements/:id': 'academy-wide, by audience role',
  'POST announcements/:id/read': 'marks the caller’s own read receipt',
  'GET billing/providers': 'which card/PayPal providers are on (no family data)',
  'GET holidays': 'academy-wide calendar',
  'GET schedule/availability': 'free times of teachers for a new booking (no family data)',
  'POST schedule/check': 'conflict check of a proposed time (answers for the caller’s input)',
  'POST feedback/tickets': 'creates the caller’s own ticket',
  'POST me/referrals': 'creates a referral from the caller’s family',
  'POST session-requests': 'creates a request; the session id is scope-checked (own rows above)',
  'POST attendance/check-in': 'the caller’s own attendance',
  'POST attendance/check-out': 'the caller’s own attendance',
  'POST leave-requests': 'the caller’s own leave',
  'POST tests': 'schedules a test; the student id is scope-checked by the service',
};

describe('row scoping of the portal routes', () => {
  beforeAll(async () => {
    const pkg = await makeFeePackage(ctx);
    const a = await side('Alpha', pkg);
    const b = await side('Bravo', pkg);
    // Payslips of last month for both teachers (run → review → approve).
    const accounts = (await userWithRole(ctx, 'accounts')).client;
    const senior = (await userWithRole(ctx, 'senior_manager')).client;
    const run = await accounts.post('/payroll/runs', { period: '2026-10' });
    expect(run.status).toBe(201);
    const runId = (run.body as { data: { id: number } }).data.id;
    const reviewed = await senior.post(`/payroll/runs/${runId}/review`);
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect((await accounts.post(`/payroll/runs/${runId}/approve`)).status).toBe(200);
    for (const s of [a, b]) {
      const slip = await ctx.prisma.payslip.findFirstOrThrow({
        where: { userId: s.ids.teacherUser },
      });
      (s.ids as Record<string, number>).payslip = slip.id;
    }
    w = {
      parentA: await signInAs(ctx, a.family.user),
      teacher1: await signInAs(ctx, a.teacher.user),
      A: a.ids,
      B: b.ids,
    };
  });

  it.each([
    ['parent A', 'parentA', PARENT_ROWS],
    ['teacher 1', 'teacher1', TEACHER_ROWS],
  ] as const)('%s: another family’s / teacher’s id → 404, own → served', async (_, who, rows) => {
    const client = w[who];
    const wrong: string[] = [];
    for (const [route, params, body, otherStatus = 404] of rows) {
      const other = await call(client, route, params(w.B), body);
      if (other.status !== otherStatus) {
        wrong.push(`${route} other → ${other.status} (want ${otherStatus})`);
      }
      const own = await call(client, route, params(w.A), body);
      // Own: found in scope (a 403 here is a rule of the action, e.g. only the requester cancels).
      if (own.status === 404) wrong.push(`${route} own → 404 (want found)`);
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ['parent A', 'parentA', PARENT_LISTS],
    ['teacher 1', 'teacher1', TEACHER_LISTS],
  ] as const)('%s: lists never show the other family / teacher', async (_, who, lists) => {
    const client = w[who];
    const wrong: string[] = [];
    for (const route of lists) {
      const res = await call(client, route);
      if (res.status >= 300) wrong.push(`${route} → ${res.status}`);
      else if (JSON.stringify(res.body).includes('Bravo')) wrong.push(`${route} shows «Bravo»`);
    }
    expect(wrong).toEqual([]);
  });

  it('parent A: the routes refused to every parent', async () => {
    const wrong: string[] = [];
    for (const [route, status] of PARENT_DENIED) {
      for (const ids of [w.A, w.B]) {
        const res = await call(w.parentA, route, { teacherId: ids.teacherId! });
        if (res.status !== status) wrong.push(`${route} → ${res.status} (want ${status})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ['parent', PARENT_ROUTES, PARENT_ROWS, PARENT_LISTS, PARENT_DENIED],
    ['teacher', TEACHER_ROUTES, TEACHER_ROWS, TEACHER_LISTS, []],
  ] as const)('%s: every portal route is in a table', (_, routes, rows, lists, denied) => {
    const covered = new Set([
      ...rows.map((r) => r[0]),
      ...lists.map((l) => l.split('?')[0]!),
      ...denied.map((d) => d[0].split('?')[0]!),
      ...Object.keys(NOT_ROW_SCOPED),
    ]);
    expect(routes.filter((r) => !covered.has(r))).toEqual([]);
  });
});
