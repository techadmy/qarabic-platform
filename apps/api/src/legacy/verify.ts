import type { PrismaClient } from '../generated/prisma/client.js';
import { int, type Row, str, utc } from './convert.js';
import { classTiming } from './mappers/sessions.js';
import type { MapContext, ModelName, TargetBatch } from './plan.js';

export interface CountCheck {
  source: string;
  table: string;
  sourceRows: number;
  planned: number;
  actual: number;
  skipped: number;
  ok: boolean;
}

export interface TotalCheck {
  scope: string;
  key: string;
  source: string;
  target: string;
  ok: boolean;
}

export interface SpotCheck {
  table: string;
  id: number;
  ok: boolean;
  diffs: string[];
}

export interface Verification {
  ok: boolean;
  counts: CountCheck[];
  totals: TotalCheck[];
  /** Totals that were compared (all, for the report summary). */
  totalsCompared: number;
  days: { compared: number; mismatches: TotalCheck[] };
  spots: SpotCheck[];
  surahsOk: boolean;
}

/**
 * The role matrix sync after the load adds the permissions and system roles Laravel lacked and
 * re-applies untouched presets: these tables may hold more rows than were imported.
 */
const MATRIX_SYNCED = new Set(['permissions', 'roles', 'role_permissions']);

/** Fields stored encrypted (fresh IV each time): compared after decryption. */
const ENCRYPTED = new Set(['zoomJoinUrl', 'externalMeetingUrl', 'contactPhone']);

/** Tables the spot checks draw from (serial ids). */
const SPOT_TABLES: Array<[string, ModelName]> = [
  ['users', 'user'],
  ['families', 'family'],
  ['students', 'student'],
  ['teachers', 'teacher'],
  ['enrollments', 'enrollment'],
  ['class_sessions', 'classSession'],
  ['lesson_reports', 'lessonReport'],
  ['tickets', 'ticket'],
  ['leads', 'lead'],
  ['invoices', 'invoice'],
  ['payments', 'payment'],
  ['payslips', 'payslip'],
  ['staff_attendance', 'staffAttendance'],
];

type Finder = {
  findUnique(args: { where: { id: number } }): Promise<Record<string, unknown> | null>;
};

/** Deterministic PRNG (mulberry32) so a seed reproduces the same spot checks. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function isDecimal(v: unknown): v is { toFixed(n: number): string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { toFixed?: unknown }).toFixed === 'function' &&
    !(v instanceof Date)
  );
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

/** One comparable text for a planned or stored value. */
export function norm(v: unknown): string {
  if (v === undefined || v === null) return 'null';
  if (v instanceof Date) return v.toISOString();
  if (isDecimal(v)) return Number(v.toFixed(4)).toString();
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v).toString();
  if (typeof v === 'object') return JSON.stringify(sortKeys(v));
  return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint'
    ? String(v)
    : JSON.stringify(v);
}

const minorOf = (v: unknown): bigint => {
  const s = isDecimal(v) ? v.toFixed(2) : String((v as string | number | null) ?? '0');
  const [w, f = ''] = s.split('.');
  const neg = w!.startsWith('-');
  const m = BigInt(w!.replace('-', '') || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -m : m;
};

function sumBy(
  rows: Row[],
  key: string,
  col: string,
  filter: (r: Row) => boolean = () => true,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const r of rows.filter(filter)) {
    const k = str(r, key) ?? 'null';
    out.set(k, (out.get(k) ?? 0n) + BigInt(int(r, col) ?? 0));
  }
  return out;
}

function compareMaps(
  scope: string,
  src: Map<string, bigint>,
  dst: Map<string, bigint>,
  out: TotalCheck[],
): number {
  const keys = new Set([...src.keys(), ...dst.keys()]);
  for (const k of keys) {
    const a = src.get(k) ?? 0n;
    const b = dst.get(k) ?? 0n;
    out.push({ scope, key: k, source: a.toString(), target: b.toString(), ok: a === b });
  }
  return keys.size;
}

