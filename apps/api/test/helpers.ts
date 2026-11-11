import 'reflect-metadata';
import { type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PasswordsService } from '../src/auth/passwords.service.js';
import { RateLimiterService } from '../src/auth/rate-limiter.service.js';
import type { AuthUser } from '../src/auth/auth.types.js';
import { Clock } from '../src/common/clock.js';
import { Crypto } from '../src/common/crypto.js';
import type { SessionKind, SessionStage, ZoomStatus } from '../src/generated/prisma/enums.js';
import { FakeZoomClient, NoneZoomClient, ZoomDriver } from '../src/sessions/zoom.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { syncRolesAndPermissions } from '../src/rbac/sync-roles.js';

export const PASSWORD = 'Correct-horse-42';

export interface TestContext {
  app: NestExpressApplication;
  prisma: PrismaService;
  mailer: MemoryMailer;
  limiter: RateLimiterService;
}

export async function createTestApp(extraControllers: Type[] = []): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    mailer: app.get(MemoryMailer),
    limiter: app.get(RateLimiterService),
  };
}

/** Reference data the migrations seed: never truncated. */
const REFERENCE_TABLES = ['_prisma_migrations', 'quran_surahs'];

/** Empty tables (reference data kept), fresh role matrix, no throttle counters, no mails. */
export async function resetState(ctx: TestContext): Promise<void> {
  const tables = (
    await ctx.prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  ).filter((t) => !REFERENCE_TABLES.includes(t.tablename));
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list) await ctx.prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await syncRolesAndPermissions(ctx.prisma);
  ctx.limiter.reset();
  ctx.mailer.clear();
  ctx.app.get(Clock).set(null);
  ctx.app.get(ZoomDriver).use(new NoneZoomClient());
}

let seq = 0;
let cachedHash: string | undefined;

export async function createUser(
  ctx: TestContext,
  role: string | null,
  overrides: {
    email?: string;
    isActive?: boolean;
    passwordHash?: string;
    password?: string;
    name?: string;
    phone?: string | null;
  } = {},
) {
  seq += 1;
  const passwordHash =
    overrides.passwordHash ??
    (overrides.password
      ? await new PasswordsService().hash(overrides.password)
      : (cachedHash ??= await new PasswordsService().hash(PASSWORD)));
  const roleRow = role ? await ctx.prisma.role.findUniqueOrThrow({ where: { name: role } }) : null;
  return ctx.prisma.user.create({
    data: {
      name: overrides.name ?? `User ${seq}`,
      email: overrides.email ?? `user${seq}@example.test`,
      phone: overrides.phone ?? null,
      passwordHash,
      isActive: overrides.isActive ?? true,
      roleId: roleRow?.id ?? null,
    },
  });
}

/** A browser-like client: keeps cookies and echoes XSRF-TOKEN in X-XSRF-TOKEN like the web app. */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  private csrf?: string;

  constructor(app: NestExpressApplication) {
    this.agent = request.agent(app.getHttpServer());
  }

  async init(): Promise<this> {
    const res = await this.agent.get('/api/v1/auth/csrf').expect(200);
    this.track(res);
    return this;
  }

  get(path: string): Promise<request.Response> {
    return this.wrap(this.agent.get(`/api/v1${path}`));
  }

  post(path: string, body?: object, opts: { csrf?: boolean } = {}): Promise<request.Response> {
    return this.wrap(this.withCsrf(this.agent.post(`/api/v1${path}`), opts.csrf).send(body ?? {}));
  }

  put(path: string, body?: object, opts: { csrf?: boolean } = {}): Promise<request.Response> {
    return this.wrap(this.withCsrf(this.agent.put(`/api/v1${path}`), opts.csrf).send(body ?? {}));
  }

  patch(path: string, body?: object, opts: { csrf?: boolean } = {}): Promise<request.Response> {
    return this.wrap(this.withCsrf(this.agent.patch(`/api/v1${path}`), opts.csrf).send(body ?? {}));
  }

  delete(path: string, body?: object, opts: { csrf?: boolean } = {}): Promise<request.Response> {
    return this.wrap(
      this.withCsrf(this.agent.delete(`/api/v1${path}`), opts.csrf).send(body ?? {}),
    );
  }

  login(email: string, password = PASSWORD, remember = true): Promise<request.Response> {
    return this.post('/auth/login', { email, password, remember });
  }

  private withCsrf(req: request.Test, enabled = true): request.Test {
    return enabled && this.csrf ? req.set('X-XSRF-TOKEN', this.csrf) : req;
  }

  private async wrap(req: request.Test): Promise<request.Response> {
    const res = await req;
    this.track(res);
    return res;
  }

  private track(res: request.Response): void {
    const cookies = setCookies(res);
    const xsrf = cookies.find((c) => c.startsWith('XSRF-TOKEN='));
    if (xsrf) this.csrf = decodeURIComponent(xsrf.split(';')[0]!.slice('XSRF-TOKEN='.length));
  }
}

