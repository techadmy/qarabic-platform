---
name: ui-ux-audit
description: Audit Qarabic screens (repos/qarabic-platform apps/web) for spacing, typography, visual hierarchy, accessibility (WCAG 2.2 AA), responsiveness at 375/768/1440, Arabic RTL and English LTR, and the empty/loading/error states. Use when asked to review, audit or check the UI/UX of a page, component or PR, or before marking a screen done against docs/15 §5.18.
---

# UI/UX audit (Qarabic)

Read first: `docs/standards/ui-ux.md`, `docs/standards/design-tokens.md`, and `docs/15-ux-analysis.md` §5 for the full reasons.
Report only; change code only if the user asked for fixes.

## Steps

1. **Scope.** List the routes/components in scope (`apps/web/app/(app)/<area>`, `apps/web/components/...`).
2. **Run it, don't guess.** Build and serve the web app with mocks against local only:
   `pnpm --filter @qarabic/web build && NEXT_PUBLIC_ENABLE_MOCKS=true pnpm --filter @qarabic/web start`
   (or let `pnpm --filter @qarabic/web test:e2e` start it). Mock accounts are in `apps/web/mocks/data.ts`
   and `e2e/helpers.ts`. Never browse `qarabic.com` or `api.qarabic.com` for testing.
3. **Look at it** with the Playwright MCP or the built-in browser at 375, 768 and 1440 px, in Arabic
   (default) and English (top-bar language switch). Take screenshots and actually inspect them.
4. **Check each item**, citing file:line or a screenshot:
   - Hierarchy: one h1 (`PageHeader`), primary action at inline-end, nothing competing with it.
   - Spacing on the 4/8/12/16/24/32/48/64 scale; alignment of labels, inputs, table columns.
   - Typography: Plex Arabic 500 / Inter 400, body 15 px, captions 13 px, no tiny or light text.
   - States: Skeleton loading, `EmptyState`, `ErrorState` with retry, `ForbiddenState`, success toast.
   - Forms: visible labels, inline errors, error summary, server errors mapped to fields.
   - Destructive actions confirmed with reason; reversible ones have undo (D31).
   - A11y: run `expectNoSeriousA11yViolations` (axe) or the axe check in the MCP; keyboard-only pass
     (Tab order, visible focus, Escape closes dialogs, menus work with arrows in both directions);
     icon-only buttons labelled; status not by colour alone; targets ≥ 24 px.
   - RTL/LTR: logical classes only, icons mirrored, `<bdi>` around numbers/latin names, sheets and
     sidebar on the correct side, no horizontal scroll.
   - Copy: فصحى and glossary terms (`15` §9); times show viewer zone + labelled other zone (D30).
5. **Report** a table: severity (P0–P3 per `docs/25` §3) · where · problem · fix. Lead with what
   blocks real users. Separate "verified in browser" from "read in code".
