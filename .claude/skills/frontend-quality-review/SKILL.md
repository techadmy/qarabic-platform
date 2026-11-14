---
name: frontend-quality-review
description: Review Qarabic web code (Next.js 16 + React 19 + shadcn/ui in repos/qarabic-platform apps/web and packages/ui) for component architecture, reuse, state and data fetching, forms and validation, loading/error handling, i18n and maintainability. Use when reviewing a frontend PR or diff, a new screen, or when asked whether frontend code follows the project conventions.
---

# Frontend quality review (Qarabic)

Rules: `docs/standards/frontend.md`, `docs/standards/ui-ux.md`. For visuals use the `ui-ux-audit`
skill; for tokens use `design-system-enforcement`; for bug hunting on a diff the built-in
`/code-review` is the tool, this skill checks project conventions.

## Checklist

1. **Reuse before new.** Does a new component duplicate something in `apps/web/components`
   (`data-table`, `page-header`, `states`, `status-badge`, `forms/fields`, `forms/date-time`,
   `list/list-toolbar`) or `packages/ui/src/components`? Duplicates are findings.
2. **Boundaries.** API calls only through `lib/api/*` and parsed with `@qarabic/shared` schemas;
   business logic (time zones, rules, permissions) in `lib/<area>` with unit tests, not in JSX.
3. **Server vs client.** `'use client'` only where needed; no secrets or server-only env in client
   code; only `NEXT_PUBLIC_*` reaches the browser.
4. **Data.** TanStack Query keys consistent; mutations invalidate/patch the right keys; errors
   surfaced through `isApiError` → `ErrorState` or field errors; no unhandled promise (`void` only
   where intentional).
5. **Forms.** react-hook-form + zod from shared; every control labelled; disabled submit while
   pending; server validation errors mapped to fields; nothing lost on failure.
6. **i18n.** Every string in `messages/ar.json` and `en.json` (keys in sync — `messages.test.ts`);
   no concatenated sentences; plurals via ICU.
7. **Types and lint.** No `any`, `as` casts hiding real types, `@ts-ignore`, or disabled lint rules
   without a comment why.
8. **Performance.** No client-side filtering of big lists, no fetch waterfalls, stable keys, heavy
   components lazy-loaded.
9. **Tests.** Component test for new views/forms (validation, empty, error) and E2E for key flows.

Report findings as file:line · problem · suggested change, most severe first. Run
`pnpm lint && pnpm typecheck && pnpm test` from `repos/qarabic-platform` and include the result.
