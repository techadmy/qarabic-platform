---
name: fullstack-quality-review
description: Review a Qarabic feature end to end across repos/qarabic-platform (NestJS + Prisma/PostgreSQL API, shared zod schemas, Next.js web) for API contracts, server-side validation, authentication and permission checks, data scoping, error handling, database queries and migrations, and tests. Use when reviewing a feature PR that touches both apps/api and apps/web, a new endpoint, a Prisma migration, or when asked if a feature is secure and correct end to end.
---

# Full-stack quality review (Qarabic)

Rules: `docs/standards/backend.md`, `docs/standards/frontend.md`, `docs/standards/testing.md`,
security checklist in `docs/25-engineering-standard.md` §1.2. Business rules come from the old
system docs (`04`–`07`, `33`); the old system's real behaviour outranks the agency spec.

## Steps

1. **Contract.** Find the shared schema in `packages/shared` for each request/response. The API
   validates input with it (`ZodBody`/`ZodQuery`/`ZodPipe`, `IdPipe`) and the web parses responses
   with it. Mismatch, optional-vs-required drift or duplicated local types are findings.
2. **AuthN/AuthZ.** Every new route has `@Can('module.action')` (or a justified `@Public()` /
   `@Authenticated()`); the permission exists in the shared role matrix; teacher/parent scope is taken
   from the session, never from the request. Check for IDOR: can user A read/change B's record by id?
3. **Errors.** Domain errors via `common/errors.ts`; correct status codes (400/401/403/404/409/422);
   no stack traces, SQL or secrets in responses or logs; the web shows them in the right place.
4. **Database.** Prisma migration reviewed: additive, indexed foreign keys and filter/sort columns,
   no data loss; queries select only needed fields, no N+1, lists paginated; writes that must be
   atomic use a transaction; times stored UTC with IANA zones.
5. **Side effects.** Audit log for sensitive changes; emails/notifications idempotent; cron jobs safe
   to re-run.
6. **Tests.** Unit for logic; API e2e for each endpoint including 401 and 403 cases (runs only
   against a DB named `*_test`); web component + E2E for the flow. Run the commands in
   `docs/standards/testing.md` and report real results.
7. **Safety.** Never point anything at production data; `.env` and credentials never printed.
8. **Security pass.** Run the built-in `/security-review` on the branch; separation of duties (no
   one approves their own leave, fine, bonus or payroll run, D142); staff names and internal notes
   never reach parent/teacher responses; money changes are idempotent and audited.

Output: findings by severity (P0–P3), each with file:line, the failure scenario and the fix; then the
test results; then what you could not verify.
