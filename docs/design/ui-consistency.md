# UI consistency

Rules for the admin console, portal, public pass page, SSR auth pages and emails. Tokens come from
`@polaris-key/brand` plus the Wallet overrides in `src/web/styles/wallet.css`. Reference data:
`node tools/seed-demo.ts`. A rule here beats a one-off in a page; change the kit, not the page.
Behaviour and Apple rules: [ux-principles.md](ux-principles.md). Motion:
[motion-and-expression.md](motion-and-expression.md).

## Tokens

| Role | Token / utility | Use |
| --- | --- | --- |
| Page | `surface-page` | App background, SSR pages, public page |
| Raised | `surface-raised` | Cards, sidebar, portal header, table header; editable fields in light |
| Sunken | `surface-sunken` | Read-only values, code, disabled fields, art slots. Never an editable field in light |
| Overlay | `surface-overlay` | Dialogs, menus, sheets, save and wizard bars |
| Lines | `border` (dividers), `border-strong` (controls, art strokes) | Never raw greys |
| Text | `fg-strong` titles, `fg` body and values, `fg-muted` labels and meta, `fg-subtle` placeholders | Dark `fg-muted` ≈ #8f98ad: 4.5–7:1 on raised, so labels separate from values |
| Accent | `accent` (#2dd4bf dark, #0f766e light) | Selection and the one primary action per view. Never origin, role or health |
| States | `success`, `warning`, `danger`, `info` + `-subtle`/`-border` | `success` only for healthy or working; `info` is blue (not Polaris violet, not foil) |

- No hex values in components. Exceptions: pass art (pass.json colours) and email inline styles,
  which copy the token values.
- Fields: white (`surface-raised`) in light with `border-strong`; hover darkens the border.
- Neutral pills: a hover tint over raised, lighter than the card in dark. Light `success-subtle`
  reads green (hue 120–160, saturation ≥25 %). Every subtle fill reads tinted, border ≥3:1.

## Spacing

4px base. Allowed steps: 1, 2, 3, 4, 6, 8 (4–32px).

| Gap | Value |
| --- | --- |
| Label to control | 2 (8px) |
| Control to help or error | 1 (4px) |
| Controls in a row, pills, button groups | 2 (8px) |
| Fields in a form | 4 (16px) |
| Card padding | header `px-4 py-3`, body `p-4` |
| List rows | `py-3`, first `pt-0`, last `pb-0`, dividers between |
| Group heading in a form | 6 (24px) above, hairline |
| Between cards / sections | 6 (24px) |
| Page header to content | 6 (24px) |
| Main gutters | `max(1rem, safe area)` (<640), `px-6` (≥640); `py-6` |

No margin hacks (`mt-[…]`) to align controls; use the kit patterns below.

## Control heights

| Size | Fine pointer | Coarse pointer (touch) | Use |
| --- | --- | --- | --- |
| `sm` | 32 (`h-8`) | 32 visual, 44 × 44 hit area | Card-header actions, row actions, inline secondary actions |
| `md` | 36 (`h-9`) | 44 (`h-11`) | Default: inputs, selects, combobox, search, page actions, toolbars, dialogs |
| `lg` | 44 (`h-11`) | 44 | Customer primary actions (portal, login, SSR pages) |

- Everything in one row shares one height. Fields are always `md`.
- Under `pointer: coarse`: tabs, menu items, nav links and icon buttons are at least 44 px; inline
  text links get padding to a 44 px hit height.
- Text inputs, selects and textareas are 16 px on customer pages and under `pointer: coarse` (iOS
  zooms below that); 14 px in the console on fine pointers. Never `maximum-scale`.
- Buttons use `min-height`, so a label can wrap to two lines at large text sizes.
- Top bar: ghost icon buttons; search is a field at ≥640 and an icon button below. The shortcut
  hint reads `⌘K` on Apple platforms, `Ctrl K` elsewhere, and hides when the only pointer is coarse.
- SSR pages and emails: 44 px buttons and inputs, 6px radius.

## Layout

- Admin shell: sidebar 15rem at ≥1024 (sheet below), top bar `h-14` sticky, main `max-w-7xl`.
- Sidebar background and border belong to the grid column, so they span the full page height.
- **Every admin page uses the full main width.** Width is capped per block (form grids, prose,
  dialogs), never per page: no page-level `max-w-*`. Header actions end at the main content's
  right edge on every page.

| Page | Layout |
| --- | --- |
| List, Settings | Full main width |
| Detail with pass preview (pass, template) | ≥1024: preview column + tabs (16rem to 1279, 20rem from 1280). 640–1023: horizontal summary card (pass 180px, holder, quick actions; the header carries status and version) above the tabs. <640: compact row (64px still, title, `Show pass` opens the stage in a bottom sheet) |
| Detail (org, user, identity, connection, status) | `TwoPane`: main column + 20rem aside at ≥1280 (summary, counts, danger actions); stacked below |
| Wizard (new pass, new connection) | Full width, Stepper on top, same width on every step; aside (live preview or summary) at ≥1024; `WizardBar` sticky at the bottom |
| Upload template | Full width; drop zone and fields left, checklist and report right at ≥1024 |
| Dialogs | `sm` 384 confirms, `md` 512 forms, `lg` 768 uploads and editors; bottom sheets <640 |
| Portal | `max-w-5xl`; My passes 1 / 2 / 3 columns (<640 / ≥640 / ≥1024); pass detail two columns at ≥1024; account cards cap at 48rem |
| Login and SSR auth pages | `max-w-sm` card, centred |
| Public pass page | `max-w-md` column; two columns at ≥1024 (pass, then identity, badge, QR, Details) |

- `FormGrid` (container query on its own width): 1 column; 2 at ≥40rem; 3 short fields at
  ≥64rem. Long fields (textarea, URL, JSON, lists) span all columns. With an aside the grid drops
  to one column by itself.
- Prose, help and descriptions: at most 65ch.
- No page-level horizontal scroll at any width (`scrollWidth == clientWidth`). Wide content
  scrolls in its own container; every grid and flex ancestor gets `min-w-0`.
- Reflow at 200 % zoom on a 390 pt phone (195 CSS px): no horizontal scroll, key-value pairs
  stack, card-header actions wrap below the title, the pass stage scales to its container.
- Safe areas: `viewport-fit=cover` is set, so the top bar, main gutters, sheets, toasts, save and
  wizard bars and bottom sheets pad with `env(safe-area-inset-*)` (kit `px-safe`, `pb-safe`).

## Page header

1. Breadcrumbs on detail, new and upload pages only.
2. `h1` `text-2xl font-semibold`. One-line description at most; no paragraphs. Users and orgs show
   a 40px `EntityAvatar` left of the `h1`.
3. Meta row under the title: status pills, then version or connector, `text-sm fg-muted`. Links
   such as `Audit log` sit here, not as header buttons.
4. Actions right of the title: at most three visible (one primary or the main state change, then
   outline buttons), the rest in `More`. Delete, rotate, download and copy go in `More`. If `More`
   would hold one item, show it as a button.
5. Below 640: actions sit in one row under the title; overflow goes to `More`. Never two rows.
6. `More` is the kit `MoreMenu`; row-action menus are ghost `IconButton`s. Every menu item has an
   icon; destructive items come last, in `danger`.
7. Create actions lead with a Lucide icon: `Plus` for New/Add, `Upload` for Upload.

## Sections and cards

- Card: `rounded-lg border bg-surface-raised shadow-elevation-1`; title `text-sm font-semibold`.
  Card-header actions are ghost `sm` buttons with a trailing `ChevronRight` (internal) or
  `ArrowUpRight` (external); no underlined links.
- Pick one per page: all sections are cards, or all are `h2` (`text-base font-semibold`) with setting
  rows (Settings page only).
- No box in a box: a table or empty state inside a card uses the card border.
- Key-value lists: label `fg-muted` (normal weight), value `fg`; the label stacks over the value
  when the container is under 22rem. Mono only for ids, hashes, slugs, pointers, JSON.
- Empty value: `—`.

### Rows and inline adds (R2, R3)

One kit `ListRow` for every row list (emails, sessions, devices, image overrides, mappings,
health items):

| Part | Rule |
| --- | --- |
| Row | `flex items-center gap-3 min-h-11 py-3`, first `pt-0`, last `pb-0`, inset dividers |
| Leading | 16px icon or 24px `EntityAvatar`, `shrink-0` |
| Body | `min-w-0 flex-1`; title `text-sm fg-strong` truncates while its pills stay visible (`shrink-0`); in a list under 24rem a pill that does not fit drops under the title; meta `text-xs fg-muted` below, wrapping up to three lines |
| Trailing | `ml-auto shrink-0`, right-aligned, vertically centred, never wraps. Holds a pill or the actions |

- Row actions: one safe action is a ghost `sm` button with an icon; one destructive action is a
  ghost `Trash2` icon button; two or more go in a ghost `…` menu.
- Sessions (`SessionList`, portal and admin): leading device icon, title from the user agent
  (`Chrome on macOS`), meta `Last active … · Signed in …`. Trailing: the `This device` pill, or
  `Revoke` (ghost, `LogOut`). The pill sits exactly where `Revoke` sits on other rows.
- Emails (`EmailList`, portal and admin): title is the address plus `Primary` / `Unverified`
  pills; trailing actions. The add row is the list's last row, with the same divider and `py-3`.
  An empty list is one muted line, then the add row.
- `InlineAddField`: label above; input and button in one row (`grid-cols-[minmax(0,1fr)_auto]`),
  both the same height; help or error below the input only, so the button never moves.

## Tables

- Header `h-10`, rows `py-2` (≥44px), `text-sm`, one line per cell; second line `text-xs fg-muted`.
  Row heights within a table vary by at most 4px.
- Text left; numbers right with `tabular-nums`; pills left; row actions right (ghost `size-8`).
- First column grows; meta columns (template, org, dates) `whitespace-nowrap`, truncate with a
  `title`.
- A state that every row would repeat (holder state) is an icon with a tooltip, not a pill.
- Dates: one formatter, `Oct 31, 2026, 6:17 PM`. No seconds, no numeric `10/31/2026`.
- Footer: `<n> <noun>` left, plus the scope (`19 passes in Northwind`); `Load more` (`sm` outline)
  right. Same component on every list.
- No sort controls; lists use the server order.
- Below 768: stacked rows (title link, secondary line, pills, one key meta value). Wide record
  tables (runs, delivery) scroll inside their container with a 32px edge fade.
- Sticky header only when the table has its own `max-h`.

## Filters

- The top-bar scope switcher is the only org control. No page-level Org select.
- One toolbar row above the table: search (`w-64` at ≥640), then selects that always read
  `Label: value` (`Status: Voided`) and get an `accent-subtle` fill when set, then `Clear`.
- Below 1280: the first two filters inline, the rest in `Filters (n)` with `Clear` in its footer.
  Below 640: search full width, filters in a two-column grid.
- Dates: one range control, `Date: any`. Entities: `EntityPicker` comboboxes. Never raw id inputs.
- A truly empty list hides the toolbar.

## Forms

- Label above the control (`text-sm font-medium fg`), required `*` right after the label text in
  `danger`, help `text-xs fg-muted` below, error `text-xs danger` replaces help and sets the danger
  border. Errors use `aria-describedby`, not `role=alert`.
- Blocked submit: focus and scroll to the first invalid field and announce one polite summary
  (`2 fields need attention`).
- Fields sit in a `FormGrid`. Fixed widths only for number + unit (`w-28`, unit inside the field,
  no spin buttons) and colour (swatch + `w-40` hex).
- Group headings (`FieldGroup`): `text-sm font-semibold fg-strong`, 24px above, hairline. Hidden
  when it repeats its only field's label.
- Booleans: `SwitchRow` for persisted settings (label and help left, switch right, help `xs`
  muted, controls flush right). `Checkbox` in wizards, dialogs and other forms. One kind per form.
- Date-time: `DateTimeField` shows `Nov 15, 2026, 4:08 AM` and a timezone select reading
  `Los Angeles (PT)` (stores the IANA id). `No date` / `Never expires` hides the controls.
- Examples are placeholders (`x-placeholder`); a default is a real value or nothing.
- Page forms save through `SaveBar` (fixed bottom, offset by the sidebar at ≥1024, Discard
  outline + Save primary). Dialog forms use footer buttons. No inline Save buttons on pages.

### Wizards

- Kit `Wizard`: `Stepper` on top (numbered circles joined by a hairline; done steps show a check
  and are clickable, state kept). Below 640: `Step 2 of 5 · Template` and a 2px progress bar.
- `WizardBar` sticky at the bottom: `Cancel` (ghost, left; unsaved guard when dirty), `Back`
  (outline) and `Next` / `Create` (primary) right.
- A step change scrolls to the top and focuses the step heading.
- The scope prefills the org; a step with one choice is skipped.
- Choices are `OptionTile`s (icon, name, one-line description). Enter or double-click advances.
- Review is a key-value summary with an `Edit` link per section.

## Status pills

Icon + Title Case text, always from `src/web/lib/status.ts`. Never render a raw enum.

| Tone | Meaning | Examples |
| --- | --- | --- |
| success | Healthy or working | Active, Verified, Healthy, Sent, Complete, Claimed, All good |
| warning | Needs attention soon | Degraded, Expiring, Partial, No recent run |
| danger | Broken | Failing, Failed, Errored |
| info | Neutral fact | Configured, Processing, Running |
| accent | Selection or primary | Primary, This device, Default, Showing |
| neutral | Inactive, origin, role | Voided, Not claimed, No holder, Revoked, Disabled, Unknown, Built-in, Uploaded, Admin, User, scopes |

- On/off values render as text (`On`/`Off`), not pills.
- Running and processing icons spin (they carry state, also under reduced motion).
- `This device` shows the device's icon; `Showing` an eye; `Default` a badge check.
- Error codes: show the sentence from the code map; the code only in details and drawers, in
  `font-mono text-xs fg-muted`.
- Audit and activity show labels (`Signed in`), never `auth.sign_in`, outside the audit drawer.

## Entity identity (R1)

One entity, one glyph, one illustration, one motion verb, from `src/web/lib/entities.ts`. Nav,
palette, breadcrumbs, empty states, audit, activity, timelines, pickers and status rows read it.

| Entity | Icon | Art | Verb |
| --- | --- | --- | --- |
| Pass | `Ticket` | `passes` | Deal and fan |
| Template | `LayoutTemplate` | `template` | Assemble |
| Connection | `Cable`; connectors `FlaskConical` (Demo), `Braces` (HTTP JSON), `Webhook` | `plugs` | Connect |
| User | `User`, initials avatar | `people` | Rise |
| Organization | `Building2`, monogram on the org accent | `building` | Light up |
| Apple identity | `FileBadge` | `certificate` | Stamp |
| API key | `KeyRound` (keys only) | `key` | Turn |
| Audit log | `ScrollText` | `log` | Scroll |
| Activity | `Milestone` | `activity` | Dots pop |
| Status component | `Activity` | `pulse` | Pulse travels |
| Workflow run | `Workflow` | `runs` | Hop |
| Device | `Smartphone` | `phone` | Receive |
| Delivery | `Send` (push), `Mail` (email) | `envelope` | Open |
| Image | `Image` | `frames` | Slide |
| Version | `History` | `layers` | Stack |
| Mapping | `ArrowRightLeft` | `mapping` | Draw |
| Search, filtered | `SearchX` | `lens` (overlay) | Search |
| Not found | — | `torn` | Tear |
| Forbidden | — | `lock` | Lock |
| Error, offline load | — | `unplugged` | Drop |
| Holder pages | — | `wallet` (mascot) | Fill |

Action icons (`src/web/lib/action-icons.ts`):

| Action | Icon |
| --- | --- |
| Pull from source, Sync now, Refresh (portal), Reload list | `RefreshCw` |
| Update devices | `Send` |
| Send or resend email | `Mail` |
| Test connection | `Zap` |
| Recheck, Check APNs | `Stethoscope` |
| Rotate link or secret | `RotateCw` |
| Void / Unvoid | `Ban` / `Undo2` |
| Delete, Remove | `Trash2` |
| Revoke session, Sign out | `LogOut` |
| Download / Upload / Open public page | `Download` / `Upload` / `ExternalLink` |
| New, Add / Duplicate / Edit | `Plus` / `Copy` / `Pencil` |
| Theme | `Monitor`, `Sun`, `Moon` |

## Empty, loading, error

- `EmptyState` requires `art`. Page level: dashed box, 96×72 art, title `text-sm font-medium`,
  one action. Inside a card: `inline` (no border, 64×48 art, one line). Navigation actions are
  outline; only create is primary.
- Filtered: the entity art dimmed with the lens over it, `No <things> match`, `Clear filters`.
- Truly empty list: the empty state holds the only primary; the header create turns outline and
  the toolbar hides.
- Not found: an `EmptyState` (art `torn`, or the mascot on holder pages) whose `h1` names the
  thing (`Pass not found`) and one way back. Forbidden: art `lock`. Never a red box.
- Error: `ErrorState` is a neutral card with a danger icon tile and the `unplugged` art, one
  sentence (what happened, what to do), Retry (outline). The request id hides under `Details` in
  `xs` muted mono. Unreadable responses: `Could not read the response. Reload.`
- Offline: a slim `Offline` bar under the top bar; paused actions read `Waiting for connection`;
  a page that cannot load shows `Could not load this page. Check your connection.` with Reload.
  The shell stays.
- Loading: `Skeleton` in the final shape and height (no layout shift); it appears after 150 ms.
  `Spinner` only inside buttons and polling rows. A refetch keeps the old rows, adds a 2px
  loading rail and `aria-busy`.
- Worker HTML routes never return problem+json to a browser: the SSR error page renders instead.

## Tabbed detail pages

- The active tab lives in the URL as `?tab=<id>` (`passDetailSearchSchema` in
  `admin/passes/search.ts`, `validateSearch` in `routes/admin/passes/$passId.tsx`).
- Changing tab replaces history. An invalid or missing tab falls back to the default.
- Below 640, five or more tabs render as a select (`Section: Fields`); otherwise a scrolling
  strip with a 32px edge fade and chevrons.
- Pass detail tabs: Fields, Holder, Delivery (with devices), Images, Versions, Connection, Activity.

## Dialogs and drawers

- Sizes as in Layout. Form dialogs are `md`.
- Header title (+ optional one-line description); X close except on alert dialogs and destructive
  confirms. Footer right: Cancel outline, then the action (primary, or danger with the verb:
  `Void`, `Delete`).
- Confirms name the consequence and, for many records, the count (`Void 12 passes?`).
- Typed confirms (`TypedConfirmDialog`): the title (≤24 characters), the slug, else `delete`;
  case-insensitive; a check appears when it matches.
- Secrets shown once (`SecretReveal`): labelled fields, masked with Show, copy buttons in their
  own column, `I saved the secret` gates Done.
- Focus: a field marked `data-autofocus`, else the dialog itself, never Cancel. Opened by pointer,
  nothing shows a ring. Focus returns to the opener (or the menu trigger) on close.
- Below 640: dialogs and confirms are bottom sheets (full width, actions stacked with the primary
  on top, 44px, safe-area padding); `MoreMenu` and row menus open as an action sheet.
- Sheets: left for navigation (drag to close on touch), right for record detail (`w-96` at ≥640,
  full width minus 16px below).

## Typography

| Role | Class | Console | Customer |
| --- | --- | --- | --- |
| Page title | `text-2xl font-semibold tracking-[-0.015em]`; customer pages `sm:text-3xl` (`size="lg"`) | 1.5rem | 1.75rem, 1.875rem at ≥640 |
| Section heading (no card) | `text-base font-semibold` | 1rem | 1.125rem |
| Card / dialog title | `text-sm font-semibold` (dialog `text-base`) | 0.875rem | 1rem |
| Form group heading | `text-sm font-semibold fg-strong` | 0.875rem | 1rem |
| Field label | `text-sm font-medium fg` | 0.875rem | 1rem |
| Body, table cells, values | `text-sm` | 0.875rem | 1rem |
| Meta, help, secondary lines | `text-xs fg-muted`; always below the title, never larger than meta | 0.75rem | 0.875rem |
| Stat value | `CountUp`, `text-3xl font-semibold tabular-nums` | 1.875rem | — |
| Code, ids, hashes, JSON | `font-mono text-xs`; JSON tinted by token (keys, strings, numbers) | 0.75rem | 0.875rem |

Customer pages (portal, `/login`, SSR auth, pass and error pages) use the same classes on a reading
scale: `src/web/styles/public-type.css` resets the `--pk-font-size-*` and `--pk-line-height-*`
tokens that Tailwind's `text-*` read, on `.wl-portal` (the portal and sign-in layout roots, `<body>`
on SSR pages) and on `:root` while one is mounted, so menus, sheets and toasts follow. SSR CSS reads
the same variables. The pass card sizes in its own container units and never changes. Sizes stay in
rem.