export function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
}

/** `role` is a role name: a system role or a custom one (`custom_12`). */
export async function signedIn(ctx: TestContext, role: string | null) {
  const user = await createUser(ctx, role);
  const client = await new Client(ctx.app).init();
  const res = await client.login(user.email);
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { user, client };
}

/** Signs an existing user in (e.g. a teacher or parent made by a factory below). */
export async function signInAs(ctx: TestContext, user: { email: string }) {
  const client = await new Client(ctx.app).init();
  const res = await client.login(user.email);
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

// ------------------------------------------------------------------ People factories (Pest helpers)

export async function makeCourse(
  ctx: TestContext,
  overrides: { nameEn?: string; nameAr?: string; category?: 'regular' | 'additional' } = {},
) {
  seq += 1;
  return ctx.prisma.course.create({
    data: {
      nameEn: overrides.nameEn ?? `Quran Reading ${seq}`,
      nameAr: overrides.nameAr ?? `القراءة ${seq}`,
      category: overrides.category ?? 'regular',
    },
  });
}

export async function makeFamily(
  ctx: TestContext,
  overrides: {
    status?: 'regular' | 'trial' | 'on_leave' | 'suspended' | 'deactivated';
    timezone?: string;
    archivedAt?: Date | null;
    zoomId?: string | null;
    user?: { name?: string; phone?: string | null; email?: string };
  } = {},
) {
  const user = await createUser(ctx, 'parent', overrides.user ?? {});
  const family = await ctx.prisma.family.create({
    data: {
      userId: user.id,
      timezone: overrides.timezone ?? 'Europe/London',
      status: overrides.status ?? 'regular',
      archivedAt: overrides.archivedAt ?? null,
      zoomId: overrides.zoomId ?? null,
    },
  });
  return { ...family, user };
}

export async function makeTeacher(
  ctx: TestContext,
  overrides: {
    status?: 'active' | 'inactive';
    archivedAt?: Date | null;
    firstName?: string;
    lastName?: string;
    timezone?: string;
    user?: { name?: string; phone?: string | null; email?: string };
  } = {},
) {
  seq += 1;
  const user = await createUser(ctx, 'teacher', overrides.user ?? {});
  const teacher = await ctx.prisma.teacher.create({
    data: {
      userId: user.id,
      firstName: overrides.firstName ?? 'Teacher',
      lastName: overrides.lastName ?? `Number${seq}`,
      timezone: overrides.timezone ?? 'Africa/Cairo',
      status: overrides.status ?? 'active',
      archivedAt: overrides.archivedAt ?? null,
    },
  });
  return { ...teacher, user };
}

export async function makeStudent(
  ctx: TestContext,
  family: { id: number },
  teacher: { id: number } | null = null,
  overrides: {
    name?: string;
    status?: 'active' | 'inactive';
    archivedAt?: Date | null;
    email?: string | null;
    zoomId?: string | null;
  } = {},
) {
  seq += 1;
  return ctx.prisma.student.create({
    data: {
      familyId: family.id,
      teacherId: teacher?.id ?? null,
      name: overrides.name ?? `Child${seq}`,
      status: overrides.status ?? 'active',
      archivedAt: overrides.archivedAt ?? null,
      email: overrides.email ?? null,
      zoomId: overrides.zoomId ?? null,
    },
  });
}

/** A custom staff role straight in the database (no API, no escalation checks). */
export async function makeCustomRole(ctx: TestContext, permissions: string[], labelAr = 'مشرف') {
  seq += 1;
  const role = await ctx.prisma.role.create({
    data: { name: `custom_tmp_${seq}`, labelAr: `${labelAr}`, kind: 'staff', isSystem: false },
  });
  const named = await ctx.prisma.role.update({
    where: { id: role.id },
    data: { name: `custom_${role.id}` },
  });
  const ids = await ctx.prisma.permission.findMany({ where: { name: { in: permissions } } });
  await ctx.prisma.rolePermission.createMany({
    data: ids.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  return named;
}

export const roleId = async (ctx: TestContext, name: string) =>
  (await ctx.prisma.role.findUniqueOrThrow({ where: { name } })).id;

// ------------------------------------------------------------------ N2 factories (Laravel m2* helpers)

/** The app clock (Laravel `Carbon::setTestNow`). Reset it in `beforeEach`. */
export const clock = (ctx: TestContext) => ctx.app.get(Clock);

/** A signed-in user as the services see it (role + permissions), for direct service calls. */
export async function authUser(ctx: TestContext, user: { id: number }): Promise<AuthUser> {
  const row = await ctx.prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    include: {
      role: { include: { permissions: { include: { permission: true } } } },
      teacher: { select: { id: true } },
    },
  });
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    locale: row.locale,
    timezone: row.timezone,
    phone: row.phone,
    role: row.role
      ? {
          id: row.role.id,
          name: row.role.name,
          kind: row.role.kind,
          labelAr: row.role.labelAr,
          labelEn: row.role.labelEn,
        }
      : null,
    permissions: new Set(row.role?.permissions.map((p) => p.permission.name) ?? []),
    teacherId: row.teacher?.id ?? null,
  };
}

