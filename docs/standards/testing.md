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
| Dependencies    | pnpm audit                             | `pnpm audit --prod --audit-level high`     |

## Every PR adds

- Backend: a unit test for new logic and an e2e test for each new endpoint, including **401 without
  a session and 403 without the permission**.
- Frontend: a component test for new forms/views (validation, error, empty) and an E2E path for any
  key flow.
- UI changes: the screen passes `e2e/standards.spec.ts` style checks (no horizontal scroll at
  375/768/1440, Arabic and English, axe clean) and has screenshots in the PR.

## Browser checks by Claude

Use the Playwright MCP (plugin `playwright`) or the built-in browser against **local** servers only
(`next start` with mocks, or local API + `qarabic_dev`), with the fake seed/mock accounts. Never run
browser tests or write actions against `qarabic.com` or `api.qarabic.com`.

If `pnpm build` fails with "Module not found" after copying the repo, run `pnpm install
--frozen-lockfile` first (a stale `node_modules` was the cause on 2026-11-12).
