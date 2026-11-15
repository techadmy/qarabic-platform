// Turns the moderate axe violations recorded by `AXE_BASELINE_UPDATE=1 playwright test` (in
// e2e/.axe-moderate.log) into e2e/axe-moderate-baseline.json: sorted, unique «page rule» keys.
// Usage: node e2e/axe-baseline.mjs
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const log = fileURLToPath(new URL('./.axe-moderate.log', import.meta.url));
const out = fileURLToPath(new URL('./axe-moderate-baseline.json', import.meta.url));
const keys = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
const known = [...new Set(keys)].sort();
writeFileSync(
  out,
  `${JSON.stringify(
    {
      about:
        'Moderate axe violations known on 2026-11-14 (page + rule). A new one fails the e2e; fix it, or add it here with the PR that explains why. Remove entries as they are fixed.',
      known,
    },
    null,
    2,
  )}\n`,
);
rmSync(log, { force: true });
console.log(`${known.length} known moderate violation(s) written to ${out}.`);
