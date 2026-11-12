import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FieldCipher } from '../common/crypto.js';
import { createPrismaClient } from '../prisma/prisma.service.js';
import { isZone } from './convert.js';
import { checkTarget, databaseName } from './guard.js';
import { buildPlan, loadPlan, type Plan } from './import.service.js';
import { LaravelCipher } from './laravel-crypt.js';
import { MySqlSource } from './reader.js';
import { renderReport } from './report.js';
import { type LegacySource, redactUrl } from './source.js';
import { verify, type Verification } from './verify.js';

const UTC_ZONES = ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'UCT', 'Etc/UCT', 'Universal', 'Zulu'];

export interface CliResult {
  code: number;
  out: string[];
}

function option(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

export interface LegacyRunInput {
  command: 'legacy:import' | 'legacy:verify';
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Tests inject a memory source; the CLI connects to MySQL. */
  source?: LegacySource;
  now?: Date;
}

/**
 * `legacy:import --source=<mysql url> [--only=people,billing] [--dry-run] [--report=file.md]
 *                [--seed=N] [--spot-checks=20] [--i-know-this-is-production]`
 * `legacy:verify [--only=…] [--report=file.md] [--seed=N]`
 *
 * The source URL defaults to LEGACY_DATABASE_URL; the target is DATABASE_URL. Exit 0 = imported
 * and verified, 1 = a verification mismatch, 2 = refused / bad arguments. Prints no secret.
 */
export async function runLegacy(input: LegacyRunInput): Promise<CliResult> {
  const { command, args, env } = input;
  const out: string[] = [];
  const started = input.now ?? new Date();
  const dryRun = args.includes('--dry-run');
  const only =
    option(args, 'only')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  const seed = Number(option(args, 'seed') ?? started.getTime() % 1_000_000);
  const spotChecks = Number(option(args, 'spot-checks') ?? 20);
  const target = env.DATABASE_URL ?? '';
  const sourceUrl = option(args, 'source') ?? env.LEGACY_DATABASE_URL ?? '';
  const appTimezone = env.LEGACY_APP_TIMEZONE?.trim() || 'UTC';

  if (command === 'legacy:import') {
    const guard = checkTarget(target, args.includes('--i-know-this-is-production'));
    if (!guard.ok) return { code: 2, out: [guard.message] };
  } else if (!databaseName(target)) {
    return { code: 2, out: ['DATABASE_URL is not a valid Postgres URL.'] };
  }
  if (!isZone(appTimezone))
    return {
      code: 2,
      out: ['LEGACY_APP_TIMEZONE must be an IANA zone (Laravel APP_TIMEZONE, UTC in production).'],
    };
  if (!input.source && !/^mysql:\/\//.test(sourceUrl)) {
    return {
      code: 2,
      out: [
        'Set --source=mysql://… or LEGACY_DATABASE_URL (read-only user on the Laravel database copy).',
      ],
    };
  }
  let targetCipher: FieldCipher;
  let legacyCipher: LaravelCipher | null = null;
  try {
    targetCipher = FieldCipher.fromBase64(env.APP_ENCRYPTION_KEY ?? '');
    if (env.LEGACY_APP_KEY) legacyCipher = new LaravelCipher(env.LEGACY_APP_KEY);
  } catch (e) {
    return { code: 2, out: [`Keys: ${(e as Error).message}`] };
  }

  const source = input.source ?? (await MySqlSource.connect(sourceUrl));
  const prisma = createPrismaClient(target);
  const timings: Record<string, number> = {};
  // Prisma's pg adapter writes and reads timestamptz as UTC wall text without an offset, so the
  // stored instants are only true when the session zone is UTC (docs/37 §Assumptions).
  const zone = await prisma.$queryRawUnsafe<Array<{ tz: string }>>(
    `SELECT current_setting('TimeZone') AS tz`,
  );
  if (!UTC_ZONES.includes(zone[0]?.tz ?? '')) {
    await prisma.$disconnect();
    if (!input.source) await source.close();
    return {
      code: 2,
      out: [
        `The target database session time zone is "${zone[0]?.tz}", not UTC: timestamps would be stored shifted. ` +
          `Run ALTER DATABASE ${databaseName(target)} SET timezone TO 'UTC' (or set timezone = 'UTC' in postgresql.conf) and reconnect.`,
      ],
    };
  }
  try {
    out.push(
      `${command}: ${source.label} → database ${databaseName(target)}${dryRun ? ' (dry run)' : ''}`,
    );
    let plan: Plan;
    try {
      plan = await buildPlan(source, { only, appTimezone, legacyCipher, targetCipher });
    } catch (e) {
      return { code: 2, out: [...out, (e as Error).message] };
    }
    timings['read source'] = plan.readMs;
    timings['map'] = plan.mapMs;
    let v: Verification | null = null;
    if (command === 'legacy:import' && !dryRun) {
      const loaded = await loadPlan(prisma, plan);
      timings['load (one transaction)'] = loaded.loadMs;
    }
    if (!dryRun) {
      const t0 = Date.now();
      v = await verify(prisma, plan.ctx, plan.batches, { spotChecks, seed });
      timings['verify'] = Date.now() - t0;
    }
    const rows = plan.batches.reduce((n, b) => n + b.rows.length, 0);
    const issues = plan.ctx.report.issues;
    out.push(
      `Modules: ${plan.modules.map((m) => m.name).join(', ')}. Rows planned: ${rows} in ${plan.batches.length} tables.`,
      `Issues: ${issues.filter((i) => i.kind === 'skipped').length} skipped row(s), ${issues.filter((i) => i.kind === 'changed').length} change(s), ` +
        `${issues.filter((i) => i.kind === 'dropped_column').length} dropped column(s), ${plan.unported.length} table(s) with no counterpart.`,
    );
    if (v) {
      const badCounts = v.counts.filter((c) => !c.ok);
      out.push(
        `Verify: counts ${v.counts.length - badCounts.length}/${v.counts.length} ok, money ${v.totals.filter((t) => t.ok).length}/${v.totals.length} ok, ` +
          `days ${v.days.compared - v.days.mismatches.length}/${v.days.compared} ok, spot checks ${v.spots.filter((s) => s.ok).length}/${v.spots.length} ok → ${v.ok ? 'PASS' : 'FAIL'}`,
      );
      for (const c of badCounts)
        out.push(`  count mismatch ${c.table}: planned ${c.planned}, found ${c.actual}`);
    }
    const file = resolve(
      option(args, 'report') ??
        `legacy-reports/${command.replace(':', '-')}-${started.toISOString().replace(/[:.]/g, '-')}.md`,
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      renderReport(
        {
          command,
          source: source.label === 'memory' ? 'memory' : redactUrl(sourceUrl),
          target: databaseName(target),
          dryRun,
          seed,
          timings,
          startedAt: started,
        },
        plan,
        v,
      ),
    );
    out.push(`Report: ${file}`);
    return { code: v && !v.ok ? 1 : 0, out };
  } finally {
    await prisma.$disconnect();
    if (!input.source) await source.close();
  }
}
