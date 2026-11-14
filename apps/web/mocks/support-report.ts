import {
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_QUEUES,
  type SupportReportDto,
  type SupportReportRowDto,
} from '@qarabic/shared';
import { isClosed, type TicketRow } from './support-db';

/**
 * The mock `GET /support/reports` (S4), as the API computes it: tickets created in the period
 * (UTC days here), first response and SLA met over the decided ones, time to resolve over the
 * closed ones, and Monday weeks.
 */
const DAY = 86_400_000;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const rate = (n: number, d: number) => ({
  numerator: n,
  denominator: d,
  pct: d ? Math.round((n / d) * 1000) / 10 : null,
});

function row(group: TicketRow[], now: number): SupportReportRowDto {
  const ms = (s: string) => Date.parse(s);
  const answered = group.filter((t) => t.firstResponseAt);
  const withSla = group.filter((t) => t.slaDueAt && (t.firstResponseAt || ms(t.slaDueAt) <= now));
  const met = withSla.filter((t) => t.firstResponseAt && ms(t.firstResponseAt) <= ms(t.slaDueAt!));
  const closed = group.filter((t) => isClosed(t.status) && t.closedAt);
  const first = median(answered.map((t) => (ms(t.firstResponseAt!) - ms(t.createdAt)) / 60_000));
  const resolve = median(closed.map((t) => (ms(t.closedAt!) - ms(t.createdAt)) / 3_600_000));
  return {
    created: group.length,
    open: group.filter((t) => !isClosed(t.status)).length,
    closed: closed.length,
    firstResponseMedianMinutes: first === null ? null : Math.round(first),
    slaMet: rate(met.length, withSla.length),
    resolveMedianHours: resolve === null ? null : Math.round(resolve * 10) / 10,
  };
}

function weekStart(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

export function supportReport(
  tickets: TicketRow[],
  from: string,
  to: string,
  now = Date.now(),
): SupportReportDto {
  const rows = tickets.filter((t) => {
    const d = t.createdAt.slice(0, 10);
    return d >= from && d <= to;
  });
  const by = <K extends string>(keys: readonly K[], key: (t: TicketRow) => K) =>
    keys.map((k) => [k, rows.filter((t) => key(t) === k)] as const).filter(([, g]) => g.length > 0);
  const weeks = new Map<string, { created: number; closed: number }>();
  const bump = (w: string, f: 'created' | 'closed') => {
    const e = weeks.get(w) ?? { created: 0, closed: 0 };
    e[f]++;
    weeks.set(w, e);
  };
  for (const t of rows) {
    bump(weekStart(t.createdAt), 'created');
    if (t.closedAt && isClosed(t.status)) bump(weekStart(t.closedAt), 'closed');
  }
  return {
    from,
    to,
    total: row(rows, now),
    byQueue: by(TICKET_QUEUES, (t) => t.queue).map(([queue, g]) => ({ queue, ...row(g, now) })),
    byCategory: by(TICKET_CATEGORIES, (t) => t.category).map(([category, g]) => ({
      category,
      ...row(g, now),
    })),
    byChannel: by(TICKET_CHANNELS, (t) => t.channel).map(([channel, g]) => ({
      channel,
      ...row(g, now),
    })),
    byWeek: [...weeks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([w, c]) => ({ weekStart: w, ...c })),
  };
}
