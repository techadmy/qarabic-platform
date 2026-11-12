import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp, type TestContext } from './helpers.js';

/*
| Timestamps are stored as the instant they are, whatever the database's default time zone is
| (the pg adapter sends UTC text without an offset; the session zone is forced to UTC).
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

describe('database session time zone', () => {
  it('runs every connection in UTC', async () => {
    const prisma = ctx.app.get(PrismaService);
    const [row] = await prisma.$queryRaw<
      Array<{ tz: string }>
    >`select current_setting('TimeZone') as tz`;
    expect(row!.tz).toBe('UTC');
  });

  it('stores a Date as the same instant (no shift by the server zone)', async () => {
    const prisma = ctx.app.get(PrismaService);
    const at = new Date('2026-11-12T10:00:00Z');
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('create temp table tz_probe (t timestamptz) on commit drop');
      await tx.$executeRaw`insert into tz_probe values (${at})`;
      return tx.$queryRawUnsafe<Array<{ utc: string }>>(
        "select to_char(t at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc from tz_probe",
      );
    });
    expect(rows[0]!.utc).toBe('2026-11-12 10:00');
  });
});
