// The «Qarabic QA» dashboard's two datasets, from journeys-summary.json files:
//   runs  — one row per journey per run (the history),
//   steps — one row per step of each journey's latest run.
// CLI: node e2e-journeys/dashboard-rows.mjs <out-dir> <summary.json>...   (writes runs.json, steps.json)
// Summaries hold QA personas only and no secrets, so the rows are safe to publish.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRIGGERS = {
  schedule: 'nightly',
  pull_request: 'PR',
  workflow_dispatch: 'manual',
  push: 'main',
};
const seconds = (ms) => Math.round(ms / 100) / 10;

/** One row per journey of one summary. */
export function runRowsOf(s) {
  return s.journeys.map((j) => ({
    runAt: s.generatedAt,
    journey: j.id,
    title: j.title,
    status: j.status,
    stepsPassed: j.steps.filter((x) => x.status === 'passed').length,
    stepsTotal: j.steps.length,
    failedStep: j.steps.find((x) => x.status === 'failed')?.n ?? null,
    error: j.error,
    durationS: seconds(j.durationMs),
    trigger: TRIGGERS[s.event] ?? 'local',
    branch: s.branch,
    commit: s.commit ? s.commit.slice(0, 7) : null,
    runUrl: s.runUrl,
  }));
}

/** Each journey's latest run, step by step (summaries oldest first). */
export function stepRows(summaries) {
  const latest = new Map();
  for (const s of summaries) for (const j of s.journeys) latest.set(j.id, { s, j });
  return [...latest.values()].flatMap(({ s, j }) =>
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
}

export const META = [{ label: 'Made by', value: 'apps/web/e2e-journeys/dashboard-rows.mjs' }];

export function writeDataset(file, rows) {
  writeFileSync(file, `${JSON.stringify({ rows, meta: META }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [outDir, ...files] = process.argv.slice(2);
  if (!outDir || files.length === 0) {
    console.error('Usage: node e2e-journeys/dashboard-rows.mjs <out-dir> <summary.json>...');
    process.exit(2);
  }
  const summaries = files
    .map((f) => JSON.parse(readFileSync(f, 'utf8')))
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  const runs = summaries.flatMap(runRowsOf);
  const steps = stepRows(summaries);
  writeDataset(join(outDir, 'runs.json'), runs);
  writeDataset(join(outDir, 'steps.json'), steps);
  console.log(`${runs.length} run row(s), ${steps.length} step row(s) → ${outDir}`);
}