Brand sans everywhere, including SSR pages (served font, system fallback). On iOS only
(`-webkit-touch-callout`), customer pages set `font: -apple-system-body`, so the iOS text size
scales every rem (17 px root by default); macOS Safari would answer 13 px. Emails use the system
stack.

## Icons, focus, motion

- Lucide, `size-4` in buttons, nav and menus; `size-3.5` in pills; `size-5` inside a `size-9`
  `EntityIcon` tile. Icon-only buttons use `IconButton` (label + tooltip).
- Focus: 2px `--pk-focus` outline, offset 2 (buttons), 1 (fields). Shown for keyboard focus only.
  Route changes focus the `h1`. After a mouse or touch interaction (`html[data-modality=pointer]`)
  buttons and controls show no ring, including in dialogs opened from menus and on the restored
  opener; the next key press brings it back. Text fields keep theirs.
- Motion: follow [motion-and-expression.md](motion-and-expression.md). Three speeds: chrome
  80–280 ms, art 400–600 ms once, signature moments 480–900 ms. Only transform and opacity
  animate. No ambient loops. Reduced motion removes movement and keeps short fades and spinners.

## Passes and expression

- Every pass renders through `PassCardStage`: glow in the pass colour (plus a rim in dark), tilt
  and highlight on fine pointers, press tilt on touch, 3D flip between faces, deal in on arrival,
  mint on new content. Thumbnails are `still`.
