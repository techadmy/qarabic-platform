# RTL spike (N0)

Arabic is the default language (`<html lang="ar" dir="rtl">`), English is optional (`dir="ltr"`).
This note records how shadcn/ui behaves in RTL in this app. Re-check it whenever a new shadcn
component is added: render it on `/dev/components` (development only; production builds answer 404,
covered by an E2E test) in Arabic and in English.

## Setup (shadcn's official RTL guidance)

Source: ui.shadcn.com/docs/rtl and /docs/rtl/next (checked 2026-11-11, shadcn CLI 4.23).

- The project was scaffolded with `shadcn create --template next --base radix --preset nova --monorepo --rtl`
  and moved into this repo. Both `components.json` files have `"rtl": true`, so the CLI rewrites every
  component it adds: physical classes become logical ones (`ml-*`/`mr-*` → `ms-*`/`me-*`, `pl/pr` →
  `ps/pe`, `left/right` → `start/end`, `text-left` → `text-start`), directional icons get
  `rtl:rotate-180`, and slide animations use logical directions where tw-animate-css supports them.
- `DirectionProvider` (`shadcn add direction`, Radix `Direction.Provider`) wraps the app with the
  locale's direction (`components/providers.tsx`), so Radix primitives (menus, sub-menus, collapsible,
  tooltip) place and key-navigate correctly. Arrow keys in menus follow the reading direction.
- `<html lang dir>` is set in `app/layout.tsx` from the locale cookie (next-intl without locale
  routing). The language switch saves the cookie with a server action, sets `lang`/`dir` on the
  document at once, then `router.refresh()`es so server text re-renders.
- Fonts: IBM Plex Sans Arabic (400/500/600/700) + Inter via `next/font/google`
  (`--font-arabic`, `--font-latin`). `--font-sans` puts Plex first under `:lang(ar)` and Inter first
  otherwise. Arabic body text is weight 500 with line-height 1.6 (D66: Plex Arabic looks thin at 400);
  Latin body text is 400 / 1.5.

## What works out of the box

| Component                                                | Result in RTL                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Button, Spinner, Badge, Avatar, Skeleton, Separator      | Fine. Icons inside buttons sit at the inline start.                                                                         |
| Card, Field (label, description, error), Input, Checkbox | Fine. Labels and errors align to the right; horizontal fields put the checkbox first (right).                               |
| Input Group                                              | Fine. `align="inline-end"` puts the show/hide password button on the left in Arabic, on the right in English.               |
| Alert                                                    | Fine. The icon column is on the right.                                                                                      |
| Breadcrumb                                               | Fine. The separator chevron has `rtl:rotate-180` (points left).                                                             |
| Dropdown Menu (+ Sub, Radio)                             | Fine with `DirectionProvider`: the sub-menu opens to the left, its chevron is rotated, check marks sit at the inline start. |
| Collapsible, Tooltip, Empty, Table                       | Fine. Table headers and cells use `text-start`.                                                                             |
| Sheet                                                    | Fine when `side` is chosen per direction (see below).                                                                       |

## What needed a fix or a decision

1. **Sidebar side.** `Sidebar` takes a physical `side` (`left`/`right`). shadcn's sidebar RTL notes
   say to pass `dir` and `side="right"`. `AppSidebar` passes `dir={dir}` and
   `side={dir === 'rtl' ? 'right' : 'left'}`; on mobile the same `side` makes the sheet slide in from
   the right in Arabic.
2. **Physical `side` props in our own code.** Radix `side` values are physical. Where a block
   hard-codes one, we pick it from the direction:
   - `nav-user` dropdown: block uses `side="right"` → `dir === 'rtl' ? 'left' : 'right'` (desktop).
   - Sidebar menu tooltips (icon-collapsed mode): `SidebarMenuButton` defaults to `side="right"`;
     we pass `tooltip={{ children, side }}` with `left` in RTL. No component change needed.
   - Sheets that should open at the inline end: `side={dir === 'rtl' ? 'left' : 'right'}`.
3. **Block page files are not transformed.** `shadcn add sidebar-07` writes the block's components
   but not its `page.tsx` in a monorepo app, so the page markup we copied still had `-ml-1` and
   `mr-2`. We use `-ms-1` and `me-2` in `components/shell/app-shell.tsx`.
4. **`dir` on portal content.** shadcn suggests `dir` on `PopoverContent`/`TooltipContent` because of a
   tw-animate-css issue with logical slide utilities. The radix-nova Dropdown Menu content does not
   accept `dir` (TypeScript), and with `DirectionProvider` it is not needed: its slide classes are
   physical per `data-side`, which is correct in both directions. `TooltipContent`/`SheetContent`
   accept `dir` and we pass it.
5. **Mobile sidebar sheet title.** The generated `Sidebar` had a hard-coded English screen-reader
   title ("Sidebar" / "Displays the mobile sidebar."). We added optional `mobileTitle` and
   `mobileDescription` props (English defaults kept) so the sheet is announced in Arabic
   («القائمة الجانبية»). This is the only change to a generated component.
6. **Mobile sheet stays open after navigation.** Not RTL-specific: nav links call
   `setOpenMobile(false)` on mobile, as shadcn's sidebar docs suggest.
7. **CLI placed `use-mobile` in the app.** In this monorepo the CLI wrote `hooks/use-mobile.ts` to
   `apps/web` while `sidebar.tsx` imports `@qarabic/ui/hooks/use-mobile`; moved to `packages/ui`.
8. **Mixed text.** Email and password inputs are `dir="ltr"`; emails shown in Arabic UI are wrapped in
   `<bdi>` inside a `dir="ltr"` span (docs/15 §5.11).

## Logical properties in our own code

`ms-auto`, `-ms-1`, `me-2`, `start-2` (skip link), `text-start`, `ps-*`/`pe-*` via components,
`align="inline-end"` on Input Group. No `left`/`right`/`ml`/`mr`/`pl`/`pr`/`text-left`/`text-right`
classes are used in `apps/web` (only Radix's physical `side` prop, chosen per direction).

## Open points

- Numbers use Latin digits (D25) in both languages; next-intl plural rules use Arabic forms
  (zero/one/two/few/many/other).
- Charts (Recharts) and Calendar/Pagination are not used yet. shadcn lists Calendar, Pagination and
  Sidebar as needing manual RTL work: check them on `/dev/components` when they are added.
