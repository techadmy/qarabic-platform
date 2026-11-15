import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
| B132 (D148): a teacher is late after 5 minutes; the Zoom thresholds (teacher / student no-show
| after 10 minutes, too short below 80 % of the duration) are settings for Z1.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

describe('session thresholds', () => {
  it('has the approved defaults and validates the new keys', async () => {
    const { client: admin } = await signedIn(ctx, 'admin');
    const res = await admin.get('/settings/sessions');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      'sessions.late_teacher_min': 5,
      'sessions.teacher_no_show_min': 10,
      'sessions.student_no_show_min': 10,
      'sessions.short_class_pct': 80,
    });
    expect(
      (await admin.put('/settings/sessions', { 'sessions.short_class_pct': 101 })).status,
    ).toBe(422);
    const ok = await admin.put('/settings/sessions', { 'sessions.teacher_no_show_min': 15 });
    expect(ok.status).toBe(200);
    expect((await admin.get('/settings/sessions')).body.data['sessions.teacher_no_show_min']).toBe(
      15,
    );
  });

  it('a class not started 5 minutes after its time shows as late on the board', async () => {
    const teacher = await m2Teacher(ctx);
    const e = await m2Enrollment(ctx, await m2Student(ctx), teacher);
    const s = await m2Session(ctx, e, '2026-11-10T10:00:00Z');
    const { client: monitor } = await signedIn(ctx, 'monitor');
    const flags = async (at: string) => {
      clock(ctx).set(at);
      const board = await monitor.get('/sessions/board?date=2026-11-10&tz=UTC');
      return (board.body.data.sessions as Array<{ id: number; attention: string[] }>).find(
        (x) => x.id === s.id,
      )!.attention;
    };
    expect(await flags('2026-11-10T10:04:00Z')).not.toContain('late');
    expect(await flags('2026-11-10T10:06:00Z')).toContain('late');
  });
});
