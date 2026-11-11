import 'reflect-metadata';
import { type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Role } from '@qarabic/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PasswordsService } from '../src/auth/passwords.service.js';
import { RateLimiterService } from '../src/auth/rate-limiter.service.js';
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

/** Empty tables, fresh role matrix, no throttle counters, no mails. */
export async function resetState(ctx: TestContext): Promise<void> {
  const tables = await ctx.prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list) await ctx.prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await syncRolesAndPermissions(ctx.prisma);
  ctx.limiter.reset();
  ctx.mailer.clear();
}

let seq = 0;
let cachedHash: string | undefined;

export async function createUser(
  ctx: TestContext,
  role: Role | null,
  overrides: { email?: string; isActive?: boolean; passwordHash?: string; password?: string } = {},
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
      name: `User ${seq}`,
      email: overrides.email ?? `user${seq}@example.test`,
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

export async function signedIn(ctx: TestContext, role: Role | null) {
  const user = await createUser(ctx, role);
  const client = await new Client(ctx.app).init();
  const res = await client.login(user.email);
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { user, client };
}
