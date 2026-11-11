import type { Role } from '@qarabic/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordsService } from '../src/auth/passwords.service.js';
import {
  Client,
  createTestApp,
  createUser,
  makeCourse,
  makeFamily,
  makeStudent,
  makeTeacher,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
| Port of Laravel tests/Feature/People/PeopleWriteTest.php (docs/28, D122–D126): add, edit and
| change status of families, students and teachers. Scenario names follow the Pest `it(...)` names.
| Enrollment cascades (pause / resume / end) and the fee exclusion arrive with N2 / N6.
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

const familyPayload = (overrides: Record<string, unknown> = {}) => ({
  parentName: 'Amina Khan',
  email: ' Amina.Khan@Example.com ',
  phone: '+44 7700-900 123',
  timezone: 'Europe/London',
  ...overrides,
});

describe('families', () => {
  it('creates a family with a parent login, E.164 phone and IANA zone', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const res = await client.post(
      '/families',
      familyPayload({ countryCode: 'gb', startDate: '2026-12-01' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      parentName: 'Amina Khan',
      email: 'amina.khan@example.com',
      phone: '+447700900123',
      timezone: 'Europe/London',
      countryCode: 'GB',
      startDate: '2026-12-01',
      status: { value: 'regular', reason: null },
      archive: null,
      students: [],
    });

    const family = await ctx.prisma.family.findUniqueOrThrow({
      where: { id: res.body.data.id },
      include: { user: { include: { role: true } } },
    });
    expect(family.user.role?.name).toBe('parent');
    expect(family.user.isActive).toBe(true);
    expect(family.user.timezone).toBe('Europe/London');
    const log = await ctx.prisma.auditLog.findFirst({
      where: { action: 'created', subjectType: 'family', subjectId: family.id },
    });
    expect(log?.after).toMatchObject({ parentName: 'Amina Khan', status: 'regular' });
  });

  it('validates the family form and maps errors to fields', async () => {
    const { client } = await signedIn(ctx, 'csr');
    await createUser(ctx, 'parent', { email: 'taken@example.com' });

    const bad = await client.post(
      '/families',
      familyPayload({ email: 'TAKEN@example.com', phone: '0100', timezone: 'Mars/Base' }),
    );
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual(['phone', 'timezone']);

    const taken = await client.post('/families', familyPayload({ email: 'TAKEN@example.com' }));
    expect(taken.status).toBe(422);
    expect(taken.body.errors).toHaveProperty('email');

    const empty = await client.post('/families', {});
    expect(empty.status).toBe(422);
    expect(Object.keys(empty.body.errors).sort()).toEqual([
      'email',
      'parentName',
      'phone',
      'timezone',
    ]);
  });

  it('edits only the fields sent, keeps its own email, and refuses status changes through PATCH', async () => {
    const { client } = await signedIn(ctx, 'manager');
    const family = await makeFamily(ctx, { zoomId: '123' });

    const res = await client.patch(`/families/${family.id}`, {
      email: family.user.email,
      comment: 'Prefers evenings',
      timezone: 'America/New_York',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      comment: 'Prefers evenings',
      timezone: 'America/New_York',
      zoomId: '123',
    });

    expect(
      (await client.patch(`/families/${family.id}`, { parentName: '' })).body.errors,
    ).toHaveProperty('parentName');
    const status = await client.patch(`/families/${family.id}`, { status: 'suspended' });
    expect(status.status).toBe(422);
    expect(status.body.errors).toHaveProperty('status');
    expect((await client.patch('/families/999999', { comment: 'x' })).status).toBe(404);

    // Clearing an optional field with "" or null.
    const cleared = await client.patch(`/families/${family.id}`, { zoomId: '', comment: null });
    expect(cleared.body.data).toMatchObject({ zoomId: null, comment: null });
  });

  it('suspends a family with a reason and records who, when and why', async () => {
    const { client, user: actor } = await signedIn(ctx, 'csr');
    const family = await makeFamily(ctx);

    const missing = await client.post(`/families/${family.id}/status`, { status: 'suspended' });
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toHaveProperty('reason');

    const res = await client.post(`/families/${family.id}/status`, {
      status: 'suspended',
      reason: 'Unpaid for two months',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toMatchObject({
      value: 'suspended',
      reason: 'Unpaid for two months',
      changedBy: { id: actor.id },
    });
    expect(res.body.data.statusHistory[0]).toMatchObject({
      from: 'regular',
      to: 'suspended',
      reason: 'Unpaid for two months',
      by: { id: actor.id },
    });

    const log = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'status_changed' },
      orderBy: { id: 'desc' },
    });
    expect(log.before).toEqual({ status: 'regular' });
    expect(log.after).toEqual({ status: 'suspended', reason: 'Unpaid for two months' });
    expect(log.actorId).toBe(actor.id);

    // Back to regular: no reason needed.
    const back = await client.post(`/families/${family.id}/status`, { status: 'regular' });
    expect(back.status).toBe(200);
    expect(back.body.data.status.value).toBe('regular');
  });

  it('refuses the same status twice and an unknown status', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const family = await makeFamily(ctx);

    expect(
      (
        await client.post(`/families/${family.id}/status`, {
          status: 'deactivated',
          reason: 'Family left',
        })
      ).status,
    ).toBe(200);
    const again = await client.post(`/families/${family.id}/status`, {
      status: 'deactivated',
      reason: 'Again',
    });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('same_status');
    const gone = await client.post(`/families/${family.id}/status`, { status: 'gone' });
    expect(gone.status).toBe(422);
    expect(gone.body.errors).toHaveProperty('status');
  });
});

