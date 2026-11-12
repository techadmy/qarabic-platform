import type { FieldCipher } from '../common/crypto.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { syncRolesAndPermissions } from '../rbac/sync-roles.js';
import { isZone, json, type Row, str, utc } from './convert.js';
import type { LaravelCipher } from './laravel-crypt.js';
import { MODULES, NO_COUNTERPART, selectModules, sourceTables } from './modules.js';
import {
  ImportReport,
  MapContext,
  type ModelName,
  type ModuleMapper,
  type TargetBatch,
} from './plan.js';
import type { LegacySource } from './source.js';

export interface PlanOptions {
  only: string[] | null;
  appTimezone: string;
  legacyCipher: LaravelCipher | null;
  targetCipher: FieldCipher;
}

export interface Plan {
  ctx: MapContext;
  /** Batches of the selected modules, in load order. */
  batches: TargetBatch[];
  modules: ModuleMapper[];
  /** Laravel tables without a counterpart → row count. */
  unported: Array<{ table: string; rows: number; why: string }>;
  readMs: number;
  mapMs: number;
}

/** `app_settings` value (JSON) of a key, if any. */
function setting(rows: Row[], key: string): unknown {
  const row = rows.find((r) => str(r, 'key') === key);
  return row ? json(row, 'value') : undefined;
}

/**
 * Reads every Laravel table and maps all modules in memory (always all: later modules check
 * their references against the planned ids), then keeps the batches of the selected modules.
 * Pure with respect to the target: nothing is written here.
 */
export async function buildPlan(source: LegacySource, opts: PlanOptions): Promise<Plan> {
  const started = Date.now();
  const src = new Map<string, Row[]>();
  const unported: Plan['unported'] = [];
  const countOnly = new Set([
    'cache',
    'cache_locks',
    'jobs',
    'job_batches',
    'failed_jobs',
    'sessions',
    'personal_access_tokens',
    'migrations',
    'password_reset_tokens',
  ]);
  for (const table of sourceTables()) {
    if (countOnly.has(table)) continue;
    src.set(table, await source.rows(table));
  }
  for (const [table, why] of Object.entries(NO_COUNTERPART)) {
    const rows = countOnly.has(table) ? await source.count(table) : (src.get(table)?.length ?? 0);
    if (rows) unported.push({ table, rows, why });
  }
  const known = new Set([...sourceTables()]);
  for (const table of await source.tables()) {
    if (!known.has(table))
      unported.push({
        table,
        rows: await source.count(table),
        why: 'not known to the importer (new Laravel table?)',
      });
  }
  const readMs = Date.now() - started;

  const settings = src.get('app_settings') ?? [];
  const academy = setting(settings, 'academy.timezone');
  const legacyZone = str(src.get('settings')?.[0] ?? {}, 'timezone');
  const academyTimezone =
    typeof academy === 'string' && isZone(academy)
      ? academy
      : isZone(legacyZone)
        ? legacyZone
        : 'Africa/Cairo';
  const due = setting(settings, 'sessions.report_due_hours');
  const currency = setting(settings, 'payroll.default_currency');
  // Deterministic fallback for null created_at: the newest user creation (reruns stay equal).
  const newest = (src.get('users') ?? [])
    .map((r) => utc(r.created_at, opts.appTimezone))
    .filter((d): d is Date => !!d);
  const fallbackNow = newest.length
    ? new Date(Math.max(...newest.map((d) => d.getTime())))
    : new Date(Date.UTC(2026, 0, 1));

  const report = new ImportReport();
  const ctx = new MapContext(src, report, {
    appTimezone: opts.appTimezone,
    academyTimezone,
    reportDueHours: typeof due === 'number' && due > 0 ? due : 24,
    legacyCipher: opts.legacyCipher,
    targetCipher: opts.targetCipher,
    payrollCurrency: typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'EGP',
    fallbackNow,
  });
  const mapStarted = Date.now();
  const modules = selectModules(opts.only);
  const all: TargetBatch[] = [];
  const owner = new Map<string, string>();
  for (const m of MODULES) {
    for (const b of m.map(ctx)) {
      all.push(b);
      owner.set(b.table, m.name);
    }
  }
  const names = new Set(modules.map((m) => m.name));
  const batches = all.filter((b) => names.has(owner.get(b.table)!));
  return { ctx, batches, modules, unported, readMs, mapMs: Date.now() - mapStarted };
}

