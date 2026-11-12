import type { Plan } from './import.service.js';
import type { Issue } from './plan.js';
import type { Verification } from './verify.js';

export interface ReportMeta {
  command: string;
  source: string;
  target: string;
  dryRun: boolean;
  seed: number;
  timings: Record<string, number>;
  startedAt: Date;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The markdown report of an import / verify run (no secrets: hosts and database names only). */
export function renderReport(meta: ReportMeta, plan: Plan, v: Verification | null): string {
  const out: string[] = [];
  const o = plan.ctx.opts;
  out.push(`# Legacy import report (${meta.command})`, '');
  out.push(`- Started: ${meta.startedAt.toISOString()}`);
  out.push(`- Source: \`${meta.source}\` → target database \`${meta.target}\``);
  out.push(
    `- Modules: ${plan.modules.map((m) => m.name).join(', ')}${meta.dryRun ? ' (dry run: nothing written)' : ''}`,
  );
  out.push(
    `- Laravel app zone (stored datetimes): \`${o.appTimezone}\`; academy zone (legacy class times): \`${o.academyTimezone}\``,
  );
  out.push(
    `- Report due hours: ${o.reportDueHours}; payroll default currency: ${o.payrollCurrency}`,
  );
  out.push(
    `- Old encrypted values (meeting links, WhatsApp numbers): ${o.legacyCipher ? 'decrypted with LEGACY_APP_KEY and re-encrypted' : 'LEGACY_APP_KEY not set: left empty'}`,
  );
  out.push(`- Result: **${v ? (v.ok ? 'PASS' : 'FAIL') : 'not verified'}**`, '');

  out.push('## Timings', '', '| Step | ms |', '| --- | ---: |');
  for (const [k, ms] of Object.entries(meta.timings)) out.push(`| ${k} | ${ms} |`);
  out.push('');

  out.push(
    '## Row counts',
    '',
    '| Laravel table | Postgres table | Source rows | Planned | In Postgres | Skipped (reported) | OK |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  );
  if (v) {
    for (const c of v.counts)
      out.push(
        `| ${c.source} | ${c.table} | ${c.sourceRows} | ${c.planned} | ${c.actual} | ${c.skipped} | ${c.ok ? 'yes' : '**NO**'} |`,
      );
  } else {
    for (const b of plan.batches)
      out.push(
        `| ${b.source} | ${b.table} | ${b.sourceCount} | ${b.rows.length} | - | ${plan.ctx.report.skippedIn(b.source)} | - |`,
      );
  }
  out.push('');

  out.push(
    '## Laravel tables with no counterpart',
    '',
    '| Table | Rows | Why |',
    '| --- | ---: | --- |',
  );
  for (const u of plan.unported) out.push(`| ${u.table} | ${u.rows} | ${esc(u.why)} |`);
  out.push('');

  if (v) {
    const bad = v.totals.filter((t) => !t.ok);
    out.push('## Money totals (minor units, exact)', '');
    out.push(
      `${v.totalsCompared} totals compared (invoices total/paid/lines and succeeded payments per family; payslip earnings/net and wallet per person): ${bad.length} mismatch(es).`,
      '',
    );
    const scopes = [...new Set(v.totals.map((t) => t.scope))];
    out.push(
      '| Scope | Keys | Source sum | Target sum | OK |',
      '| --- | ---: | ---: | ---: | --- |',
    );
    for (const s of scopes) {
      const rows = v.totals.filter((t) => t.scope === s);
      const sum = (k: 'source' | 'target') =>
        rows.reduce((n, r) => n + BigInt(r[k]), 0n).toString();
      out.push(
        `| ${s} | ${rows.length} | ${sum('source')} | ${sum('target')} | ${rows.every((r) => r.ok) ? 'yes' : '**NO**'} |`,
      );
    }
    if (bad.length) {
      out.push('', '| Scope | Key | Source | Target |', '| --- | --- | ---: | ---: |');
      for (const t of bad) out.push(`| ${t.scope} | ${t.key} | ${t.source} | ${t.target} |`);
    }
    out.push(
      '',
      '## Classes per day',
      '',
      `${v.days.compared} UTC days compared, ${v.days.mismatches.length} mismatch(es).`,
    );
    for (const d of v.days.mismatches)
      out.push(`- ${d.key}: source ${d.source}, target ${d.target}`);
    out.push('', `Quran reference (114 surahs) equal: ${v.surahsOk ? 'yes' : '**NO**'}`, '');
    out.push(
      `## Spot checks (seed ${meta.seed})`,
      '',
      '| Table | Id | OK | Differences |',
      '| --- | ---: | --- | --- |',
    );
    for (const s of v.spots)
      out.push(
        `| ${s.table} | ${s.id} | ${s.ok ? 'yes' : '**NO**'} | ${esc(s.diffs.join('; ')) || '-'} |`,
      );
    out.push('');
  }

  out.push('## Issues (unmappable rows and every lossy change)', '');
  const groups = new Map<string, Issue[]>();
  for (const i of plan.ctx.report.issues) {
    const k = `${i.kind} · ${i.table}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  if (!groups.size) out.push('None.');
  for (const [k, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`### ${k} (${list.length})`, '');
    for (const i of list.slice(0, 200))
      out.push(`- ${i.id !== null ? `#${i.id}: ` : ''}${esc(i.reason)}`);
    if (list.length > 200) out.push(`- … ${list.length - 200} more`);
    out.push('');
  }
  return out.join('\n');
}
