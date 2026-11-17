import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apiEnv } from './env';

/** Before the journeys: empty the `*_test` database and seed the QA personas (qa-seed.ts). */
export default function globalSetup() {
  execFileSync('pnpm', ['exec', 'tsx', 'prisma/qa-seed.ts'], {
    cwd: fileURLToPath(new URL('../../api', import.meta.url)),
    env: { ...process.env, ...apiEnv },
    stdio: 'inherit',
  });
}
