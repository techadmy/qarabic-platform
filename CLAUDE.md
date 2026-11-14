# Qarabic platform — instructions for Claude Code

Qarabic is an online Quran and Arabic academy. This repo is the new LMS: families (a parent account
with child students), teachers paid by the hour, and staff (admin, senior manager, manager, monitor,
customer service, billing, accounts, QA). Students and teachers live in different time zones.

This repo is public. Never commit secrets, personal data or production hostnames with credentials.

## Stack

- `apps/api`: NestJS + Prisma + PostgreSQL. `apps/web`: Next.js + React + Tailwind v4 + shadcn/ui
  (`rtl: true`) + next-intl. `packages/ui` (shadcn + tokens), `packages/shared` (zod schemas, role
  matrix). pnpm + turbo.
- Standards: `docs/standards/` (`backend.md`, `frontend.md`, `ui-ux.md`, `design-tokens.md`,
  `testing.md`). Review skills: `.claude/skills/`.

## Hard rules (enforced by `.claude/settings.json` and `.claude/hooks/qarabic-guard.py`)

- Never push to `main`; one branch per task, open a PR, merge only on green CI. No force push.
- Never use production data. Tests run only against databases named `*_test` (dev: `*_dev`).
- Never read or print `.env` files or credentials.
- No messages to real families and no real money: payment providers in sandbox only.

## Product rules

- Every endpoint: `@Can()` permission + zod validation + 401/403 e2e tests. Parent and teacher
  scope comes from the session, never from the request.
- Separation of duties: nobody approves anything about themselves (leave, attendance, fines,
  bonuses, adjustments, payroll runs). Admin approves the senior manager's and accountant's own
  requests.
- Parents and teachers never see staff names or internal notes; show the role only.
- An overpayment stays as a family credit, flagged for review.
- Teacher hours are rounded per class, as in the old system.
- Times: the viewer's zone first, plus the other party's time with its zone label.
- UI: shadcn/ui only, never invent layouts; tokens only (no raw hex or palette classes); logical
  CSS only (`ms/me`, `ps/pe`, `start/end`); Arabic UI text in Modern Standard Arabic.
- Destructive actions need a confirm (with a reason when the record matters); reversible ones get
  undo. No state change from a GET link.

## Definition of done

`pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test`, API e2e, web e2e
(Playwright + axe at 375/768/1440, Arabic and English) all green; `/security-review` run on the
branch; screenshots in the PR for UI changes.