/** A teacher in `zone` (Laravel `m2Teacher`). */
export const m2Teacher = (ctx: TestContext, zone = 'Africa/Cairo', firstName?: string) =>
  makeTeacher(ctx, { timezone: zone, ...(firstName ? { firstName } : {}) });

/** A student of a (new) family in `zone`, with a regular course (Laravel `m2Student`). */
export async function m2Student(
  ctx: TestContext,
  zone = 'Europe/London',
  family?: { id: number },
  name?: string,
) {
  const fam = family ?? (await makeFamily(ctx, { timezone: zone }));
  const course = await makeCourse(ctx);
  const student = await makeStudent(ctx, fam, null, name ? { name } : {});
  return ctx.prisma.student.update({
    where: { id: student.id },
    data: { regularCourseId: course.id },
    include: { family: { include: { user: true } } },
  });
}

export async function m2Enrollment(
  ctx: TestContext,
  student: { id: number; regularCourseId: number | null; family: { timezone: string } },
  teacher: { id: number },
  overrides: {
    status?: 'active' | 'paused' | 'ended';
    pausedReason?: string;
    startsOn?: string;
    endsOn?: string | null;
    timezone?: string;
    courseId?: number;
    meetingMode?: 'zoom' | 'external';
    externalMeetingUrl?: string | null;
    kind?: 'regular' | 'trial';
  } = {},
) {
  return ctx.prisma.enrollment.create({
    data: {
      studentId: student.id,
      courseId: overrides.courseId ?? student.regularCourseId ?? (await makeCourse(ctx)).id,
      teacherId: teacher.id,
      kind: overrides.kind ?? 'regular',
      status: overrides.status ?? 'active',
      pausedReason: overrides.pausedReason ?? null,
      startsOn: new Date(`${overrides.startsOn ?? '2026-01-01'}T00:00:00Z`),
      endsOn: overrides.endsOn ? new Date(`${overrides.endsOn}T00:00:00Z`) : null,
      sessionMinutes: 30,
      timezone: overrides.timezone ?? student.family.timezone,
      meetingMode: overrides.meetingMode ?? 'zoom',
      externalMeetingUrl: ctx.app.get(Crypto).encryptOrNull(overrides.externalMeetingUrl),
    },
  });
}

