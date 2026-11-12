import { describe, expect, it } from 'vitest';
import { cleanCredential, forgotPasswordSchema, resetPasswordSchema } from './auth.js';
import { notificationListQuerySchema } from './notifications.js';
import { reportListQuerySchema } from './reports.js';
import { sessionRequestListQuerySchema } from './requests.js';
import { permissionListSchema } from './roles.js';
import {
  boardQuerySchema,
  createSessionSchema,
  createZoomHostSchema,
  updateSessionSchema,
  updateZoomHostSchema,
} from './sessions.js';
import {
  myRequestsQuerySchema,
  supportAssigneesQuerySchema,
  supportPeopleQuerySchema,
} from './support.js';
import { testSummaryQuerySchema, updateTestSchema } from './tests.js';

/**
 * The request schemas the API validates with (`@ZodBody` / `@ZodQuery`) and the web sends, that
 * had no test of their own: query-string coercion, caps, and the rules the screens rely on.
 */
describe('query strings: booleans, lists, ids and paging caps', () => {
  it('reads "1" / "true" / "0" as booleans and caps paging', () => {
    const q = sessionRequestListQuerySchema.parse({ mine: '1', countOnly: 'false', page: '2' });
    expect(q).toMatchObject({ mine: true, countOnly: false, page: 2, perPage: 25 });
    expect(sessionRequestListQuerySchema.safeParse({ perPage: '101' }).success).toBe(false);
    expect(sessionRequestListQuerySchema.safeParse({ mine: 'yes' }).success).toBe(false);
    expect(sessionRequestListQuerySchema.parse({ status: 'decided' }).status).toBe('decided');
    expect(notificationListQuerySchema.parse({ unread: 'true' })).toEqual({
      unread: true,
      limit: 20,
    });
    expect(notificationListQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('splits comma lists and refuses unknown states', () => {
    expect(reportListQuerySchema.parse({ state: 'missing,late' }).state).toEqual([
      'missing',
      'late',
    ]);
    expect(reportListQuerySchema.safeParse({ state: 'missing,lost' }).success).toBe(false);
  });

  it('refuses ids that are not positive 32-bit integers', () => {
    expect(supportPeopleQuerySchema.parse({ familyId: '7' })).toEqual({ familyId: 7 });
    for (const familyId of ['0', '-1', '1.5', '2147483648', 'x']) {
      expect(supportPeopleQuerySchema.safeParse({ familyId }).success, familyId).toBe(false);
    }
  });

  it('needs a known queue / status / month', () => {
    expect(supportAssigneesQuerySchema.safeParse({}).success).toBe(false);
    expect(supportAssigneesQuerySchema.safeParse({ queue: 'nowhere' }).success).toBe(false);
    expect(myRequestsQuerySchema.parse({ status: 'open' })).toMatchObject({
      status: 'open',
      page: 1,
    });
    expect(myRequestsQuerySchema.safeParse({ status: 'all' }).success).toBe(false);
    expect(testSummaryQuerySchema.safeParse({ month: '2026-11' }).success).toBe(true);
    expect(testSummaryQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false);
  });

  it('the board takes a real time zone and a bounded cursor', () => {
    expect(boardQuerySchema.parse({ date: '2026-11-12', tz: 'Africa/Cairo' })).toMatchObject({
      tz: 'Africa/Cairo',
    });
    expect(boardQuerySchema.safeParse({ tz: 'Mars/Olympus' }).success).toBe(false);
    expect(boardQuerySchema.safeParse({ since: 'x'.repeat(41) }).success).toBe(false);
  });
});

describe('class and test edits', () => {
  it('a one-off class needs an enrollment, a kind, an instant and a valid length', () => {
    const ok = createSessionSchema.parse({
      enrollmentId: 1,
      kind: 'extra',
      startsAt: '2026-11-12T18:00:00+02:00',
      durationMinutes: 30,
    });
    // Instants are stored in UTC; warnings default to none acknowledged.
    expect(ok).toMatchObject({ startsAt: '2026-11-12T16:00:00Z', acknowledgeWarnings: [] });
    expect(createSessionSchema.safeParse({ ...ok, kind: 'makeup' }).success).toBe(false);
    expect(createSessionSchema.safeParse({ ...ok, startsAt: '2026-11-12 18:00' }).success).toBe(
      false,
    );
    expect(createSessionSchema.safeParse({ ...ok, durationMinutes: 5 }).success).toBe(false);
  });

  it('a shift or teacher change must say which stage the screen saw', () => {
    expect(updateSessionSchema.safeParse({ teacherId: 3 }).success).toBe(false);
    expect(updateSessionSchema.parse({ teacherId: 3, expectedStage: 'scheduled' })).toMatchObject({
      teacherId: 3,
      expectedStage: 'scheduled',
    });
  });

  it('a test moves only to the allowed lengths; empty notes clear', () => {
    expect(updateTestSchema.parse({ durationMinutes: 45, notes: '  ' })).toEqual({
      durationMinutes: 45,
      notes: null,
    });
    expect(updateTestSchema.safeParse({ durationMinutes: 25 }).success).toBe(false);
    expect(updateTestSchema.safeParse({ sections: [] }).success).toBe(false);
  });

  it('a Zoom host needs a user id and an email; a patch may send any part', () => {
    expect(
      createZoomHostSchema.safeParse({ zoomUserId: ' ', email: 'host@example.test' }).success,
    ).toBe(false);
    expect(
      createZoomHostSchema.safeParse({ zoomUserId: 'u1', email: 'not-an-email' }).success,
    ).toBe(false);
    expect(updateZoomHostSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });
});

describe('accounts and roles', () => {
  it('cleans invisible characters from credentials before checking them', () => {
    expect(cleanCredential('​amina@example.test ')).toBe('amina@example.test');
    expect(forgotPasswordSchema.parse({ email: ' amina@example.test​' })).toEqual({
      email: 'amina@example.test',
    });
    expect(forgotPasswordSchema.safeParse({ email: 'amina' }).success).toBe(false);
  });

  it('a reset needs a real token and an 8–128 character password', () => {
    const token = 'x'.repeat(40);
    expect(resetPasswordSchema.safeParse({ token, password: 'short' }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token, password: 'p'.repeat(129) }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: 'short', password: 'long-enough' }).success).toBe(
      false,
    );
    expect(resetPasswordSchema.parse({ token, password: ' long-enough ' }).password).toBe(
      'long-enough',
    );
  });

  it('permission lists are de-duplicated and sorted; unknown names fail at their index', () => {
    expect(permissionListSchema.parse(['roles.view', 'families.view', 'roles.view'])).toEqual([
      'families.view',
      'roles.view',
    ]);
    const bad = permissionListSchema.safeParse(['roles.view', 'roles.fly']);
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual([1]);
  });
});
