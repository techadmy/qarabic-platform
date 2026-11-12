import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Period } from './payroll/period.js';
import { PayrollRunsService } from './payroll/runs.service.js';
import { SessionJobs } from './sessions/jobs.js';

/**
 * Command line for the class jobs (Laravel artisan commands), run from the built app:
 *
 *   pnpm --filter @qarabic/api cli sessions:generate [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *                                                    [--enrollment=ID] [--dry-run]
 *   pnpm --filter @qarabic/api cli session-requests:expire
 *   pnpm --filter @qarabic/api cli zoom:ensure-upcoming
 *   pnpm --filter @qarabic/api cli sessions:audit-overlaps [--days=30]   (exit 1 on overlaps)
 *   pnpm --filter @qarabic/api cli payroll:compute [--period=YYYY-MM]       (N7; default: this month)
 *
 * The CLI never starts the cron (`SCHEDULER_ENABLED=false`).
 */
process.env.SCHEDULER_ENABLED = 'false';

function option(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const jobs = app.get(SessionJobs);
    switch (command) {
      case 'sessions:generate': {
        const from = option(args, 'from');
        const to = option(args, 'to') ?? from;
        const enrollment = option(args, 'enrollment');
        const dryRun = args.includes('--dry-run');
        for (const [name, value] of [
          ['from', from],
          ['to', to],
        ] as const) {
          if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            console.error(`--${name} must be YYYY-MM-DD.`);
            return 2;
          }
        }
        const result = await jobs.generate({
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(enrollment ? { enrollmentId: Number(enrollment) } : {}),
          dryRun,
        });
        if (!result) {
          console.log('Another generator run holds the lock.');
          return 0;
        }
        console.log(
          `${dryRun ? 'Would create' : 'Created'} ${dryRun ? result.toCreate.length : result.created.length}, ` +
            `skipped ${result.skipped}, cancelled by rule ${result.cancelledByRule}.`,
        );
        return 0;
      }
      case 'session-requests:expire':
        console.log(`Expired ${await jobs.expireRequests()} request(s).`);
        return 0;
      case 'zoom:ensure-upcoming':
        console.log(`Checked ${await jobs.ensureZoom()} class(es) for meetings.`);
        return 0;
      case 'sessions:audit-overlaps': {
        const overlaps = await jobs.auditOverlaps(Number(option(args, 'days') ?? 30));
        if (!overlaps.length) {
          console.log('No overlapping classes.');
          return 0;
        }
        console.table(overlaps);
        console.error(`${overlaps.length} overlap(s) found.`);
        return 1;
      }
      case 'payroll:compute': {
        // Creates the month's payroll run or recomputes an open one (never an approved month).
        const runs = app.get(PayrollRunsService);
        const value = option(args, 'period');
        if (value !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
          console.error('--period must be YYYY-MM.');
          return 2;
        }
        const period = value ? Period.parse(value) : await runs.currentPeriod();
        const result = await runs.computePeriod(period);
        if (result.action === 'locked') {
          console.error(
            `Payroll ${period.toString()} is approved and locked (run ${result.runId}).`,
          );
          return 1;
        }
        console.log(`Payroll ${period.toString()}: run ${result.runId} ${result.action}.`);
        return 0;
      }
      default:
        console.error(
          'Commands: sessions:generate, session-requests:expire, zoom:ensure-upcoming, sessions:audit-overlaps, payroll:compute',
        );
        return 2;
    }
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