export function m2Slot(
  ctx: TestContext,
  enrollment: { id: number; teacherId: number; timezone: string },
  weekday: number,
  time: string,
  overrides: { validFrom?: string; validTo?: string | null; durationMinutes?: number } = {},
) {
  return ctx.prisma.scheduleSlot.create({
    data: {
      enrollmentId: enrollment.id,
      teacherId: enrollment.teacherId,
      weekday,
      localStartTime: time,
      durationMinutes: overrides.durationMinutes ?? 30,
      timezone: enrollment.timezone,
      validFrom: new Date(`${overrides.validFrom ?? '2026-01-01'}T00:00:00Z`),
      validTo: overrides.validTo ? new Date(`${overrides.validTo}T00:00:00Z`) : null,
    },
  });
}

export function m2Session(
  ctx: TestContext,
  enrollment: { id: number; studentId: number; teacherId: number; courseId: number },
  startsAtUtc: string,
  overrides: Partial<{
    stage: SessionStage;
    stageReason: string | null;
    kind: SessionKind;
    activatedAt: string | null;
    endedAt: string | null;
    durationMinutes: number;
    scheduleSlotId: number;
    occurrenceDate: string;
    source: 'generated' | 'manual' | 'request';
    zoomStatus: ZoomStatus;
    zoomJoinUrl: string | null;
    needsReview: boolean;
    isDetached: boolean;
    courseId: number | null;
  }> = {},
) {
  const starts = new Date(startsAtUtc);
  const minutes = overrides.durationMinutes ?? 30;
  return ctx.prisma.classSession.create({
    data: {
      enrollmentId: enrollment.id,
      studentId: enrollment.studentId,
      teacherId: enrollment.teacherId,
      courseId: overrides.courseId === undefined ? enrollment.courseId : overrides.courseId,
      startsAt: starts,
      endsAt: new Date(starts.getTime() + minutes * 60_000),
      durationMinutes: minutes,
      kind: overrides.kind ?? 'regular',
      stage: overrides.stage ?? 'scheduled',
      stageReason: overrides.stageReason ?? null,
      source: overrides.source ?? 'manual',
      activatedAt: overrides.activatedAt ? new Date(overrides.activatedAt) : null,
      endedAt: overrides.endedAt ? new Date(overrides.endedAt) : null,
      scheduleSlotId: overrides.scheduleSlotId ?? null,
      occurrenceDate: overrides.occurrenceDate
        ? new Date(`${overrides.occurrenceDate}T00:00:00Z`)
        : null,
      zoomStatus: overrides.zoomStatus ?? 'none',
      zoomJoinUrl: ctx.app.get(Crypto).encryptOrNull(overrides.zoomJoinUrl),
      needsReview: overrides.needsReview ?? false,
      isDetached: overrides.isDetached ?? false,
      updatedAt: clock(ctx).now(),
      createdAt: clock(ctx).now(),
    },
  });
}

/** Swaps the Zoom driver (Laravel `config(['services.zoom.driver' => …])`). */
export function zoomDriver(ctx: TestContext, driver: 'none' | 'fake'): FakeZoomClient | null {
  const client = driver === 'fake' ? new FakeZoomClient() : new NoneZoomClient();
  ctx.app.get(ZoomDriver).use(client);
  return client instanceof FakeZoomClient ? client : null;
}
