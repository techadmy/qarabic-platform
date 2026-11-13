import { Controller, Get } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditRoutes } from '../src/common/route-audit.js';
import { Client, createTestApp, resetState, signedIn, type TestContext } from './helpers.js';

/** Deliberately unmarked: proves the global guard denies by default. */
@Controller('unmarked')
class UnmarkedController {
  @Get()
  get(): string {
    return 'should never be served';
  }
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp([UnmarkedController]);
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

/** The only routes open without a session. Adding one here needs a security review. */
const PUBLIC_ROUTES = [
  'GET auth/csrf',
  'GET health',
  // N4: Meta's WhatsApp webhook (404 while FEEDBACK_WHATSAPP_ENABLED is off; POST signed with
  // the app secret, GET answers only the verify token). Reviewed in the N4 PR.
  // N5 public intake (docs/33 §3.1): the trial form's course list, the trial form (honeypot,
  // optional captcha, 5/min per IP), the old class-request form (D105) and the website's WPForms
  // webhook (HMAC signature + 5-minute timestamp window + entry-id idempotency, 503 without a
  // secret). No session, no CSRF token. Reviewed in the N5 PR.
  'GET public/courses',
  'GET webhooks/whatsapp',
  'POST api/class-request',
  'POST auth/forgot-password',
  'POST auth/login',
  'POST auth/reset-password',
  'POST public/trial-requests',
  'POST public/web-leads/wpforms',
  // N6: payment provider webhooks (404 while the provider has no keys; Stripe signed over the raw
  // body with a 5 min tolerance, PayPal verified by PayPal; idempotent per event id).
  'POST webhooks/paypal',
  'POST webhooks/stripe',
  'POST webhooks/whatsapp',
];

/** Routes whose permission one of the per-milestone maps below pins down. */
const documented = new Set<string>();
function expectDocumented(byRoute: Record<string, string>, expected: Record<string, string>) {
  for (const route of Object.keys(expected)) documented.add(route);
  expect(byRoute).toMatchObject(expected);
}

describe('route permission coverage', () => {
  it('every route declares @Public, @Can or @Authenticated (except the test-only one)', () => {
    const routes = auditRoutes(ctx.app).filter((r) => r.route !== 'GET unmarked');
    expect(routes.length).toBeGreaterThanOrEqual(9);
    const unprotected = routes.filter((r) => r.access === 'none').map((r) => r.route);
    expect(unprotected).toEqual([]);
  });

  it('only the allow-listed routes are public; only own-account routes and reference data skip a permission', () => {
    const routes = auditRoutes(ctx.app);
    expect(routes.filter((r) => r.access === 'public').map((r) => r.route)).toEqual(PUBLIC_ROUTES);
    expect(routes.filter((r) => r.access === 'authenticated').map((r) => r.route)).toEqual([
      // Mobile readiness: the user's own push devices (docs/17 §5).
      'DELETE me/devices/:id',
      'GET auth/me',
      'GET me',
      'GET me/devices',
      // M8: the user's own notification channels per kind.
      'GET me/notification-preferences',
      // The bell: the user's own notifications only (N5).
      'GET me/notifications',
      // The Quran reference (Laravel: any signed-in user).
      'GET quran/surahs',
      'PATCH me',
      'POST auth/logout',
      'POST me/devices',
      'POST me/notifications/:id/read',
      'POST me/notifications/read-all',
      'PUT me/notification-preferences',
    ]);
  });

  it('answers 401 on every non-public route without a session (CSRF token present)', async () => {
    const anonymous = await new Client(ctx.app).init();
    const routes = auditRoutes(ctx.app).filter(
      (r) => r.access !== 'public' && r.route !== 'GET unmarked',
    );
    expect(routes.length).toBeGreaterThanOrEqual(83);
    for (const { route } of routes) {
      const [method, path] = route.split(' ') as [string, string];
      const url = '/' + path.replace(/:\w+/g, '1');
      const res =
        method === 'GET'
          ? await anonymous.get(url)
          : method === 'POST'
            ? await anonymous.post(url, {})
            : method === 'PATCH'
              ? await anonymous.patch(url, {})
              : method === 'PUT'
                ? await anonymous.put(url, {})
                : await anonymous.delete(url, {});
      expect(res.status, route).toBe(401);
      expect(res.body.code, route).toBe('unauthenticated');
    }
  });

  it('every N1 route needs the permission documented in docs/28 and docs/29', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    expectDocumented(byRoute, {
      'GET people/lookups': 'any:families.manage|staff.manage|users.manage',
      'GET families': 'all:families.view',
      'GET families/:id': 'all:families.view',
      'POST families': 'all:families.manage',
      'PATCH families/:id': 'all:families.manage',
      'POST families/:id/status': 'all:families.manage',
      'DELETE families/:id': 'all:families.manage',
      'POST families/:id/restore': 'all:families.manage',
      'GET students': 'any:families.view|sessions.conduct',
      'GET students/:id': 'any:families.view|sessions.conduct',
      'POST students': 'all:families.manage',
      'PATCH students/:id': 'all:families.manage',
      'POST students/:id/status': 'all:families.manage',
      'DELETE students/:id': 'all:families.manage',
      'POST students/:id/restore': 'all:families.manage',
      'GET teachers': 'all:staff.view',
      'GET teachers/:id': 'all:staff.view',
      'POST teachers': 'all:staff.manage',
      'PATCH teachers/:id': 'all:staff.manage',
      'POST teachers/:id/status': 'all:staff.manage',
      'DELETE teachers/:id': 'all:staff.manage',
      'POST teachers/:id/restore': 'all:staff.manage',
      'GET staff': 'all:users.view',
      'GET staff/:id': 'all:users.view',
      'POST staff': 'all:users.manage',
      'PATCH staff/:id': 'all:users.manage',
      'POST staff/:id/status': 'all:users.manage',
      'DELETE staff/:id': 'all:users.manage',
      'POST staff/:id/restore': 'all:users.manage',
      'GET roles': 'all:roles.view',
      'GET roles/catalog': 'all:roles.view',
      'GET roles/:id': 'all:roles.view',
      'POST roles': 'all:roles.manage',
      'PATCH roles/:id': 'all:roles.manage',
      'DELETE roles/:id': 'all:roles.manage',
    });
  });

  it('every N2 route needs the permission of the Laravel M2 routes (api_v1.php)', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    expectDocumented(byRoute, {
      'GET enrollments': 'any:schedule.view|sessions.conduct',
      'GET enrollments/:id': 'any:schedule.view|sessions.conduct',
      'POST enrollments': 'all:schedule.manage',
      'PATCH enrollments/:id': 'all:schedule.manage',
      'POST enrollments/:id/pause': 'all:schedule.manage',
      'POST enrollments/:id/resume': 'all:schedule.manage',
      'POST enrollments/:id/end': 'all:schedule.manage',
      'POST enrollments/:id/slots': 'all:schedule.manage',
      'PATCH schedule-slots/:id': 'all:schedule.manage',
      'POST schedule-slots/:id/end': 'all:schedule.manage',
      'GET schedule/availability': 'all:schedule.view',
      'POST schedule/check': 'all:schedule.view',
      'GET teachers/:teacherId/timetable': 'any:schedule.view|sessions.conduct',
      'GET teachers/:teacherId/blocks': 'any:schedule.view|sessions.conduct',
      'POST teachers/:teacherId/blocks': 'all:schedule.manage',
      'PATCH teachers/:teacherId/blocks/:blockId': 'all:schedule.manage',
      'DELETE teachers/:teacherId/blocks/:blockId': 'all:schedule.manage',
      'GET teachers/:teacherId/work-hours': 'any:schedule.view|sessions.conduct',
      'PUT teachers/:teacherId/work-hours': 'any:schedule.manage|sessions.conduct',
      'GET holidays': 'all:schedule.view',
      'POST holidays': 'all:schedule.manage',
      'PATCH holidays/:id': 'all:schedule.manage',
      'DELETE holidays/:id': 'all:schedule.manage',
      'GET sessions': 'all:sessions.view',
      'GET sessions/board': 'all:sessions.view',
      'POST sessions/generate': 'all:schedule.manage',
      'POST sessions': 'all:sessions.manage',
      'GET sessions/:id': 'all:sessions.view',
      'PATCH sessions/:id': 'all:sessions.manage',
      'POST sessions/:id/transitions': 'any:sessions.conduct|sessions.manage',
      'GET sessions/:id/zoom/start': 'all:sessions.conduct',
      'GET sessions/:id/zoom/join': 'all:sessions.view',
      'POST sessions/:id/zoom/retry': 'all:sessions.manage',
      'GET session-requests': 'all:session_requests.view',
      'GET session-requests/:id': 'all:session_requests.view',
      'POST session-requests': 'any:session_requests.request|session_requests.manage',
      'POST session-requests/:id/approve': 'all:session_requests.approve',
      'POST session-requests/:id/reject': 'all:session_requests.approve',
      'POST session-requests/:id/cancel': 'any:session_requests.request|session_requests.manage',
      'GET settings/sessions': 'all:settings.view',
      'PUT settings/sessions': 'all:settings.manage',
      'GET zoom-hosts': 'all:settings.manage',
      'POST zoom-hosts': 'all:settings.manage',
      'PATCH zoom-hosts/:id': 'all:settings.manage',
    });
  });

