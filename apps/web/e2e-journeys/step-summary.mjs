// Prints journeys-summary.json as Markdown for the GitHub run page ($GITHUB_STEP_SUMMARY).
// Usage: node e2e-journeys/step-summary.mjs journeys-summary.json
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'journeys-summary.json';
if (!existsSync(file)) {
  console.log('### QA journeys\n\nNo summary: the run stopped before the journeys started.');
  process.exit(0);
}
const summary = JSON.parse(readFileSync(file, 'utf8'));
const icon = { passed: '✅', failed: '❌', not_run: '⏸️', skipped: '⏭️' };
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
// A table cell: backslashes, pipes and markup escaped, one line.
const cell = (text) =>
  String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/\s+/g, ' ');

const lines = [`### QA journeys — ${icon[summary.status] ?? ''} ${summary.status}`, ''];
for (const journey of summary.journeys) {
  lines.push(
    `**${journey.id}** ${journey.title}: ${icon[journey.status] ?? ''} ${journey.status} in ${seconds(journey.durationMs)}`,
    '',
    '| # | Step | Result | Time |',
    '|---|------|--------|------|',
  );
  for (const step of journey.steps) {
    const error = step.error ? `<br>${cell(step.error.slice(0, 200))}` : '';
    lines.push(
      `| ${step.n} | ${cell(step.title)}${error} | ${icon[step.status] ?? ''} ${step.status} | ${seconds(step.durationMs)} |`,
    );
  }
  for (const bug of journey.knownBugs ?? []) lines.push(`⚠️ Known bug: ${cell(bug)}`, '');
  lines.push('');
}
lines.push('Screenshots and the Playwright report: the `qa-journeys-…` artifact of this run.');
console.log(lines.join('\n'));