- Truthful: real colours, Wallet's field limits per style, one line per front field with an
  ellipsis, a barcode that is never clipped, front links as plain text, labels at least 11px. See
  ux-principles.md "Truthful previews".
- Side toggle: `Front` / `Details` (`SegmentedControl`). Target toggle: `iOS 27` /
  `iOS 26 and earlier`, only when the faces differ.
- Teal is the only interactive accent. The foil gradient is reserved for the mint sweep, art hero
  edges, celebration sparks, the login cards and the sign-in card and email top edge.
- Dark raised surfaces get a 1 px lit top edge (`--wl-edge`); the primary button glows on hover and
  keyboard focus.

## Kit reference

Everything is exported from `src/web/ui/index.ts`; registries and hooks live in `src/web/lib/`.

| Need | Use |
| --- | --- |
| Entity glyph, art, label, plural | `ENTITY[kind]` (`lib/entities.ts`); `connectorIcon(id)`, `DELIVERY_ICON` |
| Action glyph | `ACTION_ICON.refresh`, `.rotate`, `.void`, `.delete`, `.signOut`… (`lib/action-icons.ts`); `THEME_ICON` |
| Audit or activity line | `actionOf(code)` → `{ label, icon, tone }`; `actionLabel(code)` |
| Status | `StatusPill status icon?`; `StatusIcon` for a state every row repeats (tooltip carries the hint) |
| Empty | `EmptyState art title action? description? variant? inline? heading?`; `FilteredEmpty entity onClear` |
| Error | `ErrorState error? title? onRetry? retryLabel?` (Retry spins `RefreshCw`; a failed retry shakes) |
| Lists | `DataTable … loading fetching filtered empty emptyFiltered toolbar footer` (rows carry `data-row-id`, new rows `data-new`); `FilterBar search filters onClear` (`DATE_RANGES`, `rangeStart`); `LoadMore … noun={['pass','passes']} scoped`; queries use `listQuery({...})` |
| Rows | `ListRows` + `ListRow leading title pills meta trailing rowId isNew` (the trailing control drops under the body below a 16rem list); `RowActions label actions` |
| Account rows | `EmailList`, `SessionList`, `InlineAddField` (presentational; the page owns mutations) |
| Layout | `TwoPane aside asideFrom='xl'\|'lg' stickyAside`; `FormGrid` + `FormSpan full`; `FieldGroup title onlyFieldLabel` |
| Forms | `Form form onSubmit` (blocked submit: focus, scroll, one polite summary); `RhfField`; `NumberField unit`; `DateTimeField clearLabel defaultZone` |
| Choices | `SegmentedControl label options value onValueChange`; `OptionTile` (Enter or double-click commits); `EntityPicker kind` |
| Wizards | `Wizard steps current onStep aside dirty onCancel onBack onNext formId nextLabel busy` |
| Confirms | `ConfirmDialog`; `TypedConfirmDialog word={confirmWord({ title, slug })}`; `SecretReveal fields onDone` |
| Notes | `Callout tone title items actions` |
| Identity | `EntityAvatar kind id name accent size`; `EntityChip kind id name to`; `EntityIcon kind` |
| Next steps | `Checklist title steps onDismiss`; `Celebrate when` (milestones only) |
| Loading | `Skeleton`, `SkeletonRows`, `SkeletonDetail`, `SkeletonKeyValue`, `SkeletonTimeline`, `SkeletonChartCard`, `SkeletonTileGrid`; `Handoff loading skeleton`; `LoadingRail`; `PendingNote` (polling rows only) |
| Buttons | `Button busy='spin'\|'pulse'\|'bob' done={value} undo paused`; `mutationButton(m)` spreads `loading`/`paused`; `SaveBar dirty saving paused`; `TOUCH_HIT` gives a custom control a 44 px touch hit area |
| Cards | `Card`, `CardHeader title actions`, `CardLink to\|href` |
| Badge | `AppleWalletBadge href label?`; `appleWalletBadgeHtml({ href, email? })` for SSR and email |
| Pass toggles | `PassSideToggle` (`Front` / `Details`); `PassTargetToggle` (`iOS 27` / `iOS 26 and earlier`), shown only when `usePassFacesDiffer(passJson)` |
| Motion hooks | `useArrivalMode`, `useInsertHighlight(ids)`, `removeWithTransition(update)` (`lib/motion.ts`) |
| Offline | `useOnline()` (`lib/online.ts`); the shells mount `OfflineBanner`; an unloaded route chunk offline renders the route error inside the shell (`lib/offline-routes.ts`) |
| Org scope | `useOrgScope()` (`lib/org-filter.tsx`); `isOrgScoped(path)` hides the switcher |
| Palette | `usePalette()?.open()` opens the admin palette (null outside the shell) |

