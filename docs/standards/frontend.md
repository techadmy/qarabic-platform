# Frontend conventions (apps/web, packages/ui)

Stack: Next.js 16 (App Router, Turbopack), React 19, TypeScript strict (`noUncheckedIndexedAccess`),
Tailwind v4, shadcn/ui (radix base, `rtl: true`), next-intl (cookie locale, no locale routes),
TanStack Query + Table, react-hook-form + zod 4, sonner, MSW for mock mode.

## Structure

- `packages/ui` — shadcn components only, added with the shadcn CLI (`components.json` has
  `rtl: true`). Local edits limited to new variants that use tokens (e.g. `Alert variant="warning"`).
- `apps/web/components` — shared app components (`data-table`, `page-header`, `states`,
  `status-badge`, `forms/*`, `list/*`, `shell/*`). **Search here before writing a new one.**
- `apps/web/app/(app)/<area>/` — route + a `*-view.tsx` client component per screen.
- `apps/web/lib/api/*` — the only place that calls the API (`client.ts` handles CSRF, errors,
  `isApiError`). Responses are parsed with `@qarabic/shared` zod schemas.
- `apps/web/lib/<area>` — pure logic (time zones, list params, navigation) with unit tests. Keep
  business logic here, not in components.
- `messages/ar.json` + `en.json` — every UI string; `messages.test.ts` keeps keys in sync.

## Rules

- Server components by default; `'use client'` only for interactive views.
- Data: TanStack Query keys per resource; mutations invalidate the right keys; optimistic only with
  undo. No `fetch` in components.
- Permissions: hide what the user can't do (`lib/navigation`, role matrix from `@qarabic/shared`),
  but the API is the real check.
- No new dependency without a reason in the PR; no second UI library, date library or form library.
- No `any`, no `// @ts-ignore`; `eslint` (next + react-hooks) and `prettier` clean.
- Imports: `@qarabic/ui/components/<name>`, `@/lib/...`, `@/components/...`.
- Performance: route-level code splitting by default; images via `next/image`; lists paginate on the
  server; avoid client-side filtering of large sets.