describe('students', () => {
  it('adds a student to a family and edits them', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const family = await makeFamily(ctx);
    const course = await makeCourse(ctx);
    const teacher = await makeTeacher(ctx);

    const res = await client.post('/students', {
      familyId: family.id,
      name: 'Yusuf',
      gender: 'male',
      age: 9,
      language: 'english',
      regularCourseId: course.id,
      teacherId: teacher.id,
      startDate: '2026-12-01',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      familyId: family.id,
      gender: 'male',
      teacher: { id: teacher.id },
      regularCourse: { id: course.id },
      status: { value: 'active' },
    });
    const id = res.body.data.id as number;
    // No fake login account (the legacy store made one with phone 0100000000).
    expect(await ctx.prisma.user.count({ where: { role: { name: 'student' } } })).toBe(0);

    const edit = await client.patch(`/students/${id}`, {
      name: 'Yusuf Ali',
      age: 10,
      remarkTeacher: 'Shy at first',
      teacherId: null,
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({
      name: 'Yusuf Ali',
      age: 10,
      teacher: null,
      regularCourse: { id: course.id },
      remarkTeacher: 'Shy at first',
    });

    const bad = await client.post('/students', {
      familyId: 999999,
      name: '',
      gender: 'x',
      age: 200,
    });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual(['age', 'gender', 'name']);
    const noFamily = await client.post('/students', { familyId: 999999, name: 'A' });
    expect(noFamily.body.errors).toHaveProperty('familyId');
  });

  it('makes a student inactive: reason required; back to active needs none', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const student = await makeStudent(ctx, await makeFamily(ctx));

    const missing = await client.post(`/students/${student.id}/status`, { status: 'inactive' });
    expect(missing.body.errors).toHaveProperty('reason');
    const res = await client.post(`/students/${student.id}/status`, {
      status: 'inactive',
      reason: 'Stopped classes',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toMatchObject({ value: 'inactive', reason: 'Stopped classes' });

    const back = await client.post(`/students/${student.id}/status`, { status: 'active' });
    expect(back.status).toBe(200);
    expect(back.body.data.status.value).toBe('active');
  });
});

describe('teachers', () => {
  it('creates a teacher with a teacher login, courses and a random password', async () => {
    const { client } = await signedIn(ctx, 'senior_manager');
    const courses = [(await makeCourse(ctx)).id, (await makeCourse(ctx, { nameEn: 'Tajweed' })).id];

    const res = await client.post('/teachers', {
      firstName: 'Omar',
      lastName: 'Hassan',
      email: 'omar@example.com',
      phone: '+20 100 123 4567',
      timezone: 'Africa/Cairo',
      gender: 'male',
      hourlyRate: 6.5,
      courseIds: courses,
      password: 'ignored-123',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      firstName: 'Omar',
      name: 'Omar Hassan',
      phone: '+201001234567',
      timezone: 'Africa/Cairo',
      hourlyRate: '6.50',
      hourlyRateCurrency: 'EGP',
      status: { value: 'active' },
    });
    expect(res.body.data.courses.map((c: { id: number }) => c.id)).toEqual(courses);
    expect(JSON.stringify(res.body)).not.toContain('password');

    const teacher = await ctx.prisma.teacher.findUniqueOrThrow({
      where: { id: res.body.data.id },
      include: { user: { include: { role: true } } },
    });
    expect(teacher.user.role?.name).toBe('teacher');
    expect(teacher.user.name).toBe('Omar Hassan');
    expect(await new PasswordsService().verify(teacher.user.passwordHash, 'ignored-123')).toBe(
      false,
    );

    const edit = await client.patch(`/teachers/${teacher.id}`, {
      lastName: 'Hasan',
      courseIds: [courses[1]],
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data.courses.map((c: { id: number }) => c.id)).toEqual([courses[1]]);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } })).name).toBe(
      'Omar Hasan',
    );

    const dup = await client.post('/teachers', {
      email: 'omar@example.com',
      firstName: 'X',
      phone: '+201001234567',
      timezone: 'Africa/Cairo',
    });
    expect(dup.status).toBe(422);
    expect(dup.body.errors).toHaveProperty('email');
  });

  it('refuses to deactivate a teacher with active students, like the old system', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const teacher = await makeTeacher(ctx);
    const student = await makeStudent(ctx, await makeFamily(ctx), teacher);

    const show = await client.get(`/teachers/${teacher.id}`);
    expect(show.body.data.activeStudents).toBe(1);
    const refused = await client.post(`/teachers/${teacher.id}/status`, {
      status: 'inactive',
      reason: 'Resigned',
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'teacher_has_students',
      data: { activeStudents: 1 },
    });
    expect((await ctx.prisma.teacher.findUniqueOrThrow({ where: { id: teacher.id } })).status).toBe(
      'active',
    );

    await ctx.prisma.student.update({ where: { id: student.id }, data: { status: 'inactive' } });
    const missing = await client.post(`/teachers/${teacher.id}/status`, { status: 'inactive' });
    expect(missing.body.errors).toHaveProperty('reason');
    const ok = await client.post(`/teachers/${teacher.id}/status`, {
      status: 'inactive',
      reason: 'Resigned',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toMatchObject({ value: 'inactive', reason: 'Resigned' });
    // The login stays (payslips, history; D125).
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } })).isActive,
    ).toBe(true);

    const back = await client.post(`/teachers/${teacher.id}/status`, { status: 'active' });
    expect(back.body.data.status.value).toBe('active');
  });
});