## Light and dark

- Both themes from the same tokens; dark is the default. Check every page in both.
- The admin account menu offers System / Light / Dark; that choice applies inside the admin shell
  only. Holder surfaces (portal, `/p`, login, SSR auth, email) follow the system appearance and
  have no toggle.
- Pass art ignores the theme. SSR pages and emails use token values
  (`<meta name="color-scheme" content="light dark">`).

## Breakpoints

| Width | Rules |
| --- | --- |
| <640 (phone, 390) | Sheet nav; compact scope switcher; actions one row + `More`; stacked list rows; filter grid; bottom-sheet dialogs and menus; tabs >5 as a select; compact pass row |
| 640–1023 (tablet portrait, 768) | Sheet nav; search field `w-64`; tables show title + 2–3 key columns; horizontal pass summary card |
| 1024–1279 (tablet landscape) | Sidebar visible; wizard and upload asides; two filters inline + `Filters (n)`; tables hide low-value columns |
| ≥1280 | Full layouts: detail asides, pass preview column, three-column short fields |

## Customer side

- **Badge**: the kit `AppleWalletBadge` everywhere (`/p`, portal tiles and detail, Add all,
  email). Rules in ux-principles.md "Add to Apple Wallet badge".
- **Device rule**: iPhone, iPod and Mac get the badge. Other devices (iPad included) get the QR
  card (`Scan with your iPhone.`) first, the badge second and `Open on iPhone or Mac to add to
  Apple Wallet.`
