---
name: design-system-enforcement
description: Detect design-system drift in the Qarabic web app (repos/qarabic-platform) — raw colours or Tailwind palette classes instead of tokens, off-scale spacing, arbitrary sizes, physical (non-RTL) CSS, custom components that duplicate shadcn/ui or existing app components — and point to the token or component to use. Use when reviewing UI code for consistency, before adding a new component or style, or when asked to clean up repeated styling.
---

# Design-system enforcement (Qarabic)

Tokens and scales: `docs/standards/design-tokens.md` (source: `packages/ui/src/styles/globals.css`).
UI rule from CLAUDE.md: shadcn/ui only, no invented layouts, no visual redesign unless Ahmed asks —
consistency fixes must look the same before and after.

## Scan (run from repos/qarabic-platform)

```bash
# raw palette classes / hex colours in app code
grep -rnE "(bg|text|border|ring|fill|stroke)-(red|green|blue|amber|yellow|emerald|orange|sky|slate|gray|zinc|rose|violet|indigo|teal|cyan|purple|pink)-[0-9]{2,3}|#[0-9a-fA-F]{3,8}\b" apps/web/app apps/web/components --include='*.tsx'
# physical direction utilities (must be logical for RTL)
grep -rnE "\b-?(ml|mr|pl|pr|left|right)-[0-9]|text-(left|right)\b|border-(l|r)(-|\b)|rounded-(l|r|tl|tr|bl|br)-" apps/web packages/ui/src --include='*.tsx' --exclude-dir=node_modules
# arbitrary values
grep -rnoE "\[[0-9.]+(px|rem)\]" apps/web/app apps/web/components --include='*.tsx' | sort | uniq -c | sort -rn
# repeated long class strings (copy-paste UI)
grep -rhoE 'className="[^"]{60,}"' apps/web --include='*.tsx' | sort | uniq -c | sort -rn | awk '$1>1'
```

## Judge each hit

- Colour with an existing token → replace (`bg-warning`, `text-muted-foreground`, `Alert variant="warning"`).
- Colour without a token, used in 2+ places → propose a token (light + dark, comment) in
  `globals.css` and a variant on the shadcn component; same rendered colour.
- Known, documented exceptions: class-status colours in `status-badge.tsx`, `sessions/badges.tsx`,
  `today/board-tiles.tsx` (pending `--status-*` tokens); 13/15 px arbitrary font sizes (pending a
  `cn` merge config). Don't churn them piecemeal.
- Spacing off the 4-px scale (`gap-5`, `p-7`, `mt-[18px]`) → nearest scale step, only if visually
  equivalent; otherwise report.
- A new component that re-implements a shadcn primitive (custom modal, dropdown, tabs, table) →
  replace with the shadcn component (`pnpm dlx shadcn@latest add <name>` inside `packages/ui`, which
  applies the RTL transform).

Report: hit · token/component to use · safe to auto-fix (yes/no). Apply only safe ones when asked,
then run `pnpm format:check && pnpm lint && pnpm typecheck` and the web e2e.
