# Testing

All commands from `repos/qarabic-platform` (Node 24, pnpm 10). CI (`.github/workflows/ci.yml`) runs
the same set on every PR; a PR is mergeable only when all of it is green.

| Layer           | Tool                                   | Command                                    |
| --------------- | -------------------------------------- | ------------------------------------------ |
| Format          | prettier                               | `pnpm format:check`                        |
| Lint            | eslint 9 (typescript-eslint, next)     | `pnpm lint`                                |
| Types           | tsc strict                             | `pnpm typecheck`                           |
| Unit            | vitest (+ Testing Library, jsdom, MSW) | `pnpm test`                                |
| Build           | tsc / next build                       | `pnpm build`                               |
| API e2e         | vitest + supertest on `qarabic_test`   | `pnpm --filter @qarabic/api test:e2e`      |
| Web e2e         | Playwright + axe on a prod build + MSW | `pnpm --filter @qarabic/web test:e2e`      |
| Web vs real API | Playwright, local API + dev DB         | `pnpm --filter @qarabic/web test:e2e:real` |
| QA journeys     | Playwright, built API + web + Postgres | `pnpm --filter @qarabic/web test:journeys` |
| Dependencies    | pnpm audit                             | `pnpm audit --prod --audit-level high`     |

## Every PR adds

- Backend: a unit test for new logic and an e2e test for each new endpoint, including **401 without
  a session and 403 without the permission**.
- Frontend: a component test for new forms/views (validation, error, empty) and an E2E path for any
  key flow.
- UI changes: the screen passes `e2e/standards.spec.ts` style checks (no horizontal scroll at
  375/768/1440, Arabic and English, axe clean) and has screenshots in the PR.

## QA journeys (`apps/web/e2e-journeys/`)

A journey is one business scenario across roles, run on the **real stack**: the built API, its own
PostgreSQL `*_test` database and the production web build, with no MSW mocks. It answers «does the
academy's day still work end to end?», which no layer above checks on its own.

- **Run:** `pnpm --filter @qarabic/web test:journeys` (config `playwright.journeys.config.ts`). It
  needs a local Postgres with an empty `qarabic_journeys_test` database owned by `qarabic`
  (`JOURNEYS_DATABASE_URL` to use another; it must end in `_test`). Ports 3101 (API) and 3100 (web),
  movable with `JOURNEYS_API_PORT` / `JOURNEYS_WEB_PORT`. Secrets are throwaway, made per run.
- **Data:** `pnpm --filter @qarabic/api qa:seed` (the global setup runs it) **empties** the `*_test`
  database and seeds the QA personas: `QA Admin`, `QA Teacher` (with a made-up tracked Zoom
  meeting), `QA Parent` + `QA Student`, all on `qa.qarabic.test`, password `QA_PASSWORD`. It refuses
  any database not named `*_test`. Never production data, never a real person.
- **No real outside calls:** the API runs with `e2e-journeys/no-egress.mjs` preloaded (any request
  off localhost throws) and `SCHEDULER_ENABLED=false`; every browser context stubs non-local URLs.
  Zoom is simulated by posting webhook events signed exactly like Zoom (`x-zm-signature` =
  `v0=` + HMAC-SHA256 of `v0:{timestamp}:{body}` with the run's test secret). Mail and WhatsApp are
  off; notifications are asserted in the in-app outbox (`/me/notifications`), never by delivery.
  Cron jobs a journey needs run once through the API CLI (e.g. `cli operations:notify`). If a
  future journey ever needs a real Zoom meeting, the licensed Zoom user «Qarabic Teacher 7» is
  reserved for QA (D152); that needs the owner's go first, never production data.
- **Shape:** one `test()` per journey, tagged with its id (`@J1`), with the planned steps in a
  `step` annotation and each step a numbered `test.step` that asserts and calls `shot()`. No
  retries: a failure stops the story and the remaining steps show as «not run».
- **Report:** `e2e-journeys/summary-reporter.ts` writes `journeys-summary.json` (journey, steps,
  status, duration, screenshot, commit, run URL). The `QA journeys` workflow
  (`.github/workflows/journeys.yml`) runs on every PR, nightly at 02:30 Cairo and by hand; it
  prints the step table on the run page and uploads the screenshots and report. Not a required
  check until the owner decides.
- **Public feed:** after a nightly or manual run on `main` (never a PR), the workflow's `publish`
  job commits to the `qa-reports` branch (`e2e-journeys/report-feed.mjs`): `latest.json` (the run's
  summary), `history.json` (last 60 journey runs), `runs.json` / `steps.json` (the «Qarabic QA»
  dashboard's datasets) and `shots/` (the latest failing step's screenshot). Read them at
  `https://raw.githubusercontent.com/techadmy/qarabic-platform/qa-reports/<file>`: the owner's
  dashboard and the Control Center use them. QA personas only; nothing else is written there.
- **Adding a journey:** a new `jN-*.spec.ts` with its own tag; reuse `helpers.ts` (sign-in, API with
  CSRF, Zoom signing, CLI); add personas to `qa-seed.ts` only if the journey needs a new role.
  Assert what the user sees (role/label locators) and the API state behind it.

## Browser checks by Claude

Use the Playwright MCP (plugin `playwright`) or the built-in browser against **local** servers only
(`next start` with mocks, or local API + `qarabic_dev`), with the fake seed/mock accounts. Never run
browser tests or write actions against `qarabic.com` or `api.qarabic.com`.

If `pnpm build` fails with "Module not found" after copying the repo, run `pnpm install
--frozen-lockfile` first (a stale `node_modules` was the cause on 2026-11-12).