  it('every N3 route needs the permission of the Laravel M3 routes (api_v1.php, api_v1_tests.php)', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    expectDocumented(byRoute, {
      'PUT sessions/:id/report': 'any:sessions.conduct|sessions.manage',
      'GET sessions/:id/report': 'all:sessions.view',
      'GET lesson-reports': 'all:sessions.view',
      'GET students/:id/progress': 'any:families.view|sessions.conduct',
      'GET quran/surahs': ':',
      'GET tests': 'all:tests.view',
      'GET tests/summary': 'all:tests.view',
      'POST tests': 'any:tests.manage|tests.conduct',
      'GET tests/:id': 'all:tests.view',
      'PATCH tests/:id': 'any:tests.manage|tests.conduct',
      'PUT tests/:id/result': 'any:tests.manage|tests.conduct',
      'POST tests/:id/refuse': 'any:tests.manage|tests.conduct',
      'POST tests/:id/cancel': 'any:tests.manage|tests.conduct',
      'POST tests/:id/reopen': 'all:tests.manage',
      'GET teacher-portal/week': 'all:sessions.conduct',
      'GET teacher-portal/students': 'all:sessions.conduct',
    });
  });

  it('every N4 route needs the permission of the Laravel feedback / support routes', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    const any =
      'any:feedback.view|feedback.request|feedback.review|feedback.manage|support.view|support.handle';
    expectDocumented(byRoute, {
      'GET feedback/summary': any,
      'GET feedback/assignees': 'all:feedback.manage',
      'GET feedback/tickets': any,
      'POST feedback/tickets': 'all:feedback.request',
      'GET feedback/tickets/:id': any,
      'PATCH feedback/tickets/:id': 'any:feedback.manage|support.handle',
      'POST feedback/tickets/:id/comments': any,
      'POST feedback/tickets/:id/confirm': 'all:feedback.request',
      'POST feedback/tickets/:id/seen': 'all:feedback.request',
      'GET feedback/attachments/:id': any,
      'GET support/inbox': 'all:support.view',
      'GET support/links': 'all:support.view',
      'GET support/channels': 'all:support.view',
      'GET support/saved-replies': 'all:support.view',
      'POST support/saved-replies': 'all:support.manage',
      'PATCH support/saved-replies/:id': 'all:support.manage',
      'POST support/saved-replies/:id/archive': 'all:support.manage',
      'POST support/saved-replies/:id/restore': 'all:support.manage',
      'POST support/saved-replies/:id/render': 'all:support.view',
      'GET support/summary': 'all:support.view',
      'GET support/assignees': 'any:support.handle|support.manage',
      'GET support/people': 'all:support.view',
      'POST support/tickets/:id/take': 'any:support.handle|support.manage',
      'GET support/mine': 'any:feedback.request|session_requests.request',
      'GET settings/support': 'all:settings.view',
      'PUT settings/support': 'all:settings.manage',
      'GET parent/home': 'all:families.view',
    });
  });

  it('every N5 route needs the permission of the Laravel CRM routes (api_v1_crm.php)', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    expectDocumented(byRoute, {
      'GET leads/summary': 'all:leads.view',
      'GET leads/assignees': 'all:leads.view',
      'GET leads/funnel': 'all:leads.view',
      'POST leads/bulk/assign': 'all:leads.assign',
      'POST leads/bulk/status': 'all:leads.manage',
      'GET leads': 'all:leads.view',
      'POST leads': 'all:leads.manage',
      'GET leads/:id': 'all:leads.view',
      'PATCH leads/:id': 'all:leads.manage',
      'POST leads/:id/activities': 'all:leads.manage',
      'POST leads/:id/assign': 'all:leads.manage',
      'POST leads/:id/status': 'all:leads.manage',
      'POST leads/:id/account': 'all:leads.manage|families.manage',
      'GET leads/:id/trial-teachers': 'all:leads.manage|schedule.manage',
      'POST leads/:id/trials': 'all:leads.manage|schedule.manage',
      'POST leads/:id/trial-outcome': 'all:leads.manage',
      'POST leads/:id/convert': 'all:leads.manage|families.manage|schedule.manage',
      'POST me/referrals': 'all:leads.refer',
      'GET settings/crm': 'all:settings.view',
      'PUT settings/crm': 'all:settings.manage',
    });
  });

  it('every N6 route needs the permission of the Laravel M5 billing routes (api_v1.php)', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    expectDocumented(byRoute, {
      'GET billing/providers': 'all:invoices.view',
      'GET billing/summary': 'any:invoices.manage|reports.financial',
      'GET fee-packages': 'all:packages.view',
      'POST fee-packages': 'all:packages.manage',
      'PATCH fee-packages/:id': 'all:packages.manage',
      'GET families/:familyId/billing': 'all:invoices.view',
      'PUT families/:familyId/billing': 'all:invoices.manage',
      'GET invoices': 'all:invoices.view',
      'POST invoices': 'any:invoices.manage|invoices.request',
      'GET invoices/:id': 'all:invoices.view',
      'GET invoices/:id/print': 'all:invoices.view',
      'POST invoices/:id/issue': 'all:invoices.manage',
      'POST invoices/:id/lines': 'all:invoices.manage',
      'POST invoices/:id/void': 'all:invoices.manage',
      'POST invoices/:id/split': 'all:invoices.manage',
      'POST invoices/:id/remind': 'all:invoices.manage',
      'POST invoices/:id/payments': 'all:invoices.manage',
      'POST payments/:id/void': 'all:invoices.manage',
      'POST invoices/:id/checkout': 'all:invoices.pay',
      'POST invoices/:id/paypal/capture': 'all:invoices.pay',
      'POST invoice-runs/preview': 'all:invoices.manage',
      'POST invoice-runs': 'all:invoices.manage',
      'GET settings/billing': 'all:settings.view',
      'PUT settings/billing': 'all:settings.manage',
    });
  });

  it('every N7 route needs the permission of the Laravel M6 routes (api_v1_payroll.php)', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    const fineStaff = 'any:fines.request|fines.manage|fines.approve|payroll.manage';
    const payrollStaff = 'any:payroll.manage|payroll.review|payroll.approve';
    expectDocumented(byRoute, {
      'GET attendance/today': 'all:attendance.request',
      'POST attendance/check-in': 'all:attendance.request',
      'POST attendance/check-out': 'all:attendance.request',
      'GET attendance': 'any:attendance.request|attendance.view',
      'PUT attendance/:userId/:date': 'all:attendance.manage',
      'GET leave-requests': 'any:attendance.request|attendance.manage',
      'POST leave-requests': 'any:attendance.request|attendance.manage',
      'GET leave-requests/:id': 'any:attendance.request|attendance.manage',
      'POST leave-requests/:id/approve': 'all:attendance.manage',
      'POST leave-requests/:id/reject': 'all:attendance.manage',
      'POST leave-requests/:id/cancel': 'any:attendance.request|attendance.manage',
      'GET payroll/adjustments': 'any:fines.view|payroll.view',
      'POST payroll/adjustments': fineStaff,
      'GET payroll/adjustments/:id': 'any:fines.view|payroll.view',
      'POST payroll/adjustments/:id/approve': 'any:fines.approve|payroll.manage',
      'POST payroll/adjustments/:id/reject': 'any:fines.approve|payroll.manage',
      'POST payroll/adjustments/:id/cancel': fineStaff,
      'GET payroll/people':
        'any:fines.request|fines.manage|fines.approve|payroll.manage|attendance.manage',
      'GET salary-profiles': 'all:payroll.manage',
      'GET salary-profiles/:userId': 'all:payroll.manage',
      'PUT salary-profiles/:userId': 'all:payroll.manage',
      'GET payroll/runs': payrollStaff,
      'GET payroll/runs/preview': payrollStaff,
      'POST payroll/runs': 'all:payroll.manage',
      'GET payroll/runs/:id': payrollStaff,
      'POST payroll/runs/:id/recompute': 'all:payroll.manage',
      'POST payroll/runs/:id/review': 'all:payroll.review',
      'POST payroll/runs/:id/approve': 'all:payroll.approve',
      'POST payroll/runs/:id/reopen': 'all:payroll.approve',
      'GET payslips/:id': 'any:payroll.view|payroll.manage|payroll.review|payroll.approve',
      'POST payslips/:id/payments': 'all:payroll.manage',
      'GET me/payslips': 'all:payroll.view',
      'GET me/wallet': 'all:wallet.view',
      'GET wallets': 'all:wallet.manage',
      'GET pay-rule-sets': 'all:settings.view',
      'POST pay-rule-sets': 'all:settings.manage',
    });
  });

  it('every M7 accounting route needs accounting.view to read and accounting.manage to write', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    expectDocumented(byRoute, {
      'GET accounting/accounts': 'all:accounting.view',
      'GET accounting/accounts/:id': 'all:accounting.view',
      'GET accounting/accounts/:id/statement': 'all:accounting.view',
      'GET accounting/journal': 'all:accounting.view',
      'GET accounting/journal/:id': 'all:accounting.view',
      'GET accounting/outbox': 'all:accounting.view',
      'GET accounting/periods': 'all:accounting.view',
      'GET accounting/reports/balance-sheet': 'all:accounting.view',
      'GET accounting/reports/cash': 'all:accounting.view',
      'GET accounting/reports/profit-and-loss': 'all:accounting.view',
      'GET accounting/reports/trial-balance': 'all:accounting.view',
      'GET accounting/vouchers': 'all:accounting.view',
      'GET accounting/vouchers/:id': 'all:accounting.view',
      'PATCH accounting/accounts/:id': 'all:accounting.manage',
      'POST accounting/accounts': 'all:accounting.manage',
      'POST accounting/journal': 'all:accounting.manage',
      'POST accounting/journal/:id/reverse': 'all:accounting.manage',
      'POST accounting/outbox/process': 'all:accounting.manage',
      'POST accounting/periods/:period/close': 'all:accounting.manage',
      'POST accounting/periods/:period/reopen': 'all:accounting.manage',
      'POST accounting/vouchers': 'all:accounting.manage',
      'POST accounting/vouchers/:id/void': 'all:accounting.manage',
    });
  });

  it('every M8 operations route (tasks, templates, announcements, dashboard) has its permission', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    // Task actions need tasks.view; who may act on which task (issuer, assignee, tasks.oversee) is
    // checked by the service (other people's tasks answer 404).
    expectDocumented(byRoute, {
      'GET announcements': 'all:announcements.view',
      'GET announcements/:id': 'all:announcements.view',
      'GET dashboard/summary': 'all:reports.view',
      'GET task-templates': 'all:tasks.manage',
      'GET tasks': 'all:tasks.view',
      'GET tasks/:id': 'all:tasks.view',
      'GET tasks/assignees': 'all:tasks.manage',
      'PATCH announcements/:id': 'all:announcements.manage',
      'PATCH tasks/:id': 'all:tasks.manage',
      'POST announcements': 'all:announcements.manage',
      'POST announcements/:id/archive': 'all:announcements.manage',
      'POST announcements/:id/publish': 'all:announcements.manage',
      'POST announcements/:id/read': 'all:announcements.view',
      'POST announcements/:id/unarchive': 'all:announcements.manage',
      'POST task-templates': 'all:tasks.oversee',
      'POST tasks': 'all:tasks.manage',
      'POST tasks/:id/close': 'all:tasks.view',
      'POST tasks/:id/comments': 'all:tasks.view',
      'POST tasks/:id/complete': 'all:tasks.view',
      'POST tasks/:id/reassign': 'all:tasks.view',
      'POST tasks/:id/reopen': 'all:tasks.view',
      'POST tasks/:id/submit': 'all:tasks.view',
      'PUT task-templates/:id': 'all:tasks.oversee',
    });
  });

  it('every permission route is pinned in one of the maps above (add new routes there)', (ctx2) => {
    // The maps fill `documented` as they run; a filtered run (-t) has nothing to compare.
    if (documented.size === 0) ctx2.skip();
    const missing = auditRoutes(ctx.app)
      .filter((r) => r.access !== 'public' && r.access !== 'authenticated')
      .map((r) => r.route)
      .filter((route) => route !== 'GET unmarked' && !documented.has(route));
    expect(missing).toEqual([]);
  });

  it('answers 403 to a signed-in user with no role on every permission route', async () => {
    const { client } = await signedIn(ctx, null);
    for (const { route } of auditRoutes(ctx.app).filter((r) => r.access === 'permission')) {
      const [method, path] = route.split(' ') as [string, string];
      const url = '/' + path.replace(/:\w+/g, '1');
      const res =
        method === 'GET'
          ? await client.get(url)
          : method === 'POST'
            ? await client.post(url, {})
            : method === 'PATCH'
              ? await client.patch(url, {})
              : method === 'PUT'
                ? await client.put(url, {})
                : await client.delete(url, {});
      expect(res.status, route).toBe(403);
    }
  });

  it('the audit flags an unmarked route', () => {
    expect(auditRoutes(ctx.app).find((r) => r.route === 'GET unmarked')?.access).toBe('none');
  });

  it('an unmarked route is denied: 401 without a session, 403 even for the owner', async () => {
    expect((await request(ctx.app.getHttpServer()).get('/api/v1/unmarked')).status).toBe(401);
    const { client } = await signedIn(ctx, 'admin');
    expect((await client.get('/unmarked')).status).toBe(403);
  });
});

