import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { allPermissions } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Row } from '../src/legacy/convert.js';
import { FIXTURE_LEGACY_KEY, legacyFixture } from '../src/legacy/fixture.js';
import { runLegacy } from '../src/legacy/legacy-cli.js';
import { MemorySource } from '../src/legacy/source.js';
import { createTestApp, PASSWORD, resetState, signInAs, type TestContext } from './helpers.js';

/*
 * N8 data move (docs/34 §5, docs/37): a small Laravel-shaped source (memory reader: CI has no
 * MySQL) through `legacy:import` into the `_test` Postgres database. Checks counts, kept ids,
 * sequences, idempotency, the guards, `--only`, `legacy:verify`, and a login with a carried
 * Laravel bcrypt hash.
 */

let ctx: TestContext;
let dir: string;

/** Prisma's pg adapter stores timestamptz as UTC wall text: the importer requires a UTC session. */
async function utcDatabase(): Promise<void> {
  const [row] = await ctx.prisma.$queryRawUnsafe<Array<{ db: string }>>(
    'SELECT current_database() AS db',
  );
  await ctx.prisma.$executeRawUnsafe(`ALTER DATABASE "${row!.db}" SET timezone TO 'UTC'`);
}

/** One hash for the whole file (a new salt per call would make reruns differ). */
const hash = bcrypt.hashSync(PASSWORD, 4).replace(/^\$2b\$/, '$2y$');

function fixture(): Record<string, Row[]> {
  const data = legacyFixture();
  // The parent signs in with the test password through its PHP-style ($2y$) bcrypt hash.
  data.users = data.users!.map((u) => (u.id === 20 ? { ...u, password: hash } : u));
  return data;
}

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: process.env.DATABASE_URL,
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
  LEGACY_APP_KEY: FIXTURE_LEGACY_KEY,
  ...over,
});

const run = (
  command: 'legacy:import' | 'legacy:verify',
  args: string[] = [],
  data = fixture(),
  over: Record<string, string> = {},
) =>
  runLegacy({
    command,
    args: [
      `--report=${join(dir, `${command.replace(':', '-')}-${Date.now()}.md`)}`,
      '--seed=1',
      ...args,
    ],
    env: env(over),
    source: new MemorySource(data),
  });

