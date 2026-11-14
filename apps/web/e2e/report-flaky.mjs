// Lists the tests that failed first and passed on retry («flaky») in a Playwright JSON report:
// a warning annotation per test and a table in the job summary, so retries never hide them.
// Usage: node e2e/report-flaky.mjs <results.json>
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'e2e-results.json';
if (!existsSync(file)) process.exit(0);
const report = JSON.parse(readFileSync(file, 'utf8'));
const flaky = [];
const walk = (suite, titles) => {
  for (const child of suite.suites ?? []) walk(child, [...titles, child.title].filter(Boolean));
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status === 'flaky') {
        flaky.push({
          file: spec.file,
          line: spec.line,
          title: [...titles, spec.title].join(' › '),
        });
      }
    }
  }
};
for (const suite of report.suites ?? []) walk(suite, []);

for (const t of flaky) {
  console.log(`::warning file=apps/web/e2e/${t.file},line=${t.line},title=Flaky test::${t.title}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const body = flaky.length
    ? `### ${flaky.length} flaky test(s) — passed only on retry\n\n| Test | File |\n|---|---|\n${flaky
        .map((t) => `| ${t.title.replace(/\|/g, '\\|')} | \`${t.file}:${t.line}\` |`)
        .join('\n')}\n`
    : '### No flaky tests\n';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
}
console.log(`${flaky.length} flaky test(s).`);
