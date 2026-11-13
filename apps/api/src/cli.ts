import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { OutboxService } from './accounting/outbox.service.js';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { buildOpenApiDocument } from './common/openapi.js';
import { TrialOffers } from './crm/offers.service.js';
import { LeadAlerts } from './crm/alerts.js';
import { billingCommand } from './billing/cli.js';
import { runLegacy } from './legacy/legacy-cli.js';
import { Period } from './payroll/period.js';
import { PayrollRunsService } from './payroll/runs.service.js';
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
 *   pnpm --filter @qarabic/api cli trials:expire-offers   (close trial offers past their deadline, T3)
 *   pnpm --filter @qarabic/api cli sessions:audit-overlaps [--days=30]   (exit 1 on overlaps)
 *   pnpm --filter @qarabic/api cli payroll:compute [--period=YYYY-MM]       (N7; default: this month)
 *   pnpm --filter @qarabic/api cli openapi:export [--out=openapi.json]   (the whole API as OpenAPI 3)
 *   pnpm --filter @qarabic/api cli ledger:post   (M7: post the billing/payroll outbox to the journal)
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
 * Billing (N6, Laravel `invoices:generate` and the reminders job):
 *
 *   pnpm --filter @qarabic/api cli invoices:generate --period=YYYY-MM [--day=1|15] [--family=ID ...]
 *                                                    (--dry-run | --due=YYYY-MM-DD)
 *   pnpm --filter @qarabic/api cli billing:reminders   (a no-op while billing.notify_parents is off)
 *
 * N8 data move from the Laravel MySQL database (docs/34 §5, docs/37). Refuses a target database
 * whose name does not end in _rehearsal, _dev or _test without --i-know-this-is-production:
 *
 *   pnpm --filter @qarabic/api cli legacy:import [--source=mysql://…] [--only=people,billing,…]
 *                                                [--dry-run] [--report=file.md] [--seed=N]
 *   pnpm --filter @qarabic/api cli legacy:verify [--only=…] [--report=file.md] [--seed=N]
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
  if (command === 'legacy:import' || command === 'legacy:verify') {
    // No Nest app: only DATABASE_URL, APP_ENCRYPTION_KEY and the LEGACY_* variables are needed.
    const result = await runLegacy({ command, args, env: process.env });
    (result.code === 0 ? console.log : console.error)(result.out.join('\n'));
    return result.code;
  }
  if (command === 'openapi:export') {
    // The full HTTP app (routes), never listening: the document is written and the app closed.
    const out = option(args, 'out') ?? 'openapi.json';
    const http = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: ['error', 'warn'],
      bufferLogs: true,
    });
    try {
      configureApp(http);
      const doc = buildOpenApiDocument(http);
      await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`);
      console.log(`OpenAPI: ${Object.keys(doc.paths).length} paths written to ${out}.`);
      return 0;
    } finally {
      await http.close();
    }
  }
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
    const billing = await billingCommand(app, command, args);
    if (billing !== null) {
      (billing.code === 0 ? console.log : console.error)(billing.out.join('\n'));
      return billing.code;
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
      case 'trials:expire-offers':
        console.log(`Expired ${await app.get(TrialOffers).expireDue()} trial offer(s).`);
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
      case 'ledger:post': {
        // Posts the billing and payroll outbox events to the journal (M7; the cron does it every 5 min).
        const r = await app.get(OutboxService).process();
        console.log(`Ledger: ${r.posted} posted, ${r.skipped} skipped, ${r.failed} failed.`);
        return r.failed ? 1 : 0;
      }
      default:
        console.error(
          'Commands: sessions:generate, session-requests:expire, zoom:ensure-upcoming, sessions:audit-overlaps, leads:notify, trials:expire-offers, ' +
            'tickets:list, tickets:show, tickets:status, tickets:reply, invoices:generate, billing:reminders, payroll:compute, ' +
            'ledger:post, openapi:export, legacy:import, legacy:verify',
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