describe('lookups', () => {
  it('serves the form pickers', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const course = await makeCourse(ctx, { nameEn: 'Quran Reading' });
    await makeTeacher(ctx, { status: 'inactive' });
    await makeTeacher(ctx, { archivedAt: new Date(), status: 'inactive' });
    const active = await makeTeacher(ctx);

    const res = await client.get('/people/lookups');
    expect(res.status).toBe(200);
    expect(res.body.data.countries).toEqual(
      expect.arrayContaining([{ code: 'EG', nameAr: 'مصر', nameEn: 'Egypt' }]),
    );
    expect(res.body.data.courses).toEqual([
      expect.objectContaining({ id: course.id, nameEn: 'Quran Reading', category: 'regular' }),
    ]);
    expect(res.body.data.teachers).toEqual([{ id: active.id, name: 'Teacher ' + active.lastName }]);
    expect(res.body.data).toMatchObject({ payCurrencies: ['EGP'], defaultPayCurrency: 'EGP' });
    // A non-owner is never offered the owner role.
    expect(res.body.data.staffRoles.map((r: { name: string }) => r.name)).not.toContain('admin');
  });
});

// ------------------------------------------------------------------ permission matrix

const familyWriters: Array<[Role, boolean]> = [
  ['admin', true],
  ['senior_manager', true],
  ['manager', true],
  ['csr', true],
  ['monitor', false],
  ['billing', false],
  ['accounts', false],
  ['teacher', false],
  ['parent', false],
];

describe('permission matrix', () => {
  it.each(familyWriters)(
    'lets only family managers add, edit and change families and students (%s)',
    async (role, allowed) => {
      const family = await makeFamily(ctx);
      const student = await makeStudent(ctx, family);
      const { client } = await signedIn(ctx, role);
      const expectStatus = (res: request.Response, ok: number) =>
        expect(res.status).toBe(allowed ? ok : 403);

      expectStatus(
        await client.post('/families', familyPayload({ email: `${role}@example.com` })),
        201,
      );
      expectStatus(await client.patch(`/families/${family.id}`, { comment: 'x' }), 200);
      expectStatus(
        await client.post(`/families/${family.id}/status`, {
          status: 'on_leave',
          reason: 'Travel',
        }),
        200,
      );
      expectStatus(await client.post('/students', { familyId: family.id, name: 'New' }), 201);
      expectStatus(await client.patch(`/students/${student.id}`, { name: 'Renamed' }), 200);
      expectStatus(
        await client.post(`/students/${student.id}/status`, {
          status: 'inactive',
          reason: 'Stopped',
        }),
        200,
      );
    },
  );

  const staffWriters: Array<[Role, boolean]> = [
    ['admin', true],
    ['senior_manager', true],
    ['manager', false],
    ['csr', false],
    ['monitor', false],
    ['billing', false],
    ['accounts', false],
    ['teacher', false],
    ['parent', false],
  ];

  it.each(staffWriters)(
    'lets only staff managers add, edit and change teachers (%s)',
    async (role, allowed) => {
      const teacher = await makeTeacher(ctx);
      const { client } = await signedIn(ctx, role);
      const expectStatus = (res: request.Response, ok: number) =>
        expect(res.status).toBe(allowed ? ok : 403);

      expectStatus(
        await client.post('/teachers', {
          firstName: 'T',
          email: `${role}@example.com`,
          phone: '+201001112222',
          timezone: 'Africa/Cairo',
        }),
        201,
      );
      expectStatus(await client.patch(`/teachers/${teacher.id}`, { experience: '5 years' }), 200);
      expectStatus(
        await client.post(`/teachers/${teacher.id}/status`, { status: 'inactive', reason: 'Left' }),
        200,
      );
    },
  );

  it('requires a login for every People write', async () => {
    // A browser with a CSRF token but no session.
    const anonymous = await new Client(ctx.app).init();
    expect((await anonymous.post('/families', familyPayload())).status).toBe(401);
    expect((await anonymous.post('/teachers', {})).status).toBe(401);
    expect((await anonymous.post('/students/1/status', { status: 'inactive' })).status).toBe(401);
  });
});
