import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyTestEnv } from './test-env.js';

/** Applies the committed migrations to the test database once per run. */
export default function setup(): void {
  applyTestEnv();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
    stdio: 'pipe',
  });
}
