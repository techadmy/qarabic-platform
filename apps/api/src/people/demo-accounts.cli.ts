import { cleanCredential } from '@qarabic/shared';
import { PasswordsService } from '../auth/passwords.service.js';
import { loadEnv } from '../config/env.js';
import { createPrismaClient } from '../prisma/prisma.service.js';
import { DemoAccountsError, ensureDemoAccounts } from './demo-accounts.js';

/**
 * `cli demo:accounts` (D153, docs/36; `pnpm --filter @qarabic/api demo:accounts`): the permanent demo teacher, parent
 * and students the owner logs in as for manual tests. Unlike qa:seed it never empties anything and
 * may run on production: it creates what is missing, puts the demo records back in shape and only
 * touches `@demo.qarabic.test` logins. The password comes from DEMO_PASSWORD or, when unset, a
 * hidden prompt; it is never printed or stored anywhere but as a hash.
 */

const MIN_PASSWORD = 12;
const MAX_PASSWORD = 128;

/** Reads one line from the terminal without echoing it (or one line of piped stdin). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(question);
    if (!input.isTTY) {
      let buffer = '';
      input.setEncoding('utf8');
      input.on('data', (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end >= 0) {
          input.pause();
          resolve(buffer.slice(0, end).replace(/\r$/, ''));
        }
      });
      input.on('end', () => resolve(buffer.replace(/\r?\n$/, '')));
      input.on('error', reject);
      return;
    }
    let value = '';
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const done = (fn: () => void) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stderr.write('\n');
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('Cancelled.')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}

/** Exit code: 0 done, 1 refused or failed (the message says why; never the password). */
export async function runDemoAccounts(): Promise<number> {
  const env = loadEnv();
  // Cleaned the way the login form cleans it, so what Ahmed types there matches.
  const password = cleanCredential(
    process.env.DEMO_PASSWORD || (await promptHidden('Demo password: ')),
  );
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    console.error(`The demo password needs ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`);
    return 1;
  }
  const passwordHash = await new PasswordsService().hash(password);
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const result = await ensureDemoAccounts(prisma, passwordHash, Date.now());
    console.log(`Created: ${result.created.length ? result.created.join(', ') : 'nothing'}`);
    console.log(`Kept in shape: ${result.updated.length ? result.updated.join(', ') : 'nothing'}`);
    console.log('Demo accounts ready. Classes appear after the next class-generator run.');
    return 0;
  } catch (error) {
    if (error instanceof DemoAccountsError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}