describe('platform', () => {
  it('GET /health is public and pings the database', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('unknown routes answer in the standard error format', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/nope');
    // Deny by default runs first: no session means 401, even for a route that does not exist.
    expect([401, 404]).toContain(res.status);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message']);
  });

  it('malformed JSON is a 400 in the standard format', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.agent
      .post('/api/v1/auth/forgot-password')
      .set('Content-Type', 'application/json')
      .set('X-XSRF-TOKEN', 'x')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message']);
  });

  it('sends security headers and CORS for the web origin only', async () => {
    const ok = await request(ctx.app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3000');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['x-powered-by']).toBeUndefined();

    const evil = await request(ctx.app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the OpenAPI document outside production', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/docs-json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/login',
        '/api/v1/roles',
        '/api/v1/families',
        '/api/v1/staff/{id}/status',
        '/api/v1/enrollments',
        '/api/v1/sessions/board',
        '/api/v1/session-requests/{id}/approve',
        '/api/v1/sessions/{id}/report',
        '/api/v1/students/{id}/progress',
        '/api/v1/tests/{id}/result',
        '/api/v1/teacher-portal/week',
        '/api/v1/feedback/tickets',
        '/api/v1/support/inbox',
        '/api/v1/parent/home',
        '/api/v1/leads/{id}/convert',
        '/api/v1/public/web-leads/wpforms',
        '/api/v1/me/notifications',
        '/api/v1/invoices',
        '/api/v1/invoices/{id}/checkout',
        '/api/v1/invoice-runs/preview',
        '/api/v1/payroll/runs/{id}/approve',
        '/api/v1/attendance/check-in',
        '/api/v1/salary-profiles/{userId}',
      ]),
    );
  });
});
