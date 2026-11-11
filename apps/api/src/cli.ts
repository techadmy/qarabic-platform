import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { LeadAlerts } from './crm/alerts.js';
import { SessionJobs } from './sessions/jobs.js';
import { TicketCli } from './support/ticket-cli.js';

/**
 * Command line for the class jobs (Laravel artisan commands), run from the built app:
 *
 *   pnpm --filter @qarabic/api cli sessions:generate [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *                                                    [--enrollment=ID] [--dry-run]
 *   pnpm --filter @qarabic/api cli session-requests:expire
 *   pnpm --filter @qarabic/api cli zoom:ensure-upcoming
 *   pnpm --filter @qarabic/api cli leads:notify   (follow-up due + first-response SLA alerts, N5)
 *   pnpm --filter @qarabic/api cli sessions:audit-overlaps [--days=30]   (exit 1 on overlaps)
 *
 * The support ticket queue (docs/22 §7, Laravel `tickets:*`), writes recorded as "Claude":
 *
 *   pnpm --filter @qarabic/api cli tickets:list [--status=open|closed|all|<s>,…] [--priority=p0,…,none]
 *                                               [--category=] [--queue=] [--channel=] [--since=] [--limit=50] [--json]
 *   pnpm --filter @qarabic/api cli tickets:show <id> [--json] [--attachments=/tmp/ticket-<id>]
 *   pnpm --filter @qarabic/api cli tickets:status <id> [--status=] [--priority=] [--note=] [--pr=] [--resolution=]
 *                                                    [--assign=email|none] [--area=] [--category=] [--queue=] [--as=Claude]
 *   pnpm --filter @qarabic/api cli tickets:reply <id> --body="…" [--internal] [--as=Claude]
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
    if (command?.startsWith('tickets:')) {
      const cli = app.get(TicketCli);
      const run = {
        'tickets:list': () => cli.list(args),
        'tickets:show': () => cli.show(args),
        'tickets:status': () => cli.status(args),
        'tickets:reply': () => cli.reply(args),
      }[command];
      if (!run) {
        console.error('Commands: tickets:list, tickets:show, tickets:status, tickets:reply');
        return 2;
      }
      const result = await run();
      (result.code === 0 ? console.log : console.error)(result.out.join('\n'));
      return result.code;
    }
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
      case 'leads:notify': {
        const sent = await app.get(LeadAlerts).run();
        console.log(`Follow-ups due: ${sent.followUps}; SLA breaches: ${sent.sla}.`);
        return 0;
      }
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
      default:
        console.error(
          'Commands: sessions:generate, session-requests:expire, zoom:ensure-upcoming, sessions:audit-overlaps, leads:notify, ' +
            'tickets:list, tickets:show, tickets:status, tickets:reply',
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
