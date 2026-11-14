# Qarabic engineering and UI standards (index)

Short, enforceable rules for the new stack (`repos/qarabic-platform`: NestJS + Prisma/PostgreSQL API,
Next.js + shadcn/ui web, D139). They sit on top of the documents that already hold the detail; when
two say different things, the older numbered doc and `02-decisions.md` win and this folder is fixed.

| File                                 | What it covers                                                              |
| ------------------------------------ | --------------------------------------------------------------------------- |
| [design-tokens.md](design-tokens.md) | Every token in `packages/ui/src/styles/globals.css` and the scales to use   |
| [ui-ux.md](ui-ux.md)                 | Screen checklist (short form of `15` §5), a11y, RTL/LTR, states, dashboards |
| [frontend.md](frontend.md)           | Next.js/React/shadcn conventions, component reuse, forms, data fetching     |
| [backend.md](backend.md)             | NestJS/Prisma conventions, validation, auth, DB safety, query efficiency    |
| [testing.md](testing.md)             | Test layers, commands, what every PR must add, browser checks               |

Source documents: `15-ux-analysis.md` §5 (UX standards, DoD §5.18), `25-engineering-standard.md`
(DoD, security checklist, branching, release), `34-stack-migration-plan.md` (architecture),
`apps/web/RTL.md` (shadcn RTL notes).

Project skills that apply these rules live in `.claude/skills/` at the workspace root:
`ui-ux-audit`, `frontend-quality-review`, `fullstack-quality-review`, `design-system-enforcement`.
