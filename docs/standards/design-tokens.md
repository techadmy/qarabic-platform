# Design tokens

Single source: `repos/qarabic-platform/packages/ui/src/styles/globals.css` (Tailwind v4 `@theme inline`

- shadcn CSS variables, light `:root` and `.dark`). The identity is the current staff app's
  (`15` §8.2): brand maroon, warm-grey canvas, white surfaces, warm hairlines, blue focus ring.
  **Never** hard-code a hex/oklch value or a raw Tailwind palette class (`bg-amber-50`) in app code
  when a token exists; add a token instead (both themes, with a comment saying what it is for).

## Colour

| Token (utility)                                                                      | Use                                                       |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `background` / `foreground`                                                          | Page canvas / main text                                   |
| `card`, `popover` (+ `-foreground`)                                                  | Surfaces                                                  |
| `subtle`                                                                             | Table header fill, row and nav hover                      |
| `ink-2`, `muted-foreground`                                                          | Secondary text (≥ 7:1 on white)                           |
| `primary` (+ `-foreground`)                                                          | Brand actions, links, active states                       |
| `secondary`, `muted`, `accent`                                                       | Quiet buttons, fills, active nav item (brand-soft)        |
| `destructive`                                                                        | Errors, destructive actions                               |
| `warning`, `warning-foreground`, `warning-border`, `warning-hover`, `warning-active` | Needs-attention surfaces. Use `<Alert variant="warning">` |
| `border`, `input`, `ring`                                                            | Hairlines, inputs, focus ring (blue)                      |
| `sidebar-*`                                                                          | App sidebar                                               |
| `chart-1..5`                                                                         | Charts (neutral until a chart palette is decided)         |
| `status-<tone>` (+ `-foreground`, `-border`, `-emphasis`)                            | Status chips and numbers (below)                          |
| `rating`, `rating-border`                                                            | Rating stars                                              |

### Status tones (`--status-<tone>`)

Every status chip and status number uses one of ten tones, never a raw palette class. Each tone has
four utilities: `bg-status-<tone>` (chip fill), `text-status-<tone>-foreground` (chip text),
`border-status-<tone>-border` (chip border), `text-status-<tone>-emphasis` (a coloured number or icon
on a card: Today tiles, counters, "joined" ticks, overdue dates). Values are the old system's hues
(Tailwind palette steps, named in `globals.css`), light and dark; `apps/web/test/status-tokens.test.ts`
fails if chip text on its fill or an emphasis colour on the card/canvas drops below 4.5:1.

| Tone     | Hue             | Used for                                      |
| -------- | --------------- | --------------------------------------------- |
| `green`  | emerald         | taken, regular/active, approved, extra        |
| `amber`  | amber           | running, pending, needs entry                 |
| `orange` | orange          | ended without report, late, follow-ups        |
| `red`    | red             | absent, suspended (people), rejected, overdue |
| `rose`   | rose            | suspended class, paused enrolment             |
| `violet` | violet          | leave                                         |
| `sky`    | sky             | trial (people), declined, DST note            |
| `brown`  | amber-on-orange | trial class                                   |
| `indigo` | indigo          | advance                                       |
| `teal`   | teal            | rescheduled, internal notes                   |

Use the components, not the classes, where one exists: `StatusBadge` (people), `ToneBadge` /
`TONES` and the `*Badge` helpers in `components/sessions/badges.tsx` (classes, requests, billing,
payroll). Grey/neutral chips stay on `muted` / `muted-foreground`. Rating stars use `fill-rating
text-rating-border`.

## Spacing (Tailwind units, base 4 px)

Use only: `1` (4) · `2` (8) · `3` (12) · `4` (16) · `6` (24) · `8` (32) · `12` (48) · `16` (64).
`0.5`/`1.5`/`2.5` are allowed only inside shadcn component internals. Gaps between form fields: `4`
(compact) or `6`; page sections: `6` or `8`; page padding: `4` on phones, `6` from `md`.

## Typography

Fonts: IBM Plex Sans Arabic + Inter (`next/font`, `--font-arabic`, `--font-latin`). Arabic body weight
500, line-height 1.6; Latin 400 / 1.5 (D66). Body 15 px: `text-body` (`--text-body`, also the `body`
default); captions, field hints and table headers 13 px: `text-caption` (`--text-caption`). Both set
the size only and inherit the line height. Never write `text-[0.8125rem]`/`text-[0.9375rem]`.
Headings: page title `text-xl font-semibold` (h1, one per page), section `text-base font-semibold`.
`cn` (`@qarabic/ui/lib/utils`) is `createCn` taught these names, so `text-caption text-muted-foreground`
keeps both classes; a new `--text-*` token must be added there too (`apps/web/test/cn.test.ts`).
Components in `packages/ui` import `cn` from `@qarabic/ui/lib/utils`, never from the `cn` package.

## Radii, shadows, sizes, breakpoints

- Radius base `--radius` 7 px (controls); cards `rounded-xl` (~10 px). Don't use other radii.
- Shadows: none on cards (hairline border instead); `shadow-xs`/`shadow-sm` only for floating UI
  (menus, popovers come with their own).
- Control heights: `h-10` inputs/selects/default buttons in forms, `h-11` primary auth buttons,
  `h-9` toolbar buttons, `h-8` compact table actions, badges `h-6`. Touch targets ≥ 24 px (WCAG 2.5.8),
  ≥ 40 px for primary mobile actions.
- Breakpoints: Tailwind defaults `sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536. Test at 375,
  768 and 1440.

## States

Hover: `subtle` or `accent` fills. Focus: `focus-visible:ring-[3px] ring-ring/50` from shadcn (never
remove an outline without a replacement). Disabled: `opacity-50` + `pointer-events-none` (shadcn).
Selected/pressed: `data-[state=on]` / `aria-pressed` styles, not colour alone (add underline or icon).
