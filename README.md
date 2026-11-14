# Qarabic platform

The new Qarabic LMS: NestJS API, Next.js + shadcn/ui web app, PostgreSQL (decision D139, plan in `docs/34-stack-migration-plan.md` of the workspace).

```
apps/api         NestJS backend (Prisma + PostgreSQL)
apps/web         Next.js app (shadcn/ui only, Arabic RTL first)
packages/shared  zod schemas, types and the role matrix shared by api and web
packages/config  shared TypeScript config
```

## Getting started

```bash
corepack enable   # or: npm i -g pnpm@10
pnpm install
pnpm build && pnpm test
```

## UI rule

shadcn/ui only. Every screen starts from official shadcn components and blocks; no home-made layouts,
no gradients, glows, emoji or decorative cards. Design changes only when the owner asks for them.

## API (apps/api)

NestJS 12 + Prisma 7.10 (pinned) + PostgreSQL 17. Cookie sessions stored hashed in Postgres, CSRF
double submit (`GET /api/v1/auth/csrf`, then send `X-XSRF-TOKEN`), deny-by-default guard with
`@Public()` / `@Can('module.action')` / `@Authenticated()`. OpenAPI at `/api/docs` outside production.

```bash
# Local Postgres on port 5433 (once)
initdb -D ~/.local/qarabic-pg -U postgres --auth=trust -E UTF8 --locale=C
LC_ALL=en_US.UTF-8 pg_ctl -D ~/.local/qarabic-pg -o "-p 5433" -l ~/.local/qarabic-pg.log start
createdb -h localhost -p 5433 -U postgres qarabic_dev
createdb -h localhost -p 5433 -U postgres qarabic_test

cp apps/api/.env.example apps/api/.env      # then edit
pnpm --filter @qarabic/api db:migrate       # prisma migrate dev
pnpm --filter @qarabic/api db:seed          # roles, permissions, courses (+ dev admin, fake demo people)
pnpm --filter @qarabic/api dev              # http://localhost:3001/api/v1/health
pnpm --filter @qarabic/api test:e2e         # against TEST_DATABASE_URL (must end in _test)
pnpm --filter @qarabic/web test:e2e         # web e2e on the MSW mocks (production build)
pnpm --filter @qarabic/web test:e2e:real    # web e2e on the real API + the seeded dev database
```

`test:e2e:real` (`apps/web/e2e/real-api*.spec.ts`, also a CI job) builds and starts the API and the
web app itself (or reuses servers already on 3000/3001; `E2E_PORT`, `E2E_API_PORT` and
`E2E_BASE_URL` move them). The portal spec (`real-api-portals`) signs in as the seed's made-up
demo parents and teacher: run `db:seed` with `SEED_DEMO_PASSWORD` set (dev only) and pass the same value
as `E2E_DEMO_PASSWORD` (or keep it in `apps/api/.env`); without it that spec is skipped. The N3–N7 flows write to the dev database and pick a fresh lead,
invoice month and payroll month each run, so the suite can run again without reseeding. The API's
rate limits are in memory: running it many times within an hour (10 tickets an hour per user,
5 logins a minute) needs an API restart in between. A public-form lead sent again from the same
address within the hour is scored as spam; the test accepts «جديد» or «مزعج». Every run adds a trial and a
weekly time on a demo teacher (spread by the run's tag); after a few hundred runs the demo
teachers' days fill up and the N5 flow finds no free time: point `DATABASE_URL` at a fresh
`_dev` database, then `db:deploy` and `db:seed`. CI always starts from an empty one.
