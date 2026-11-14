# UI/UX rules (short form)

Full text and reasons: `15-ux-analysis.md` §5; this is the checklist reviewers use. Every screen PR
ticks `15` §5.18.

1. **shadcn/ui only.** Start from official components/blocks (`packages/ui/src/components`). No
   invented layouts, gradients, glows, emoji or decorative cards. Design changes only when Ahmed asks.
2. **Hierarchy.** One `h1` per page via `PageHeader`; primary action top inline-end; secondary actions
   in a menu. Keep what staff know (status tiles, header counters, inline row shortcuts, profile as
   workbench — `15` §3.1).
3. **Tables and lists.** `DataTable` + `ListToolbar` (search, filters, pagination per `15` §5.4.1).
   Columns `text-start`, numbers with `<bdi>`, sticky header on long lists, row actions inline.
   Cards instead of tables only below `md`.
   **D141 list patterns** (`15` §5.4.2; reference: Leads): > 5 statuses → `ViewsMenu` in the title,
   else `StatusTabs`; `DataTable` column chooser (`useColumnVisibility`); header actions via
   `ListActions` (primary/split «جديد» + «⋯», never more than two); summary tiles in
   `CollapsibleSummary` (not Today); rows open in `SplitView` from 1024 px (`useSplitView`), record
   views reused unchanged (`PageHeader` turns h2 + «إغلاق» in the pane).
4. **States.** Every data view has loading (Skeleton), empty (`EmptyState`), error (`ErrorState` with
   retry) and no-access states from `components/states.tsx`. Success = toast (sonner); failure keeps
   the user's input.
5. **Forms.** react-hook-form + zod schema from `@qarabic/shared`; every control has a visible label
   (`Field`/`FieldLabel`), errors under the field and in an `aria-live` summary on submit; server
   errors mapped to fields.
6. **Destructive actions.** Confirm dialog (`AlertDialog`) with a reason when the record matters;
   undo toast for reversible changes (D31). No state change from a GET link.
7. **Accessibility (WCAG 2.2 AA).** Contrast ≥ 4.5:1 text, 3:1 UI; visible focus; full keyboard use;
   targets ≥ 24 px; icons-only buttons have `aria-label`; status not by colour alone; axe has no
   serious/critical violations (E2E helper `expectNoSeriousA11yViolations`).
8. **RTL/LTR.** Arabic default (`dir="rtl"`), English optional. Logical utilities only (`ms/me`,
   `ps/pe`, `start/end`, `text-start`); physical Radix `side` chosen from the direction; directional
   icons `rtl:rotate-180`; mixed text in `<bdi>`. See `apps/web/RTL.md`.
9. **Copy.** Arabic UI text is فصحى with the glossary in `15` §9; English is plain. No colloquial
   Egyptian in the product.
10. **Times.** Viewer's zone first + the other party's labelled time (D30).
11. **Responsive.** No horizontal page scroll at 375, 768, 1440; the sidebar becomes a sheet on
    phones; tables scroll inside their own container if they must.
12. **Dashboards.** Counters first, then the list; filters remembered in the URL; pagination
    server-side; clear primary action per row.