const count = async (table: string): Promise<number> =>
  Number(
    (
      await ctx.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "${table}"`,
      )
    )[0]!.n,
  );

/** Per-table fingerprint (encrypted columns excluded: a fresh IV each run). */
async function fingerprint(): Promise<Record<string, string>> {
  const tables = await ctx.prisma.$queryRawUnsafe<Array<{ t: string }>>(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  for (const { t } of tables) {
    const [row] = await ctx.prisma.$queryRawUnsafe<Array<{ fp: string | null }>>(
      `SELECT md5(string_agg((to_jsonb(x) - 'zoom_join_url' - 'external_meeting_url' - 'contact_phone')::text, '|' ORDER BY (to_jsonb(x))::text)) AS fp FROM "${t}" x`,
    );
    out[t] = row?.fp ?? '';
  }
  return out;
}

beforeAll(async () => {
  ctx = await createTestApp();
  await utcDatabase();
  dir = mkdtempSync(join(tmpdir(), 'qarabic-n8-'));
});
afterAll(async () => {
  await resetState(ctx);
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetState(ctx);
});

describe('legacy:import (N8)', () => {
  it('imports the fixture, keeps ids, resets sequences and verifies', async () => {
    const result = await run('legacy:import');
    expect(result.out.join('\n')).toContain('PASS');
    expect(result.code).toBe(0);

    expect(await count('users')).toBe(5);
    expect(await count('class_sessions')).toBe(4);
    expect(await count('invoices')).toBe(2);
    expect(await count('pay_profiles')).toBe(2);
    expect(await count('notifications')).toBe(2);
    expect((await ctx.prisma.family.findUniqueOrThrow({ where: { id: 7 } })).status).toBe(
      'on_leave',
    );
    expect(
      (await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: 102 } })).originSessionId,
    ).toBe(100);
    expect((await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: 51 } })).duplicateOfId).toBe(
      50,
    );
    expect(
      (await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: 40 } })).total.toFixed(2),
    ).toBe('28.80');
    // The role matrix is complete again (new permissions added after the kept ids).
    expect(await count('permissions')).toBe(allPermissions().length);

    // Sequences continue after the highest kept id.
    const user = await ctx.prisma.user.create({
      data: { name: 'New', email: 'new@fixture.test', passwordHash: 'x', roleId: 2 },
    });
    expect(user.id).toBe(22);
    const lead = await ctx.prisma.lead.create({
      data: {
        parentName: 'New',
        timezone: 'UTC',
        statusChangedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(lead.id).toBe(31);

    // Stored instants are true UTC (raw SQL, not through Prisma).
    const [raw] = await ctx.prisma.$queryRawUnsafe<Array<{ t: string }>>(
      `SELECT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS t FROM class_sessions WHERE id = 101`,
    );
    expect(raw!.t).toBe('2026-10-28T15:00');

    const report = readFileSync(result.out.find((l) => l.startsWith('Report: '))!.slice(8), 'utf8');
    expect(report).toContain('Result: **PASS**');
    expect(report).toContain('extra request without a class');
    expect(report).not.toContain(FIXTURE_LEGACY_KEY);
  });

  it('is idempotent: a second run gives the same rows', async () => {
    expect((await run('legacy:import')).code).toBe(0);
    const first = await fingerprint();
    expect((await run('legacy:import')).code).toBe(0);
    expect(await fingerprint()).toEqual(first);
  });

  it('lets an imported parent sign in with the Laravel bcrypt hash, then re-hashes it', async () => {
    expect((await run('legacy:import')).code).toBe(0);
    const client = await signInAs(ctx, { email: 'parent@fixture.test' });
    const me = await client.get('/me');
    expect(me.status).toBe(200);
    const hash = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: 20 } })).passwordHash;
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('writes nothing on --dry-run', async () => {
    const result = await run('legacy:import', ['--dry-run']);
    expect(result.code).toBe(0);
    expect(await count('users')).toBe(0);
    expect(await count('class_sessions')).toBe(0);
  });

  it('refuses a target database that is not _rehearsal/_dev/_test', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/qarabic';
    const result = await run('legacy:import', [], fixture(), { DATABASE_URL: url.toString() });
    expect(result.code).toBe(2);
    expect(result.out.join()).toContain('Refusing to write to database "qarabic"');
  });

  it('--only=billing reloads billing and leaves the rest', async () => {
    expect((await run('legacy:import')).code).toBe(0);
    await ctx.prisma.invoiceSequence.update({ where: { year: 2026 }, data: { lastNumber: 99 } });
    await ctx.prisma.user.update({ where: { id: 5 }, data: { name: 'Changed after import' } });
    const result = await run('legacy:import', ['--only=billing']);
    expect(result.code).toBe(0);
    expect(result.out.join()).toContain('Modules: billing.');
    expect(
      (await ctx.prisma.invoiceSequence.findUniqueOrThrow({ where: { year: 2026 } })).lastNumber,
    ).toBe(1);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: 5 } })).name).toBe(
      'Changed after import',
    );
  });

  it('legacy:verify passes on a clean import and fails (exit 1) on a money change', async () => {
    expect((await run('legacy:import')).code).toBe(0);
    const clean = await run('legacy:verify');
    expect(clean.out.join('\n')).toContain('PASS');
    expect(clean.code).toBe(0);
    await ctx.prisma.$executeRawUnsafe(`UPDATE invoices SET paid = 1 WHERE id = 40`);
    const result = await run('legacy:verify');
    expect(result.code).toBe(1);
    expect(result.out.join()).toContain('FAIL');
  });

  it('fails verification when a source row could not be imported (class per day)', async () => {
    const data = fixture();
    data.classes!.push({
      id: 104,
      teacher_id: 99,
      student_id: 11,
      starts_at: '2026-11-03 17:00:00',
      ends_at: '2026-11-03 17:30:00',
      duration_minutes: 30,
      date: '2026-11-03',
      start_time: '19:00:00',
      duration: '00:30:00',
      status: 'active',
      stage: 'scheduled',
      created_at: '2026-10-01 10:00:00',
      updated_at: '2026-10-01 10:00:00',
    });
    const result = await run('legacy:import', [], data);
    expect(result.code).toBe(1);
    const report = readFileSync(result.out.find((l) => l.startsWith('Report: '))!.slice(8), 'utf8');
    expect(report).toContain('2026-11-03: source 1, target 0');
    expect(report).toContain('#104: teacher 99 or student 11 not imported');
  });
});