- **Portal tiles**: the pass (stage), title and org; actions: badge (or `Show QR` + badge),
  `Refresh` (outline), `More` (Show QR, Remove). `In Wallet` pill for registered passes. No
  `Updated` line. Pass heights equal per row.
- **Portal pass detail**: card left, title + `Updated Nov 1`, the badge next to the card (or the
  QR), Refresh, `More` (Show QR, Copy link, Open public page, Remove). No `.pkpass` download.
- **Portal details**: format values by the pass field's date/number style; never ISO strings.
  Labels in sentence case.
- **Org first**: `/p` and the pass email show the org's logo or name. Never the bare "Wallet"
  brand in a view with the badge.
- Sign-in, magic-link confirm, link expired, no access, break-glass: one "hosted" shell shared by
  `/login` and the worker pages. See below.

## Sign-in pages (owner reference)

The owner's model is Polaris Key's hosted sign-in: `docs/design/references/polaris-sign-in.png`.
Source: `../polaris-key/docs/design/mockups/screens/identity/identity.{sign-in,device-code,device-code-states}.html`
and the `.hosted*` rules in `../polaris-key/docs/design/mockups/kit/mockup.css` (search `.hosted {`).
Same brand tokens; Wallet keeps its own wordmark and teal.

| Part | Rule |
| --- | --- |
| Brand | Wordmark (mark + "Wallet") centred above the card, not inside it |
| Scene | The wallet mascot sits on the card's top edge, its cards peeking over (motion-and-expression.md, Signature moment 8) |
| Card | One raised card, large radius, generous padding; body, then a footer split off by a divider. Two faces: sign-in and code |
| Title | `h1` names the task ("Sign in", "Enter the code from your email"); at most one short lede ("Sent to ada@…") |
| Fields | Label above; full-width input. The 6-digit code is one large mono field, centred and letter-spaced, grouped `123 456`, `autocomplete="one-time-code"` |
| Errors | A callout at the top of the card body (danger border, icon, one sentence: what happened and what to do); field errors under the field |
| Trust | At most one `hosted-note` (shield icon, muted) before the action where it prevents a mistake |
| Action | Email first: full-width primary `Email me a sign-in link →`. Polaris ID outline below an "or" divider. The code face: `Sign in`, `Resend code` (30 s), `Use a different email` |
| Footer | Lock icon plus one line on what signing in does |
| Below | `Help · Privacy` links, centred |
| Motion | "The wallet fills" (motion-and-expression.md, Signature moment 8), reduced-motion safe |

The trust and footer lines are the only explanatory text allowed on these pages: one line each.

- Public pass page: org logo or name in the header; pass centred (deals in, flips with a no-script
  `Details` toggle, tilts on fine pointers through `/pass-tilt.js`); the badge next to it, static;
  the QR card per the device rule; voided banner in `warning` with `Ban`. Two columns at ≥1024.
  An expired link uses the hosted card (`Link expired`, `Sign in`).
- Emails: fluid container `width:100%; max-width:480px`; 3px foil line (teal fallback) over the
  org header bar (org accent, text white or near-black by luminance). One title line. The pass
  email shows the pass (title and two or three key fields) before the badge, then `Open your
  pass` and `Open on iPhone or Mac to add to Apple Wallet.`. The sign-in code is a letter-spaced chip,
  not a field. Buttons 44px. Footer note `12px`. Nothing wider than 320px. No animation.
