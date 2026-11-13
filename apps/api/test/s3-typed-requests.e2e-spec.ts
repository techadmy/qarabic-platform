import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  createTestApp,
  m2Teacher,
  makeFamily,
  makeStudent,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| S3 typed support requests (docs/32 §3 #4–#7, B75): a schedule change, a teacher change, a
| pause / stop and an invoice question carry a structured payload; staff propose / approve /
| complete / reject, the family answers a proposed teacher. The current teacher never sees a
| teacher-change request.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let parent: Client;
let monitor: Client;
let studentId: number;
let otherStudentId: number;

const file = (body: Record<string, unknown>) => parent.post('/feedback/tickets', body);

beforeEach(async () => {
  await resetState(ctx);
  const family = await makeFamily(ctx);
  studentId = (await makeStudent(ctx, family)).id;
  const other = await makeFamily(ctx);
  otherStudentId = (await makeStudent(ctx, other)).id;
  parent = await signInAs(ctx, family.user);
  monitor = (await signedIn(ctx, 'monitor')).client;
});

describe('S3 creating typed requests', () => {
  it('stores a schedule change with its payload, about the child', async () => {
    const res = await file({
      category: 'classes',
      subcategory: 'schedule_change',
      description: 'Please move the classes to the weekend',
      request: {
        studentId,
        slots: [
          { weekday: 6, localTime: '17:00' },
          { weekday: 7, localTime: '17:00' },
        ],
        startsOn: '2026-12-01',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      queue: 'scheduling',
      subject: { type: 'student', id: studentId },
      request: {
        kind: 'schedule_change',
        state: 'submitted',
        payload: { studentId, startsOn: '2026-12-01' },
        proposal: null,
      },
    });
  });

  it('validates the payload by kind, and only the family’s own children', async () => {
    const bad = await file({
      category: 'billing',
      subcategory: 'subscription_change',
      description: 'We travel for the summer months',
      request: { action: 'pause', from: '2026-12-01', reason: 'travel' },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty(['request.to']);
    const notMine = await file({
      category: 'teacher',
      subcategory: 'teacher_change',
      description: 'We would like another teacher',
      request: { studentId: otherStudentId, reason: 'level' },
    });
    expect(notMine.status).toBe(422);
    expect(notMine.body.errors).toHaveProperty(['request.studentId']);
    const plain = await file({
      category: 'technical',
      description: 'The page is blank after login',
      request: { anything: 1 },
    });
    expect(plain.status).toBe(422);
    expect(plain.body.errors).toHaveProperty('request');
    const noInvoice = await file({
      category: 'billing',
      subcategory: 'invoice_question',
      description: 'I paid but it still shows unpaid',
      request: { topic: 'payment_not_reflected' },
    });
    expect(noInvoice.status).toBe(422);
    expect(noInvoice.body.errors).toHaveProperty('subjectId');
    // Without a payload it stays a plain message (older clients).
    const old = await file({
      category: 'classes',
      subcategory: 'schedule_change',
      description: 'Please move the classes to the weekend',
    });
    expect(old.status).toBe(201);
    expect(old.body.data.request).toBeNull();
  });
});

describe('S3 the steps', () => {
  it('teacher change: propose → declined → propose again → accepted → done', async () => {
    const current = await m2Teacher(ctx, 'Africa/Cairo', 'Fadi');
    await ctx.prisma.student.update({ where: { id: studentId }, data: { teacherId: current.id } });
    const proposed = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
    const other = await m2Teacher(ctx, 'Africa/Cairo', 'Basma');
    const created = await file({
      category: 'teacher',
      subcategory: 'teacher_change',
      description: 'We would like a teacher who explains slower',
      request: { studentId, reason: 'teaching_style', preferredGender: 'female' },
    });
    const id = created.body.data.id;
    const step = (body: Record<string, unknown>) =>
      monitor.post(`/support/tickets/${id}/request`, body);

    expect((await step({ action: 'approve' })).status).toBe(409);
    expect((await step({ action: 'propose' })).status).toBe(422);
    const p1 = await step({
      action: 'propose',
      proposal: { teacherId: proposed.id, fromDate: '2026-12-01' },
      note: 'Amina teaches beginners',
    });
    expect(p1.status).toBe(200);
    expect(p1.body.data.request).toMatchObject({
      state: 'proposed',
      proposal: { teacher: { id: proposed.id, name: expect.stringContaining('Amina') } },
    });
    expect(p1.body.data.status).toBe('in_progress');
    expect(p1.body.data.firstResponseAt).not.toBeNull();

    const no = await parent.post(`/support/tickets/${id}/request/answer`, {
      accept: false,
      note: 'We prefer evenings',
    });
    expect(no.status).toBe(200);
    expect(no.body.data.request.state).toBe('declined');
    await step({ action: 'propose', proposal: { teacherId: other.id, fromDate: '2026-12-02' } });
    const yes = await parent.post(`/support/tickets/${id}/request/answer`, { accept: true });
    expect(yes.body.data.request.state).toBe('accepted');
    expect(
      (await parent.post(`/support/tickets/${id}/request/answer`, { accept: true })).status,
    ).toBe(409);
    const done = await step({ action: 'complete', note: 'Basma from 2 December' });
    expect(done.body.data).toMatchObject({ status: 'fixed', request: { state: 'done' } });

    // The current teacher never sees it.
    const teacherUser = await ctx.prisma.user.findUniqueOrThrow({ where: { id: current.userId } });
    const t = await signInAs(ctx, teacherUser);
    expect((await t.get(`/feedback/tickets/${id}`)).status).toBe(404);
  });

  it('says who may do what next, and who took the last step with their note', async () => {
    const proposed = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
    const created = await file({
      category: 'teacher',
      subcategory: 'teacher_change',
      description: 'We would like another teacher please',
      request: { studentId, reason: 'level' },
    });
    const id = created.body.data.id;
    expect(created.body.data.request).toMatchObject({
      allowedActions: [],
      decidedBy: null,
      decidedAt: null,
      note: null,
    });
    const asStaff = await monitor.get(`/feedback/tickets/${id}`);
    expect(asStaff.body.data.request.allowedActions).toEqual(['propose', 'reject']);
    // A senior manager (support.manage) gets the same steps.
    const { client: senior } = await signedIn(ctx, 'senior_manager');
    expect((await senior.get(`/feedback/tickets/${id}`)).body.data.request.allowedActions).toEqual([
      'propose',
      'reject',
    ]);

    await monitor.post(`/support/tickets/${id}/request`, {
      action: 'propose',
      proposal: { teacherId: proposed.id, fromDate: '2026-12-01' },
      note: 'Amina teaches beginners',
    });
    const seen = await parent.get(`/feedback/tickets/${id}`);
    expect(seen.body.data.request).toMatchObject({
      allowedActions: ['accept', 'decline'],
      decidedBy: { id: expect.any(Number) },
      decidedAt: expect.any(String),
      note: 'Amina teaches beginners',
    });
    const declined = await parent.post(`/support/tickets/${id}/request/answer`, {
      accept: false,
      note: 'We prefer evenings',
    });
    expect(declined.body.data.request).toMatchObject({
      allowedActions: [],
      note: 'We prefer evenings',
    });
    // Staff read the family's words on the request (and on the timeline).
    const back = await monitor.get(`/feedback/tickets/${id}`);
    expect(back.body.data.request).toMatchObject({
      state: 'declined',
      note: 'We prefer evenings',
      allowedActions: ['propose', 'reject'],
    });
  });

  it('pause: approve → complete; a rejection needs a note and closes the ticket', async () => {
    const pause = await file({
      category: 'billing',
      subcategory: 'subscription_change',
      description: 'We travel for the summer months',
      request: { action: 'pause', from: '2026-12-01', to: '2027-01-15', reason: 'travel' },
    });
    expect(pause.body.data.request.payload).toMatchObject({ studentIds: [], action: 'pause' });
    const { client: billing } = await signedIn(ctx, 'billing');
    const id = pause.body.data.id;
    expect(
      (await billing.post(`/support/tickets/${id}/request`, { action: 'propose' })).status,
    ).toBe(422);
    expect(
      (await billing.post(`/support/tickets/${id}/request`, { action: 'approve' })).body.data
        .request.state,
    ).toBe('approved');
    const done = await billing.post(`/support/tickets/${id}/request`, { action: 'complete' });
    expect(done.body.data.request.state).toBe('done');

    const stop = await file({
      category: 'billing',
      subcategory: 'subscription_change',
      description: 'We want to stop the classes',
      request: { action: 'stop', studentIds: [studentId], from: '2026-12-01', reason: 'other' },
    });
    const sid = stop.body.data.id;
    expect(
      (await billing.post(`/support/tickets/${sid}/request`, { action: 'reject' })).status,
    ).toBe(422);
    const rejected = await billing.post(`/support/tickets/${sid}/request`, {
      action: 'reject',
      note: 'Please talk to us first',
    });
    expect(rejected.body.data).toMatchObject({
      status: 'wont_fix',
      resolution: 'Please talk to us first',
      request: { state: 'rejected' },
    });
    const audit = await ctx.prisma.auditLog.count({
      where: { subjectType: 'ticket', action: 'request_step' },
    });
    expect(audit).toBe(3);
  });

  it('only the queue’s staff act; only the requester answers; 401 signed out', async () => {
    const created = await file({
      category: 'teacher',
      subcategory: 'teacher_change',
      description: 'We would like another teacher',
      request: { studentId, reason: 'level' },
    });
    const id = created.body.data.id;
    // Billing staff do not handle the scheduling queue.
    const { client: billing } = await signedIn(ctx, 'billing');
    expect(
      (await billing.post(`/support/tickets/${id}/request`, { action: 'reject', note: 'x' }))
        .status,
    ).toBe(404);
    // The parent cannot take a staff step; another parent cannot answer.
    expect(
      (await parent.post(`/support/tickets/${id}/request`, { action: 'approve' })).status,
    ).toBe(403);
    const stranger = await signInAs(ctx, (await makeFamily(ctx)).user);
    expect(
      (await stranger.post(`/support/tickets/${id}/request/answer`, { accept: true })).status,
    ).toBe(404);
    const anon = await new Client(ctx.app).init();
    expect((await anon.post(`/support/tickets/${id}/request`, { action: 'approve' })).status).toBe(
      401,
    );
    expect(
      (await anon.post(`/support/tickets/${id}/request/answer`, { accept: true })).status,
    ).toBe(401);
  });
});