type Delegate = { createMany(args: { data: Row[] }): Promise<{ count: number }> };

const CHUNK = 500;

/**
 * Truncate-then-load, all selected modules in ONE transaction (all or nothing): TRUNCATE …
 * CASCADE of the modules' tables (row triggers of the append-only tables do not fire on TRUNCATE),
 * insert every row with its Laravel id, write self references, reset each id sequence to
 * MAX(id)+1, then re-sync the role matrix (new permissions, untouched presets). Running it twice
 * gives the same rows.
 */
export async function loadPlan(
  prisma: PrismaClient,
  plan: Plan,
): Promise<{ loadMs: number; perTable: Record<string, number> }> {
  const started = Date.now();
  const perTable: Record<string, number> = {};
  const tables = [...new Set([...plan.modules.flatMap((m) => [...m.tables, ...(m.clears ?? [])])])];
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `TRUNCATE ${tables.map((t) => `"public"."${t}"`).join(', ')} CASCADE`,
      );
      const delegates = tx as unknown as Record<ModelName, Delegate>;
      for (const b of plan.batches) {
        const t0 = Date.now();
        for (let i = 0; i < b.rows.length; i += CHUNK) {
          await delegates[b.model].createMany({ data: b.rows.slice(i, i + CHUNK) });
        }
        for (const ref of b.selfRefs ?? []) {
          for (let i = 0; i < ref.pairs.length; i += CHUNK) {
            const part = ref.pairs.slice(i, i + CHUNK);
            const values = part
              .map((_, j) => `($${j * 2 + 1}::int, $${j * 2 + 2}::int)`)
              .join(', ');
            await tx.$executeRawUnsafe(
              `UPDATE "${b.table}" SET "${ref.column}" = v.ref FROM (VALUES ${values}) AS v(id, ref) WHERE "${b.table}".id = v.id`,
              ...part.flat(),
            );
          }
        }
        if (b.serial) {
          await tx.$executeRawUnsafe(
            `SELECT setval(pg_get_serial_sequence('"public"."${b.table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${b.table}"), 0) + 1, false)`,
          );
        }
        perTable[b.table] = Date.now() - t0;
      }
      if (plan.modules.some((m) => m.name === 'people')) {
        await syncRolesAndPermissions(tx as unknown as PrismaClient);
        // Rows the sync added (roles / permissions Laravel lacked) get the run's fixed time.
        const keep = (table: string) =>
          (plan.batches.find((b) => b.table === table)?.rows ?? []).map((r) => r.id as number);
        const at = plan.ctx.opts.fallbackNow;
        await tx.$executeRawUnsafe(
          'UPDATE "roles" SET "created_at" = $1, "updated_at" = $1 WHERE NOT ("id" = ANY($2::int[]))',
          at,
          keep('roles'),
        );
        await tx.$executeRawUnsafe(
          'UPDATE "permissions" SET "created_at" = $1 WHERE NOT ("id" = ANY($2::int[]))',
          at,
          keep('permissions'),
        );
        // The sync's upsert touches roles.updated_at: put the imported values back (reruns equal).
        for (const role of plan.batches.find((b) => b.table === 'roles')?.rows ?? []) {
          await tx.$executeRawUnsafe(
            'UPDATE "roles" SET "updated_at" = $1 WHERE "id" = $2',
            role.updatedAt,
            role.id,
          );
        }
      }
    },
    { timeout: 60 * 60_000, maxWait: 60_000 },
  );
  return { loadMs: Date.now() - started, perTable };
}

/** Rows planned per table (used by the CLI summary and the report). */
export function plannedCounts(
  plan: Plan,
): Array<{ table: string; source: string; sourceRows: number; planned: number }> {
  return plan.batches.map((b) => ({
    table: b.table,
    source: b.source,
    sourceRows: b.sourceCount,
    planned: b.rows.length,
  }));
}
