// Turns journeys-summary.json files (newest last) into the «Qarabic QA» dashboard's two datasets:
//   runs.json  — one row per journey per run (the history),
//   steps.json — one row per step of each journey's latest run.
// Usage: node e2e-journeys/dashboard-rows.mjs <out-dir> <summary.json>...
// Summaries hold QA personas only and no secrets, so the rows are safe to attach to the dashboard.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, ...files] = process.argv.slice(2);
if (!outDir || files.length === 0) {
  console.error('Usage: node e2e-journeys/dashboard-rows.mjs <out-dir> <summary.json>...');
  process.exit(2);
}

const trigger = (s) =>
  s.event === 'schedule'
    ? 'nightly'
    : s.event === 'pull_request'
      ? 'PR'
      : s.event === 'workflow_dispatch'
        ? 'manual'
        : s.event === 'push'
          ? 'main'
          : 'local';
const seconds = (ms) => Math.round(ms / 100) / 10;

const summaries = files
  .map((f) => JSON.parse(readFileSync(f, 'utf8')))
  .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));

const runs = summaries.flatMap((s) =>
  s.journeys.map((j) => ({
    runAt: s.generatedAt,
    journey: j.id,
    title: j.title,
    status: j.status,
    stepsPassed: j.steps.filter((x) => x.status === 'passed').length,
    stepsTotal: j.steps.length,
    failedStep: j.steps.find((x) => x.status === 'failed')?.n ?? null,
    error: j.error,
    durationS: seconds(j.durationMs),
    trigger: trigger(s),
    branch: s.branch,
    commit: s.commit ? s.commit.slice(0, 7) : null,
    runUrl: s.runUrl,
  })),
);

const latest = new Map();
for (const s of summaries) for (const j of s.journeys) latest.set(j.id, { s, j });
const steps = [...latest.values()].flatMap(({ s, j }) =>
  j.steps.map((x) => ({
    journey: j.id,
    runAt: s.generatedAt,
    n: x.n,
    title: x.title,
    status: x.status,
    durationS: seconds(x.durationMs),
    error: x.error,
    // Screenshots are in the run's `qa-journeys-<run id>` artifact; the link opens that run.
    evidence: s.runUrl,
  })),
);

const meta = [{ label: 'Made by', value: 'apps/web/e2e-journeys/dashboard-rows.mjs' }];
writeFileSync(join(outDir, 'runs.json'), `${JSON.stringify({ rows: runs, meta }, null, 2)}\n`);
writeFileSync(join(outDir, 'steps.json'), `${JSON.stringify({ rows: steps, meta }, null, 2)}\n`);
console.log(`${runs.length} run row(s), ${steps.length} step row(s) → ${outDir}`);
