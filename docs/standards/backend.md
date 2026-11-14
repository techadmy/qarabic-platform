# Backend conventions (apps/api)

Stack: NestJS 12 (ESM, SWC in tests), Prisma 7.10 (pinned) + `@prisma/adapter-pg`, PostgreSQL 17,
zod 4 schemas shared from `@qarabic/shared`, pino logging, helmet, OpenAPI outside production.

## Security (must, every endpoint)

- **Deny by default.** The global guard rejects any route without `@Public()`, `@Authenticated()` or
  `@Can('module.action')`. New routes use `@Can` with a permission from the shared role matrix.
- Cookie sessions (hashed in Postgres), CSRF double submit (`X-XSRF-TOKEN`). Passwords: argon2.
- Validate every input with `ZodPipe`/`ZodBody`/`ZodQuery` and the shared schema; ids with `IdPipe`.
  Never trust client-sent ownership (teacher/parent scope comes from the session).
- Errors through `common/errors.ts` + the global filter: no stack traces or SQL in responses.
- Secrets only from env (`config/env.ts` validates them); `.env` never committed; nothing secret in
  logs (pino redaction) or in `NEXT_PUBLIC_*`.
- Audit writes for sensitive changes (`audit/`).

## Database safety

- Schema changes only through Prisma migrations, reviewed in the PR; additive first, destructive
  changes in a later release.
- Local dev DB `qarabic_dev`, tests `qarabic_test` (the e2e setup refuses a URL not ending in
  `_test`). **Never** point any tool, MCP server or test at production; no DB MCP with write access.
- Seed data is fake (`prisma/seed*.ts`); no real names, emails or phones.

## Query efficiency

- Select only needed fields; `include` with care; no N+1 (batch with `in`, or one query + map).
- List endpoints paginate (`common/pagination.ts`) and search through `common/search.ts`.
- Index every foreign key and every column used in a list filter or sort.
- Time is stored UTC; zones are IANA names; conversions in one helper (`common/clock.ts`).

## Structure

`src/<module>/` = `*.controllers.ts` (thin), `*.service.ts` (logic), unit `*.spec.ts`, e2e under
`test/`. Business rules live in services or pure helpers, never in controllers.
