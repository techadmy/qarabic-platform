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
