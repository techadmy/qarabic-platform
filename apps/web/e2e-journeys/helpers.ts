import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { API, apiEnv } from './env';

/** The QA personas of qa-seed.ts (made-up people on qa.qarabic.test). */
export const QA_DOMAIN = 'qa.qarabic.test';
export const QA_ZOOM = {
  hostId: 'qa-zoom-host-1',
  meetingId: '9000000001',
  joinUrl: 'https://us02web.zoom.us/j/9000000001?pwd=qa',
} as const;
export type Persona = 'qa-admin' | 'qa-teacher' | 'qa-teacher2' | 'qa-parent' | 'qa-family2';
export const NAMES = {
  admin: 'QA Admin',
  teacher: 'QA Teacher',
  trialTeacher: 'QA Trial Teacher',
  parent: 'QA Parent',
  student: 'QA Student',
} as const;

export function account(persona: Persona) {
  return { email: `${persona}@${QA_DOMAIN}`, password: process.env.QA_PASSWORD! };
}

/** Signs in through the login form (one login per persona per run: the API allows 5 a minute). */
export async function signIn(page: Page, persona: Persona) {
  const { email, password } = account(persona);
  await page.goto('/login');
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('main h1').first()).toBeVisible();
}

/** The API with the page's own session (its cookies) and the CSRF header for writes. */
export function api(page: Page) {
  const request: APIRequestContext = page.context().request;
  const csrf = async () => {
    await request.get(`${API}/auth/csrf`);
    const cookies = await page.context().cookies();
    return decodeURIComponent(cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  };
  const read = async (res: Awaited<ReturnType<APIRequestContext['get']>>) => {
    const text = await res.text();
    // The journeys assert on the API's JSON directly (its shapes are pinned by the API e2e).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status(), body: (text ? JSON.parse(text) : null) as any };
  };
  return {
    get: async (path: string) => read(await request.get(`${API}${path}`)),
    send: async (method: 'POST' | 'PUT' | 'PATCH', path: string, data: unknown) =>
      read(
        await request.fetch(`${API}${path}`, {
          method,
          data,
          headers: { 'X-XSRF-TOKEN': await csrf() },
        }),
      ),
  };
}

/** A full-page screenshot attached to the report as `step-<n>` (the summary links it). */
export async function shot(page: Page, testInfo: TestInfo, step: number, label: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const path = testInfo.outputPath(`step-${String(step).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(`step-${step}`, { path, contentType: 'image/png' });
}

/**
 * Gives a login the journey created through the product (a converted family) the QA password:
 * mail is off, so no invitation reaches anyone. QA addresses only (qa-seed.ts checks).
 */
export function setQaPassword(email: string) {
  execFileSync('pnpm', ['exec', 'tsx', 'prisma/qa-seed.ts', `--password-for=${email}`], {
    cwd: fileURLToPath(new URL('../../api', import.meta.url)),
    env: { ...process.env, ...apiEnv },
    stdio: 'pipe',
  });
}

/** Runs an API CLI command (a cron job once) against the journeys' database. */
export function cli(...args: string[]): string {
  return execFileSync(
    'node',
    ['--import', '../web/e2e-journeys/no-egress.mjs', 'dist/cli.js', ...args],
    {
      cwd: fileURLToPath(new URL('../../api', import.meta.url)),
      env: { ...process.env, ...apiEnv },
      encoding: 'utf8',
    },
  );
}

// ------------------------------------------------------------------ simulated Zoom

/** A Zoom webhook body for the QA teacher's personal meeting (docs/42 §6 event shapes). */
export function zoomEvent(
  name: 'meeting.started' | 'meeting.participant_joined' | 'meeting.participant_left',
  at: Date,
  participant?: { teacher: boolean; left?: boolean },
) {
  const time = at.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    event: name,
    event_ts: at.getTime(),
    payload: {
      account_id: 'qa-account',
      object: {
        id: QA_ZOOM.meetingId,
        uuid: `qa-meeting-${QA_ZOOM.meetingId}-${at.toISOString().slice(0, 10)}`,
        host_id: QA_ZOOM.hostId,
        ...(name === 'meeting.started' ? { start_time: time } : {}),
        ...(participant
          ? {
              participant: {
                id: participant.teacher ? QA_ZOOM.hostId : '',
                user_id: participant.teacher ? 'qa-zoom-teacher' : 'qa-zoom-student',
                user_name: participant.teacher ? 'Teacher' : 'Student',
                ...(participant.left ? { leave_time: time } : { join_time: time }),
              },
            }
          : {}),
      },
    },
  };
}

/**
 * Posts one event to the webhook exactly as Zoom signs it: `x-zm-signature` =
 * `v0=` + HMAC-SHA256(secret, `v0:{timestamp}:{raw body}`), with a fresh timestamp.
 */
export async function postZoom(request: APIRequestContext, body: object) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', apiEnv.ZOOM_WEBHOOK_SECRET!)
    .update(`v0:${ts}:${raw}`)
    .digest('hex')}`;
  const res = await request.post(`${API}/integrations/zoom/webhook`, {
    headers: {
      'Content-Type': 'application/json',
      'x-zm-request-timestamp': ts,
      'x-zm-signature': signature,
    },
    data: raw,
  });
  expect(res.status(), `webhook ${(body as { event: string }).event}`).toBe(200);
}

// ------------------------------------------------------------------ time

/** Today's local date, weekday (1 = Monday … 7 = Sunday) and `HH:MM` in a zone, at an instant. */
export function localParts(at: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const weekdays: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    weekday: weekdays[p.weekday!]!,
  };
}
