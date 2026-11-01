# UI consistency

Rules for the admin console, portal, public pass page, SSR auth pages and emails. Tokens come from
`@polaris-key/brand` plus the teal accent in `src/web/styles/wallet.css`. Reference data:
`node tools/seed-demo.ts`. A rule here beats a one-off in a page; change the kit, not the page.

## Tokens

| Role | Token / utility | Use |
| --- | --- | --- |
| Page | `surface-page` | App background, SSR pages, public page |
| Raised | `surface-raised` | Cards, sidebar, portal header, table header |
| Sunken | `surface-sunken` | Input wells only |
| Overlay | `surface-overlay` | Dialogs, menus, save bar |
| Lines | `border` (dividers), `border-strong` (controls) | Never raw greys |
| Text | `fg-strong` titles, `fg` body, `fg-muted` labels/meta, `fg-subtle` placeholders | |
| Accent | `accent` (#2dd4bf dark, #0f766e light) | One primary action per view, links, selection |
| States | `success`, `warning`, `danger`, `info` + `-subtle`/`-border` | Pills, banners, field errors |

No hex values in components. Exceptions: pass art (pass.json colours) and email inline styles,
which copy the token values.

## Spacing

4px base. Allowed steps: 1, 2, 3, 4, 6, 8 (4–32px).

| Gap | Value |
| --- | --- |
| Controls in a row, pills, button groups | 2 (8px) |
| Fields in a form | 4 (16px) |
| Card padding | header `px-4 py-3`, body `p-4` |
| Between cards / sections | 6 (24px) |
| Page header to content | 6 (24px) |
| Main gutters | `px-4` (<640), `px-6` (≥640); `py-6` |

## Control heights

| Size | Height | Use |
| --- | --- | --- |
| `sm` | 32 (`h-8`, icon `size-8`) | Card-header actions, table row actions, inline secondary actions |
| `md` | 36 (`h-9`, icon `size-9`) | Default: inputs, selects, combobox, search, date, page actions, toolbars, dialogs |
| `lg` | 40 | Not used in the console. Customer primary CTA only |

- Everything in one row shares one height. Fields are always `md`.
- Top bar: icon buttons are ghost `size-9`; search is a field (`md`, outlined) at ≥640 and a ghost
  `size-9` icon button below.
- SSR pages and emails use the same 36px controls and 6px radius.

## Layout

- Admin shell: sidebar 15rem at ≥1024 (sheet below), top bar `h-14` sticky, main `max-w-7xl`.
- Sidebar background and border belong to the grid column, so they span the full page height.

| Page type | Width |
| --- | --- |
| List (table), Settings | Full main width |
| Detail with pass preview (pass, template) | Full; `20rem 1fr` at ≥1280, preview stacked above tabs below |
| Detail or form (org, user, identity, connection tabs, status) | `max-w-3xl` for every block on the page, tabs included |
| Wizard (new pass, new connection, upload) | `max-w-3xl`, left aligned; template/org pickers may use full width |
| Portal | `max-w-4xl` |
| Login and SSR auth pages | `max-w-sm` card, centered |
| Public pass page | `max-w-md`, centered |

No page-level horizontal scroll at any width (`scrollWidth == clientWidth`). Wide content scrolls in
its own container; every grid/flex ancestor gets `min-w-0`.

## Page header

1. Breadcrumbs on detail, new and upload pages only.
2. `h1` `text-2xl font-semibold`. One-line description at most; no paragraphs.
3. Meta row under the title: status pills, then version or connector, `text-sm fg-muted`.
4. Actions right of the title: at most three visible (one primary or the main state change, then
   outline buttons), the rest in a `More` menu. Delete, rotate, download and copy go in `More`.
5. Below 640: actions sit in one row under the title; overflow goes to `More`. Never two rows.
6. `More` is the kit `MoreMenu` (items are `DropdownMenuItem`s). Row-action menus in tables stay
   ghost `IconButton`s.
7. Create actions (page headers and empty states) lead with a Lucide icon: `Plus` for New/Add,
   `Upload` for Upload (`iconStart={<Plus aria-hidden />}`).

## Sections and cards

- Card: `rounded-lg border bg-surface-raised shadow-elevation-1`; title `text-sm font-semibold`.
- Pick one per page: all sections are cards, or all are `h2` (`text-base font-semibold`) with setting
  rows (Settings page only).
- No box in a box: a table inside a card uses the card border (no inner border or radius).
- Key-value lists: label column `w-36 fg-muted`, value `fg`. Mono only for ids, hashes, slugs,
  pointers, JSON.
- Empty value: `—`. Empty list inside a card: one `text-sm fg-muted` line.

## Tables

- Header `h-10`, rows `py-2` (≥44px), `text-sm`; second line `text-xs fg-muted`.
- Text left; numbers right with `tabular-nums`; pills left; row actions right (ghost `size-8`).
- First column grows; meta columns (template, org, dates) `whitespace-nowrap` and truncate with a
  `title`.
- Dates: one formatter, `Oct 31, 2026, 6:17 PM`. No seconds, no numeric `10/31/2026`.
- Footer: count left (`45 passes`), `Load more` (`sm` outline) right. Same component on every list.
- Below 768: lists render stacked rows (title link, secondary line, pills, one key meta value). Wide
  record tables (runs, audit, sessions, delivery) scroll inside their container with an edge fade.
- Sticky header only when the table has its own `max-h`; otherwise none.

## Filters

- One toolbar row above the table: search (`w-64` at ≥640), then selects (`w-44`) labelled
  `Org: all`, then `Clear` as a ghost `sm` button in the same row.
- Below 640: search full width, selects in a two-column grid filling each cell, `Clear` last.
- More than four filters: extra ones go in a `Filters` popover. No labelled filter forms (audit).

## Forms

- Label above the control (`text-sm font-medium`), required `*` in `danger`, help `text-xs fg-muted`
  below, error `text-xs danger` replaces help and sets the danger border.
- Fields fill their card (`max-w-3xl` page). Two columns only at ≥768 for short related fields.
  Fixed widths only for number + unit (`w-28`) and colour (swatch + `w-40` hex).
- Booleans: `SwitchRow` (kit) for persisted settings: label and help left, switch right. `Checkbox` for
  options inside a form or dialog (label right). One kind per form.
- Date-time: date-time input `min-w-56`; timezone select beside it at ≥768, below it otherwise.
  The clear checkbox reads `No date` (or `Never expires` for expiry) everywhere.
- Page forms save through `SaveBar` (fixed bottom, offset by the sidebar at ≥1024, Discard outline +
  Save primary). Dialog forms use footer buttons. No inline Save buttons on pages.
- Wizards: numbered steps (the order is real), Back outline + Next primary, bottom left. A step change
  scrolls to top and focuses the step heading.

## Status pills

Icon + Title Case text, always from `src/web/lib/status.ts`. Never render a raw enum.

| Tone | Meaning | Examples |
| --- | --- | --- |
| success | Working as intended | Active, Verified, Healthy, Sent, Complete |
| warning | Needs attention soon | Degraded, Expiring, Partial |
| danger | Broken | Failing, Failed, Errored |
| info | Neutral fact worth noticing | Configured, Owned |
| accent | Selection or primary | Primary, This device, Default, Showing |
| neutral | Inactive or not started | Voided, Unassigned, Waiting, Revoked, Disabled, Unknown, Off |

- On/off values render as text (`On`/`Off`), not pills.
- Error codes: show the sentence from the code map; the code may follow in `font-mono text-xs fg-muted`.
- Audit and activity actions show labels (`Signed in`, `Pass created`), not `auth.sign_in`.

## Empty, loading, error

- `EmptyState`: dashed box, pass-stack art (three fanned blank passes, the icon on top), title
  `text-sm font-medium`, one action. Filtered lists: `No passes match` + `Clear filters`.
- Loading: `Skeleton` in the final layout's shape; it appears after 150 ms. `Spinner` only in buttons
  and polling rows.
- Error: `ErrorState` with one sentence (what happened, what to do) and Retry.

## Tabbed detail pages

- The active tab lives in the URL as `?tab=<id>` (`passDetailSearchSchema` in
  `admin/passes/search.ts`, `validateSearch` in `routes/admin/passes/$passId.tsx`).
- Changing tab replaces history. An invalid or missing tab falls back to the default.

## Dialogs and drawers

- Sizes: `sm` (384) confirms, `md` (512) forms, `lg` (768) uploads and editors.
- Header title (+ optional one-line description), X close except on alert dialogs; footer right:
  Cancel outline, then the action (primary, or danger with the verb: `Void`, `Delete`).
- Focus returns to the opener on close (use `DialogTrigger` or `onCloseAutoFocus`). Opened from a
  menu item, it returns to the menu trigger.
- Sheets: left for navigation, right for record detail (`w-96` at ≥640, full width minus 16px below).

## Typography

| Role | Class |
| --- | --- |
| Page title | `text-2xl font-semibold tracking-[-0.015em]`; customer pages `sm:text-3xl` (`size="lg"`) |
| Section heading (no card) | `text-base font-semibold` |
| Card / dialog title | `text-sm font-semibold` (dialog `text-base`) |
| Body, table cells, labels | `text-sm` |
| Meta, help, secondary lines | `text-xs fg-muted` |
| Stat value | `CountUp`, `text-3xl font-semibold tabular-nums`; counts to its value |
| Code, ids, hashes, JSON | `font-mono text-xs` |

Brand sans everywhere, including SSR pages (served font, system fallback). Emails use the system
stack.

## Icons, focus, motion

- Lucide, `size-4` in buttons, nav and menus; `size-3.5` in pills; `size-5` in empty-state art.
  Icon-only buttons use `IconButton` (label + tooltip). Destructive buttons carry `Trash2`.
- Focus: 2px `--pk-focus` outline, offset 2 (buttons), 1 (fields). Shown for keyboard focus only;
  tabs must not show it after a click. Route changes focus the `h1`. After a mouse or touch
  interaction (`html[data-modality=pointer]`) buttons and controls show no ring, including in
  dialogs and on the restored opener; the next key press brings it back. Text fields keep theirs.
- Motion: follow [motion-and-expression.md](motion-and-expression.md). Chrome moves in 80–260 ms with
  ease-out; passes in 480–640 ms on a spring. Route changes move main only (fade with an 8 px rise, or
  a 16 px slide by path depth); search-param changes (`?tab=`, filters) never animate. Lists animate
  once, after their skeleton, 30 ms apart, capped at six. Overlays open from their trigger in 200 ms
  and fade out in 120 ms; sheets slide in 260 ms; nav and tab indicators slide. Only transform and
  opacity animate. `prefers-reduced-motion` turns all of it off (`base.css`, `motion.css`,
  `kit-motion.css`).

## Passes and expression

- Every pass renders through `PassCardStage`: glow in the pass colour, tilt and highlight on fine
  pointers, 3D flip between faces, deal in on arrival, mint on change. Thumbnails are `still`. The
  pass art is never restyled.
- Teal is the only interactive accent. The foil gradient is reserved for the mint sweep, empty-state
  art, and the sign-in card and email top edge.
- Dark raised surfaces get a 1 px lit top edge (`--wl-edge`); the primary button glows on hover and
  keyboard focus.

## Light and dark

- Both themes from the same tokens; dark is the default. Check every page in both.
- Warning and info subtle fills must read as tinted, not grey, in light (≥3:1 border contrast).
- Pass art ignores the theme. SSR pages and emails follow `prefers-color-scheme` with token values
  (`<meta name="color-scheme" content="light dark">`).

## Breakpoints

| Width | Rules |
| --- | --- |
| <640 (phone, 390) | Sheet nav; top bar ghost icons + compact org filter; actions one row + `More`; stacked list rows; filter grid; dialogs `w-[calc(100%-2rem)]` |
| 640–1023 (tablet portrait, 768) | Sheet nav; search field `w-64`; tables show title + 2–3 key columns; two-column forms allowed |
| 1024–1279 (tablet landscape) | Sidebar visible; pass/template detail stacks preview above tabs; tables hide low-value columns (styles, version hash) |
| ≥1280 | Full layouts |

## Customer side

- Portal: wordmark at every width; pass tiles in a grid with equal row heights; one action row per
  tile: `Add to Apple Wallet` (primary), `Refresh` (outline), `More` (Show QR, Remove).
- Portal details: format values by the pass field's date/number style; never ISO strings. Labels in
  sentence case.
- Sign-in, magic-link confirm, link expired, no access, break-glass: one "hosted" shell shared by
  `/login` and the worker pages. See "Sign-in pages (owner reference)" below.

## Sign-in pages (owner reference)

The owner's model is Polaris Key's hosted sign-in: `docs/design/references/polaris-sign-in.png`.
Source: `../polaris-key/docs/design/mockups/screens/identity/identity.{sign-in,device-code,device-code-states}.html`
and the `.hosted*` rules in `../polaris-key/docs/design/mockups/kit/mockup.css` (search `.hosted {`).
Same brand tokens; Wallet keeps its own wordmark and teal.

| Part | Rule |
| --- | --- |
| Brand | Wordmark (mark + "Wallet") centred above the card, not inside it |
| Card | One raised card, large radius, generous padding; body, then a footer split off by a divider |
| Title | `h1` names the task ("Sign in", "Enter the code from your email"); at most one short lede |
| Fields | Label above; full-width input. A sign-in code is a large mono field, centred and letter-spaced, grouped like `WDJB-MJHT` |
| Errors | Danger border plus icon and one sentence: what happened and what to do |
| Trust | At most one `hosted-note` (shield icon, muted) before the action where it prevents a mistake (e.g. "Only use a code from your own email") |
| Action | Full-width primary with a trailing arrow ("Continue →"); alternatives below an "or" divider (e.g. "Continue with Polaris ID", outline) |
| Footer | Lock icon plus one line on what signing in does |
| Below | `Help · Privacy` links, centred |
| Motion | Owner request R5: the login gets its own cute animation, layered on this structure, reduced-motion safe |

The trust and footer lines are the only explanatory text allowed on these pages: one line each.
- Public pass page: wordmark (or org name) header, pass centered (deals in, flips with a no-script
  `Show back` toggle, tilts on fine pointers through `/pass-tilt.js`), Add to Apple Wallet badge and
  QR centered under it, voided banner in `warning`.
- Emails: fluid container `width:100%; max-width:480px`; 3px foil line (teal fallback) over the org
  header bar (org accent, else slate);
  one title line (`Sign in to Wallet`, `Your pass is ready`); one primary action; footer note
  `12px`. Sign-in and pass emails share the layout. Nothing wider than 320px.
