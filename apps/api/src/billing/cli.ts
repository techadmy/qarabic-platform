import type { INestApplicationContext } from '@nestjs/common';
import { fromMinor } from '@qarabic/shared';
import { InvoiceService } from './invoices.service.js';
import { BillingJobs } from './jobs.js';

export interface CliResult {
  code: number;
  out: string[];
}

const option = (args: string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/**
 * `invoices:generate` (Laravel `GenerateInvoices`: same rules as `POST /invoice-runs`) and
 * `billing:reminders`. Returns null for any other command.
 */
export async function billingCommand(
  app: INestApplicationContext,
  command: string | undefined,
  args: string[],
): Promise<CliResult | null> {
  if (command === 'billing:reminders') {
    const stats = await app.get(BillingJobs).sendReminders();
    return {
      code: 0,
      out: [
        stats.disabled
          ? 'Parent emails are off (billing.notify_parents): nothing sent.'
          : `Checked ${stats.checked}, sent ${stats.sent}, already ${stats.already}, ` +
            `unreachable ${stats.unreachable}, failed ${stats.failed}.`,
      ],
    };
  }
  if (command !== 'invoices:generate') return null;

  const period = option(args, 'period') ?? '';
  const day = Number(option(args, 'day') ?? 1);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || (day !== 1 && day !== 15)) {
    return { code: 2, out: ['Use --period=YYYY-MM and --day=1|15.'] };
  }
  const families = args
    .filter((a) => a.startsWith('--family='))
    .map((a) => Number(a.slice('--family='.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  const invoices = app.get(InvoiceService);
  const rows = await invoices.preview(period, day, families.length ? families : undefined);
  const out = [
    ['Family', 'Currency', 'Amount', 'Issue?', 'Warnings'].join('\t'),
    ...rows.map((r) =>
      [
        r.familyId,
        r.currency ?? '—',
        r.currency ? fromMinor(r.totalMinor) : '—',
        r.willIssue ? 'yes' : r.existingInvoiceId ? 'exists' : 'no',
        r.warnings.join(', '),
      ].join('\t'),
    ),
  ];
  if (args.includes('--dry-run')) return { code: 0, out };
  const due = option(args, 'due') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due))
    return { code: 2, out: [...out, 'Use --due=YYYY-MM-DD to issue.'] };
  const result = await invoices.run(period, day, due, null, families.length ? families : undefined);
  out.push(`${result.issued.length} issued, ${result.skipped.length} skipped.`);
  return { code: 0, out };
}
