// Updates the public QA feed (the `qa-reports` branch) with one run's summary:
//   latest.json  — that run's journeys-summary.json, as is (schema 1);
//   history.json — { schema: 1, runs: [...] }: one row per journey per run, newest last, last 60;
//   runs.json / steps.json — the «Qarabic QA» dashboard's datasets ({rows, meta});
//   shots/<journey>-step-<n>.png — the failing step's screenshot of the latest run (none if green).
// Usage: node e2e-journeys/report-feed.mjs <feed-dir> <journeys-summary.json>
// The summary's screenshot paths are relative to its own folder (the run's artifact).
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runRowsOf, stepRows, writeDataset } from './dashboard-rows.mjs';

const KEEP = 60;
const [feedDir, summaryFile] = process.argv.slice(2);
if (!feedDir || !summaryFile) {
  console.error('Usage: node e2e-journeys/report-feed.mjs <feed-dir> <journeys-summary.json>');
  process.exit(2);
}
const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
if (summary.schema !== 1) throw new Error(`Unknown summary schema ${summary.schema}.`);
mkdirSync(feedDir, { recursive: true });

const historyFile = join(feedDir, 'history.json');
/** The feed's history so far; none on the branch's first run. */
function readHistory() {
  try {
    return JSON.parse(readFileSync(historyFile, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { schema: 1, runs: [] };
    throw e;
  }
}
const history = readHistory();
// A re-run of the same summary replaces its rows instead of adding them twice.
const kept = history.runs.filter((r) => r.runAt !== summary.generatedAt);
const runs = [...kept, ...runRowsOf(summary)]
  .sort((a, b) => a.runAt.localeCompare(b.runAt))
  .slice(-KEEP);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
writeFileSync(historyFile, json({ schema: 1, runs }));
writeFileSync(join(feedDir, 'latest.json'), json(summary));
writeDataset(join(feedDir, 'runs.json'), runs);
writeDataset(join(feedDir, 'steps.json'), stepRows([summary]));

// The latest failure's screenshots only: the branch must not grow with every run.
const shots = join(feedDir, 'shots');
rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const base = dirname(resolve(summaryFile));
for (const journey of summary.journeys) {
  for (const step of journey.steps) {
    if (step.status !== 'failed' || !step.screenshot) continue;
    const from = resolve(base, step.screenshot);
    mkdirSync(shots, { recursive: true });
    try {
      copyFileSync(from, join(shots, `${journey.id}-step-${step.n}.png`));
    } catch (e) {
      // A screenshot the run never wrote (it stopped first): the feed goes on without it.
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
const shotCount = readdirSync(shots, { withFileTypes: true }).length;
console.log(
  `QA feed: ${runs.length} run row(s), status ${summary.status}, ${shotCount} screenshot(s).`,
);