/**
 * Compares the source with what is in Postgres: row counts per table (planned = source minus the
 * reported skips), money per family and teacher (in minor units, exact), classes per UTC day, the
 * Quran reference, and `spotChecks` random rows field by field.
 */
export async function verify(
  prisma: PrismaClient,
  ctx: MapContext,
  batches: TargetBatch[],
  opts: { spotChecks: number; seed: number },
): Promise<Verification> {
  const counts: CountCheck[] = [];
  for (const b of batches) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "${b.table}"`,
    );
    const actual = Number(rows[0]?.n ?? 0);
    const skipped = b.source.split('+').reduce((n, s) => n + ctx.report.skippedIn(s), 0);
    counts.push({
      source: b.source,
      table: b.table,
      sourceRows: b.sourceCount,
      planned: b.rows.length,
      actual,
      skipped,
      ok: MATRIX_SYNCED.has(b.table) ? actual >= b.rows.length : actual === b.rows.length,
    });
  }
  const tableNames = new Set(batches.map((b) => b.table));

  // ---- money (minor units)
  const totals: TotalCheck[] = [];
  let totalsCompared = 0;
  const q = async (sql: string): Promise<Map<string, bigint>> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ k: string | null; v: unknown }>>(sql);
    return new Map(rows.map((r) => [r.k ?? 'null', minorOf(r.v)]));
  };
  if (tableNames.has('invoices')) {
    const inv = ctx.rows('invoices');
    totalsCompared += compareMaps(
      'invoice total per family',
      sumBy(inv, 'family_id', 'total_minor'),
      await q('SELECT family_id::text AS k, SUM(total) AS v FROM invoices GROUP BY 1'),
      totals,
    );
    totalsCompared += compareMaps(
      'invoice paid per family',
      sumBy(inv, 'family_id', 'paid_minor'),
      await q('SELECT family_id::text AS k, SUM(paid) AS v FROM invoices GROUP BY 1'),
      totals,
    );
    totalsCompared += compareMaps(
      'invoice lines per family',
      (() => {
        const fam = new Map(inv.map((r) => [int(r, 'id'), str(r, 'family_id')]));
        const out = new Map<string, bigint>();
        for (const l of ctx.rows('invoice_lines')) {
          const k = fam.get(int(l, 'invoice_id')) ?? 'null';
          out.set(k, (out.get(k) ?? 0n) + BigInt(int(l, 'amount_minor') ?? 0));
        }
        return out;
      })(),
      await q(
        'SELECT i.family_id::text AS k, SUM(l.amount) AS v FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id GROUP BY 1',
      ),
      totals,
    );
  }
  if (tableNames.has('payments')) {
    totalsCompared += compareMaps(
      'succeeded payments per family',
      sumBy(
        ctx.rows('payments'),
        'family_id',
        'amount_minor',
        (r) => str(r, 'status') === 'succeeded',
      ),
      await q(
        `SELECT family_id::text AS k, SUM(amount) AS v FROM payments WHERE status = 'succeeded' GROUP BY 1`,
      ),
      totals,
    );
  }
  if (tableNames.has('payslips')) {
    const ps = ctx.rows('payslips');
    totalsCompared += compareMaps(
      'payslip earnings per person',
      sumBy(ps, 'user_id', 'earnings_minor'),
      await q('SELECT user_id::text AS k, SUM(earnings) AS v FROM payslips GROUP BY 1'),
      totals,
    );
    totalsCompared += compareMaps(
      'payslip net per person',
      sumBy(ps, 'user_id', 'net_minor'),
      await q('SELECT user_id::text AS k, SUM(net) AS v FROM payslips GROUP BY 1'),
      totals,
    );
  }
  if (tableNames.has('wallet_transactions')) {
    totalsCompared += compareMaps(
      'wallet balance per person',
      sumBy(ctx.rows('wallet_transactions'), 'user_id', 'amount_minor'),
      await q('SELECT user_id::text AS k, SUM(amount) AS v FROM wallet_transactions GROUP BY 1'),
      totals,
    );
  }

  // ---- classes per UTC day (not deleted)
  const dayMismatches: TotalCheck[] = [];
  let daysCompared = 0;
  if (tableNames.has('class_sessions')) {
    const src = new Map<string, bigint>();
    for (const r of ctx.rows('classes')) {
      if (utc(r.deleted_at, ctx.opts.appTimezone)) continue;
      const timing = classTiming(ctx, r);
      const k = timing ? timing.startsAt.toISOString().slice(0, 10) : 'untimed';
      src.set(k, (src.get(k) ?? 0n) + 1n);
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ k: string; n: bigint }>>(
      `SELECT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS k, COUNT(*)::bigint AS n FROM class_sessions WHERE deleted_at IS NULL GROUP BY 1`,
    );
    const dst = new Map(rows.map((r) => [r.k, BigInt(r.n)]));
    const all: TotalCheck[] = [];
    daysCompared = compareMaps('classes per UTC day', src, dst, all);
    dayMismatches.push(...all.filter((x) => !x.ok));
  }

  // ---- Quran reference (seeded by the migration) equals Laravel's
  let surahsOk = true;
  const srcSurahs = ctx.rows('quran_surahs');
  if (srcSurahs.length) {
    const dst = await prisma.quranSurah.findMany({ orderBy: { number: 'asc' } });
    surahsOk =
      dst.length === srcSurahs.length &&
      srcSurahs.every(
        (s, i) => dst[i]?.number === int(s, 'number') && dst[i]?.ayahCount === int(s, 'ayah_count'),
      );
  }

  // ---- spot checks
  const spots: SpotCheck[] = [];
  const rand = prng(opts.seed);
  const pool = SPOT_TABLES.map(([table, model]) => ({
    model,
    batch: batches.find((b) => b.table === table),
  })).filter(
    (p): p is { model: ModelName; batch: TargetBatch } => !!p.batch && p.batch.rows.length > 0,
  );
  const delegates = prisma as unknown as Record<ModelName, Finder>;
  for (let i = 0; i < opts.spotChecks && pool.length; i++) {
    const { model, batch } = pool[i % pool.length]!;
    const planned = batch.rows[Math.floor(rand() * batch.rows.length)]!;
    const id = planned.id as number;
    const stored = await delegates[model].findUnique({ where: { id } });
    const diffs: string[] = [];
    if (!stored) diffs.push('row missing');
    else {
      const later = new Set(
        (batch.selfRefs ?? []).map((s) =>
          s.column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        ),
      );
      for (const [k, v] of Object.entries(planned)) {
        if (later.has(k)) continue;
        let a = v;
        let b = stored[k];
        if (ENCRYPTED.has(k)) {
          a = typeof v === 'string' ? ctx.opts.targetCipher.decrypt(v) : v;
          b = typeof b === 'string' ? ctx.opts.targetCipher.decrypt(b) : b;
        }
        if (norm(a) !== norm(b))
          diffs.push(`${k}: expected ${norm(a).slice(0, 80)}, found ${norm(b).slice(0, 80)}`);
      }
      for (const sr of batch.selfRefs ?? []) {
        const want = sr.pairs.find(([pid]) => pid === id)?.[1] ?? null;
        const key = sr.column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        if (norm(want) !== norm(stored[key]))
          diffs.push(`${key}: expected ${norm(want)}, found ${norm(stored[key])}`);
      }
    }
    spots.push({ table: batch.table, id, ok: diffs.length === 0, diffs });
  }

  const ok =
    counts.every((c) => c.ok) &&
    totals.every((t) => t.ok) &&
    dayMismatches.length === 0 &&
    spots.every((s) => s.ok) &&
    surahsOk;
  return {
    ok,
    counts,
    totals,
    totalsCompared,
    days: { compared: daysCompared, mismatches: dayMismatches },
    spots,
    surahsOk,
  };
}
