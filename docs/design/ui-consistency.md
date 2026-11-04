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
| Raised | `surface-raised` | Cards, sidebar, table header; editable fields in light. Top bars use the page surface |
| Sunken | `surface-sunken` | Code, art slots, read-only and disabled fields in light. Never an editable field in light |
| Overlay | `surface-overlay` | Dialogs, menus, sheets, save and wizard bars |
| Lines | `border` (dividers), `border-strong` (controls, art strokes) | Never raw greys |
| Text | `fg-strong` titles, `fg` body and values, `fg-muted` labels and meta, `fg-subtle` placeholders | Dark `fg-muted` ≈ #8f98ad: 4.5–7:1 on raised, so labels separate from values |
| Accent | `accent` (#2dd4bf dark, #0f766e light) | Selection and the one primary action per view. Never origin, role or health |
| States | `success`, `warning`, `danger`, `info` + `-subtle`/`-border` | `success` only for healthy or working; `info` is blue (not Polaris violet, not foil) |

- No hex values in components. Exception: pass art (pass.json colours).
- One source for the SPA, SSR pages and emails. `npm run gen` compiles the SPA's tokens, kit
  controls (Button, Input, Label, Callout), fonts and holder CSS into `src/generated/ssr-*.css`
  and `resolved-tokens.ts` (`tools/build-ssr-{tokens,kit,holder}.ts`); SSR pages inline them and
  emails use the resolved values. `tools/ssr-parity.test.ts` and `tools/ssr-holder.test.ts` fail
  on drift. SSR icons come from `iconHtml(Icon)` (`ssr/icon.ts`), the SPA's Lucide markup. Words
  shared with SSR live in `src/shared/copy/*` (`states`, `holder`, `sign-in`).
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
| Card padding | header 48 px (`min-h-12 px-4`), body `p-4` |
| List rows | `py-3`, first `pt-0`, last `pb-0`, dividers between |
| Group heading in a form | 6 (24px) above, hairline |
| Between cards / sections | 6 (24px) |
| Page header to content | 6 (24px) |
| Gutters | One `--wl-gutter` for the top bar and main: 1rem (<640), 1.5rem (≥640), plus the safe area. Main: `pt-6`, bottom `max(1.5rem, inset)` |

No margin hacks (`mt-[…]`) to align controls; use the kit patterns below.

## Control heights

| Size | Fine pointer | Coarse pointer (touch) | Use |
| --- | --- | --- | --- |
| `sm` | 32 (`h-8`) | 44 (`h-11`) | Card-header actions, row actions, list footers: fits the 48 px card header and table row |
| `md` | 36 (`h-9`) | 44 (`h-11`) | Default: inputs, selects, combobox, search, page actions, toolbars, dialogs |
| `badge` | 40 (`h-10`) | 44 (`h-11`) | Buttons and icon buttons beside the Add to Apple Wallet badge, the art's height |
| `lg` | 44 (`h-11`) | 44 | Not beside the badge (use `badge`) |

- Text is 14 px at every size, 44 px tall on touch. Badges (`Badge`, status pills) are `min-h-6`,
  `text-xs`, `size-3.5` icons. Icon buttons follow the same table (`sm` 32, `md` 36, `badge` 40,
  44 on touch).
- One segmented control size: 36 (44 on touch), 14 px text. The SSR side toggle (`.pc-seg`) and
  the kit `SegmentedControl` (`.wl-seg`) share `pass-card/stage-seg.css`.
- Everything in one row shares one height. Fields are always `md`.
- Under `pointer: coarse`: tabs, menu items, nav links and icon buttons are at least 44 px; inline
  text links get padding to a 44 px hit height.
- Text inputs, selects and textareas are 16 px under `pointer: coarse` (iOS zooms below that);
  14 px on fine pointers. Never `maximum-scale`.
- Buttons use `min-height`, so a label can wrap to two lines at large text sizes.
- Top bar: ghost icon buttons; search is a field at ≥640 and an icon button below. The shortcut
  hint reads `⌘K` on Apple platforms, `Ctrl K` elsewhere, and hides when the only pointer is coarse.
- SSR pages use the kit's classes, so they match the app: same heights (36, 44 on touch), 14 px
  text, `md` radius. Emails: a 44 px link block, the Button's 14/500 type and `md` radius; beside
  the badge, the badge's 143 × 44 box at `lg`.
- Every screen, customer pages included, uses this scale. The one larger thing is the sign-in
  wordmark (`Wordmark size="lg"`, 20 px).

## Layout

- One `AppShell` frames every page (admin, portal, `/login`, error and not-found pages). Sticky top
  bar, 56 px with its border, on the page surface (not raised); the offline bar sits in the same
  sticky block and pushes the page down; then `main`. `width`: `holder` `max-w-5xl`, `console`
  `max-w-7xl`. Admin adds the sidebar, 15rem at ≥1024 (sheet below); its background and border
  belong to the grid column, so they span the full page height.
- The portal bar: wordmark, My passes, Account, Admin (admins, from 640), account menu.
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
| Portal | `max-w-5xl`; My passes 1 / 2 / 3 columns (<640 / ≥640 / ≥1024); pass detail two columns at ≥1024, the pass sticky at the left; account cards cap at 48rem |
| Login and SSR auth pages | `max-w-sm` card, centred |
| Public pass page | `max-w-5xl` like the portal; the portal's header and pass view (`HolderHeading`, `HolderPassView`): one column, two at ≥1024 (pass left; notice, add block, help right) |

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

- Card: `rounded-lg border bg-surface-raised shadow-elevation-1` (`CARD_SURFACE`; a table on its
  own uses it too); title `text-sm font-semibold`. The header is 48 px with or without actions.
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
- Emails (`EmailList`, portal and admin): title is the address plus `Primary` / `Not verified`
  pills; trailing actions. The add row is the list's last row, with the same divider and `py-3`.
  An empty list is one muted line, then the add row.
- `InlineAddField`: label above; input and button in one row (`grid-cols-[minmax(0,1fr)_auto]`),
  both the same height; help or error below the input only, so the button never moves.

## Tables

- Header `h-10`, rows `py-2` (≥44px), `text-sm`, one line per cell; second line `text-xs fg-muted`.
  Row heights within a table vary by at most 4px.
- Text left; numbers right with `tabular-nums`; pills left; row actions right (ghost `size-8`).
- Row title: `RowLink`, strong text that turns teal and underlines on hover (voided rows muted and
  struck through). The row is the target and teal stays for actions, so titles are not teal at
  rest. A count that opens a filtered list: `CountLink` (teal; zero is muted text). A link in a
  meta row (`Audit log`): `MetaLink` (muted, icon first).
- First column grows; meta columns (template, org, dates) `whitespace-nowrap`, truncate with a
  `title`.
- A state that every row would repeat (holder state) is an icon with a tooltip, not a pill.
- Dates: one formatter, `Oct 31, 2026, 6:17 PM`. No seconds, no numeric `10/31/2026`.
- Footer: `<n> <noun>` left, plus the scope (`19 passes in Northwind`); `Load more` (`sm` outline)
  right. Same component on every list: `LoadMore query={infiniteQuery}` pages by cursor, announces
  the new count, keeps focus at the list end and offers `Try again` when a page fails.
- No sort controls; lists use the server order.
- Below 768: stacked rows (title link, secondary line, pills, one key meta value). Wide record
  tables (runs, delivery) scroll inside their container with a 32px edge fade.
- Sticky header only when the table has its own `max-h`.

## Filters

- The top-bar scope switcher is the only org control. No page-level Org select. The scope is
  `?orgId=` in the URL (`useOrgScope()`), carried between admin pages; pages it does not apply to
  (Users, Identities, Status, Account) strip it with `UNSCOPED_SEARCH` and the switcher hides.
- One toolbar row above the table: search (`w-64` at ≥640), then selects that always read
  `Label: value` (`Status: Voided`) and get an `accent-subtle` fill when set, then `Clear`.
- Below 1280: the first two filters inline, the rest in `Filters (n)` with `Clear` in its footer.
  Below 640: search full width, filters in a two-column grid.
- Dates: one range control, `Date: any`. Entities: `EntityPicker` comboboxes. Never raw id inputs.
- A truly empty list hides the toolbar.

## Forms

- Label above the control (`text-sm font-medium fg`), required `*` right after the label text in
  `danger` (hidden when the control is read-only or disabled), help `text-xs fg-muted` below, error
  `text-xs danger` replaces help and sets the danger border. Errors use `aria-describedby`, not
  `role=alert`.
- Read-only and disabled text fields never look editable: no fill in dark, sunken in light
  (`--wl-field-readonly`), `border` instead of `border-strong`, muted text.
- Errors appear on submit, not while typing into a fresh form; after that they follow the value,
  so a fix clears its message on the same keystroke.
- Blocked submit: focus and scroll to the first invalid field and announce one polite summary
  (`2 fields need attention`).
- Every form gets this from the kit: `useFormErrors(found)` spread on `Form` (`{...check.form}
  onValid`), fields read `check.errors`. A Save or Next outside the form submits it by id
  (`SaveBar formId`, `Wizard formId`). `InlineAddField validate` does the same for one field.
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
- One page, one bar: a page with two or more forms wraps them in `SaveBarGroup`. Save submits
  every dirty form top to bottom, Discard resets them all, the route guard asks once and success
  says `Saved` once (`useSavedToast` for a form's own message). A refused form takes focus while
  the others save; a failed one stays dirty. `onValid` resolves `SaveResult` for this.

### Wizards

- Kit `Wizard`: `Stepper` on top (numbered circles joined by a hairline; done steps show a check
  and are clickable, state kept). Below 640: `Step 2 of 5 · Template` and a 2px progress bar.
- `WizardBar` sticky at the bottom: `Cancel` (ghost, left), `Back` (outline) and `Next` /
  `Create` (primary) right. Cancel only navigates; the page's `useUnsavedChangesGuard` asks once.
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
- One state language in the SPA and on SSR pages (`StateArt`, `ui/art/state-art.tsx`); ways back
  are outline buttons:

  | State | Buddy and prop | Title, way back |
  | --- | --- | --- |
  | Route not found | lost, peeks through the lens | `Page not found`; `Go to My passes` / `Go to Overview` (+ `Search` in admin) |
  | Entity not found | sad, mends the torn pass | `{Entity} not found`; `Back to {plural}` |
  | Forbidden | sad, tugs the lock | `You do not have access`; `Sign in as someone else` |
  | Error | sad, plugs the cable | `Something went wrong`, one sentence, Retry |
  | Expired link or pass | the gold pass droops | `Link expired`; `Go to My passes` |
  | Rate limit | sad, the hourglass | `Too many requests`, when to retry |

  Never a red box. The words are in `src/shared/copy/states.ts` (`STATE_COPY`, `notFoundTitle`,
  `backTo`).
- Detail pages: `detailError(query, { entity, to, back?, header? })` renders the failed load: 404
  is `DetailNotFound` under the page's header (breadcrumbs, `<title>`), other errors `ErrorState`
  with Retry, and a 403 is thrown to the route's error page (`RouteError`, Forbidden). Page code
  never imports `ui/layout/error-pages.tsx` (it would pull the shell out of the entry chunk).
- Error: `ErrorState` is a neutral card with a danger icon tile and the `unplugged` art, one
  sentence (what happened, what to do), Retry (outline). The request id hides under `Details` in
  `xs` muted mono. Unreadable responses: `Could not read the response. Reload.` Inside a card it is
  `inline`.
- Offline: a slim `Offline` bar under the top bar; paused actions read `Waiting for connection`;
  a page that cannot load shows `Could not load this page. Check your connection.` with Reload.
  The shell stays.
- Loading: `Skeleton` in the final shape and height (no layout shift); it appears after 150 ms.
  `Spinner` only inside buttons and polling rows. A refetch keeps the old rows, adds a 2px
  loading rail and `aria-busy`.
- Worker HTML routes never return problem+json to a browser: the SSR error page renders instead.

## Feedback

- **Toasts** (`toast` from `ui/toaster.tsx`; no direct `sonner` import):

  | Call | Use |
  | --- | --- |
  | `toast.success(msg)`, `.info(msg)` | A confirmation, 4 s |
  | `toast.sent(msg)` | A holder was emailed: the buddy posts its pass |
  | `toast.error(error, 'Could not {verb}')` | A failed action: the title names it, the line under it is the error's sentence. Stays until dismissed |
  | `toast.undo(msg, onUndo)` | A reversible change; a failed undo is its own error toast |
  | `toast.action(msg, { label, onClick })` | One follow-up (`View run`) |
  | `toast.dismiss(id)` | The offer no longer applies |

  Toasts clear the SaveBar; on phones they move to the top while a sheet is open. Success wears
  the buddy's face, unless a page buddy is in view (one buddy per view, `ui/art/presence.ts`):
  then a check.
- **Copy**: `CopyButton` for a value on screen, `copyText(value, what)` (`lib/clipboard.ts`) from
  a menu item (toast `Link copied`). The check resets after 1.5 s. Never `navigator.clipboard`.
- **Confirms** (`lib/confirms.ts`): `deleteConfirm(entity, name)`, `voidConfirm(count)`,
  `archiveConfirm`, `clearHolderConfirm`, `removeEmailConfirm(email, self)`, `revokeSessionsConfirm`,
  `revokeKeyConfirm`
  give every dialog for one act the same title (`Delete {name}?`), verb, and consequence line,
  plus `This cannot be undone.` when it cannot. Blast radius decides typing: type the name only
  when the act cannot be undone and takes more than the item (org, pass, connection). Template and
  identity deletes and API key revokes are plain: revoking a leaked key stays one click.
- Done checks on buttons use `Button done`, not hand-rolled icons.

## Create and delete flows

- A create flow marks what it made (`markCreated`) and opens the new page, replacing itself in
  history. The page leads, once, with a `CreatedCallout` (`Pass created`, next steps as small
  buttons, dismissible). A reload or second visit does not show it.
- A delete navigates to the list with `replace`, so Back does not return to a missing page.
- A list with no remaining items shows the truly-empty state.

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
- One title size on every overlay: dialogs, confirms, sheets and drawers are `text-base
  font-semibold` (`OVERLAY_TITLE`).
- A form dialog with input passes `dirty`: Esc, an outside click and X ask `Discard unsaved
  changes?` (the same confirm as a blocked route change); Cancel discards without asking.
- Confirms name the consequence and, for many records, the count (`Void 12 passes?`).
- Typed confirms (`TypedConfirmDialog`): the title (≤24 characters), the slug, else `delete`;
  case-insensitive; a check appears when it matches.
- Secrets shown once (`SecretReveal`): labelled fields, masked with Show, copy buttons in their
  own column, `I saved the secret` gates Done.
- Focus: a field marked `data-autofocus`, else the dialog itself, never Cancel. Opened by pointer,
  nothing shows a ring. Focus returns to the opener (or the menu trigger) on close.
- Below 640: dialogs and confirms are bottom sheets (full width, actions stacked with the primary
  on top, 44px, safe-area padding); `MoreMenu` and row menus open as an action sheet. Every bottom
  sheet dims the screen behind it with the dialog scrim.
- Sheets: left for navigation (drag to close on touch), right for record detail (`w-96` at ≥640,
  full width minus 16px below).

## Typography

| Role | Class |
| --- | --- |
| Page title | `text-2xl font-semibold tracking-[-0.015em]` |
| Section heading (no card) | `text-base font-semibold` |
| Card title | `text-sm font-semibold` |
| Overlay title (dialog, confirm, sheet, drawer) | `text-base font-semibold` |
| Form group heading | `text-sm font-semibold fg-strong` |
| Field label | `text-sm font-medium fg` |
| Body, table cells, values | `text-sm` |
| Meta, help, secondary lines | `text-xs fg-muted`; always below the title, never larger than meta |
| Stat value | `CountUp`, `text-3xl font-semibold tabular-nums` |
| Code, ids, hashes, JSON | `font-mono text-xs`; JSON tinted by token (keys, strings, numbers) |

Brand sans everywhere, including SSR pages (served font, system fallback). Every page uses this one
scale. Customer pages set `font: -apple-system-body` on iOS only (`-webkit-touch-callout`), so the
iOS text size applies; macOS Safari would read it as 13 px. Emails use
the system stack.

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
| Empty | `EmptyState art title action? description? variant? inline? heading?`; `FilteredEmpty entity onClear`; `DetailNotFound entity to back? heading?` |
| Error | `ErrorState error? title? onRetry? retryLabel? inline?` (Retry spins `RefreshCw`; a failed retry shakes); `detailError(query, { entity, to, back?, header? })` for detail pages |
| Feedback | `toast.success/info/sent/error(error, 'Could not …')/undo/action/dismiss`; `copyText(value, what)`; `CopyButton`; the confirm helpers in `lib/confirms.ts` |
| Lists | `DataTable … loading fetching filtered empty emptyFiltered toolbar footer` (rows carry `data-row-id`, new rows `data-new`); `FilterBar search filters onClear` (`DATE_RANGES`, `rangeStart`); `LoadMore query={infiniteQuery} shown noun={['pass','passes']} scoped`; queries use `listQuery({...})`; `RowLink to params inactive?`, `CountLink count noun? icon? to search`, `MetaLink to icon?` |
| Rows | `ListRows` + `ListRow leading title pills meta trailing rowId isNew` (the trailing control drops under the body below a 16rem list); `RowActions label actions` |
| Account rows | `EmailList`, `SessionList`, `InlineAddField` (presentational; the page owns mutations) |
| Layout | `TwoPane aside asideFrom='xl'\|'lg' stickyAside`; `FormGrid` + `FormSpan full`; `FieldGroup title onlyFieldLabel` |
| Forms | `useFormErrors(found)` + `Form id {...check.form} onValid` (errors on submit, then live; blocked submit: focus, scroll, one polite summary); `FormField label required error help`; `NumberField unit`; `DateTimeField clearLabel defaultZone` |
| Choices | `SegmentedControl label options value onValueChange`; `OptionTile` (Enter or double-click commits); `EntityPicker kind` |
| Wizards | `Wizard steps current onStep aside onCancel onBack onNext formId nextLabel busy`; the page owns `useUnsavedChangesGuard` |
| Confirms | `ConfirmDialog`; `DiscardDialog` (unsaved changes); `Dialog dirty`; `TypedConfirmDialog word={confirmWord({ title, slug })}`; `SecretReveal fields onDone` |
| Notes | `Callout tone title items actions` |
| Identity | `EntityAvatar kind id name accent size`; `EntityChip kind id name to`; `EntityIcon kind` |
| Next steps | `Checklist title steps onDismiss`; `Celebrate when` (milestones only) |
| Loading | `Skeleton`, `SkeletonRows`, `SkeletonDetail`, `SkeletonKeyValue`, `SkeletonTimeline`, `SkeletonChartCard`, `SkeletonTileGrid`; `Handoff loading skeleton`; `LoadingRail`; `PendingNote` (polling rows only) |
| Buttons | `Button size='sm'\|'md'\|'badge'\|'lg' busy='spin'\|'pulse'\|'bob' done={value} undo paused`; `IconButton size='sm'\|'md'\|'badge'`; `mutationButton(m)` spreads `loading`/`paused`; `SaveBar dirty saving paused formId?`; `SaveBarGroup` around a page's forms; `TOUCH_HIT` gives a custom control a 44 px touch hit area |
| Cards | `Card`, `CardHeader title actions`, `CardLink to\|href` |
| Badge | `AppleWalletBadge href label? theme?` (`theme`: the stamped page theme when server-rendered on `/p`) |
| Pass toggles | `PassSideToggle` (`Front` / `Details`); `PassTargetToggle` (`iOS 27` / `iOS 26 and earlier`), shown only when `usePassFacesDiffer(passJson)` |
| Motion hooks | `useArrivalMode`, `useInsertHighlight(ids)`, `removeWithTransition(update)` (`lib/motion.ts`) |
| Offline | `useOnline()` (`lib/online.ts`); the shells mount `OfflineBanner`; an unloaded route chunk offline renders the route error inside the shell (`lib/offline-routes.ts`) |
| Org scope | `useOrgScope()` reads `?orgId=` (`lib/org-filter.tsx`); `isOrgScoped(path)` hides the switcher; `UNSCOPED_SEARCH` (`lib/route-search.ts`) on routes it does not apply to |
| Shell | `AppShell bar sidebar? width holder` (`ui/layout/app-shell.tsx`); `UserMenu` (the one account menu); `useDocumentTitle` (`lib/route-focus.tsx`) |
| Theme | `useTheme()`; `THEME_OPTIONS` (menu and palette), `THEME_ICON`; `readPref`/`writePref` (`lib/theme.tsx`) |
| Palette | `usePalette()?.open()` opens the admin palette (null outside the shell) |

## Light and dark

- Both themes from the same tokens; dark is the default. Check every page in both.
- One theme setting for every page. The account menu (the same on every page) offers System /
  Light / Dark, with the current face of the app (My passes, Account, Admin) checked above it.
  The choice is saved in the `wallet-theme` cookie (`system|light|dark`, 1 year, read by
  `/theme-init.js` before first paint). SSR pages (`/p`, auth, error) read the cookie, stamp
  `data-theme` and one matching `theme-color`; without a choice they follow the system
  (`color-scheme: light dark`, `theme-color` per scheme).
- Pass art ignores the theme. Emails ship both schemes (dark via `prefers-color-scheme`).

## Breakpoints

| Width | Rules |
| --- | --- |
| <640 (phone, 390) | Sheet nav; Admin moves into the account menu on the portal; actions one row + `More`; stacked list rows; filter grid; bottom-sheet dialogs and menus; tabs >5 as a select; compact pass row |
| 640–1023 (tablet portrait, 768) | Sheet nav; search field `w-64`; tables show title + 2–3 key columns; horizontal pass summary card |
| 1024–1279 (tablet landscape) | Sidebar visible; wizard and upload asides; two filters inline + `Filters (n)`; tables hide low-value columns |
| ≥1280 | Full layouts: detail asides, pass preview column, three-column short fields |

## Customer side

- **Badge**: the kit `AppleWalletBadge` everywhere (`/p`, portal tiles and detail, Add all,
  email). Rules in ux-principles.md "Add to Apple Wallet badge".
- **Device rule** (`src/shared/device.ts`, portal and `/p`): iPhone, iPod and Mac can add with
  the badge. Wherever this is not the phone (Mac included) the add QR leads: it encodes the pass's
  `/p` page, so the iPhone that scans it opens the page in Safari and adds with the badge there (a
  Mac's own add needs Safari and iCloud's Wallet sync; the scan needs neither). A Mac gets the
  badge beside the QR; elsewhere (iPad, Android, Windows) the scan is the only way, so the pass
  page shows no badge and no line. Tiles, Add all and the email keep the badge everywhere, with
  `Open on iPhone or Mac to add to Apple Wallet.` where it cannot add; an in-app web view on a
  device that can, `Open in Safari…`.
- **Portal tiles**: three rows of the list grid (subgrid): the pass (stage), title and org, the
  actions at the bottom, so a row of tiles lines them up however the actions wrap. Actions:
  `Show QR` where the badge cannot add (a Mac finds it in More) and the badge, then `Refresh` and
  `More` (Show QR, Remove) as badge-sized outline icon buttons. `In Wallet` pill for registered
  passes. No `Updated` line. Tile radius 18 px (the pass's ~14). Show QR opens `Add to Apple
  Wallet` over the pass's name with the pass page's scan (`portal/add/scan.tsx`): the buddy on the
  QR's sign, `On your iPhone` / `Scan with the camera.` beside it, under it in the bottom sheet.
- **Portal pass detail** and **`/p`** are one header and one view (`portal/holder-heading.tsx`,
  `portal/holder-pass-view.tsx`; `/p` renders them to static markup with the same CSS, `npm run
  gen`).
  - Header: the pass's icon (44 px, app-icon corner), the org's name over what the pass is (the
    h1: the pass `description` `{Org} {kind}` split at the org, `Membership`; the holder's name
    stays a field), then `Voided` or `Expired` as a pill and `Updated Nov 1`. The breadcrumb and
    the tab title are the whole description. Actions at the right: `Refresh` and `More` (Copy
    link, Open public page in a new tab, Remove); `/p` has one quiet link, `Open in My passes`
    (sign-in first).
  - Body: the card left, sticky from 1024; right, the voided or expired notice (voided names the
    org's support: `Contact <org>`), the add block, the portal's Details card, the org's help.
  - Add block (`portal/add/`): it only adds, and the buddy holds it. Off the phone the QR sits on
    a sign drawn like the buddy (its line, fill and stitching), the buddy (M) on its top edge;
    beside it `On your iPhone` / `Scan with the camera.` and, on a Mac, `On this Mac` with the
    badge under a hairline. On the iPhone the badge's card (the buddy S on it) comes before the
    pass, so the badge is on the first screen. In Apple Wallet already: `In Apple Wallet` /
    `Updates arrive on their own.` under the happy buddy, and `Show QR` (`Add to this iPhone`)
    opens adding again. Voided or expired: the buddy sits on the notice, sad.
  - The badge has no padding of its own: the gaps are its clear space. No `.pkpass` download.
- **Portal details**: format values by the pass field's date/number style; never ISO strings.
  Labels in sentence case.
- **Org first**: `/p` and the pass email lead with the pass's icon and the org's name, and show
  the pass's logo on the pass, never the PassBook mark. The portal header shows the full PassBook
  wordmark on every page.
- **Pass email** (`email/pass.ts` in the shared shell): the band is `/p`'s bar, the pass's icon
  (24 px, `md`) and the org's name, which wraps beside the icon; the buddy only when the org opts
  in. The card: the title, the pass drawn small in its colours (its logo at most 36 px tall, then
  its logoText unless the org's logo has the name; a `line` edge where its colour would melt into
  the card, and in dark clients), then the badge and `Open your pass` as one pair: the badge's
  143 × 44 box, `lg` corners (the step nearest the art's), 12 px apart, left on the text edge.
  Side by side where the column fits both (390 up), stacked below. Inline blocks wrap without
  media queries (Gmail); a ghost table keeps the row in Outlook. Images come from
  `/p/:token/assets` with fixed boxes; the icon and logo answer `Cross-Origin-Resource-Policy:
  cross-origin` so webmail can show them.
- Sign-in, magic-link confirm, link expired, no access, break-glass: one "hosted" shell shared by
  `/login` and the worker pages. See below.

## Sign-in pages (owner reference)

The owner's model is Polaris Key's hosted sign-in: `docs/design/references/polaris-sign-in.png`.
Source: `../polaris-key/docs/design/mockups/screens/identity/identity.{sign-in,device-code,device-code-states}.html`
and the `.hosted*` rules in `../polaris-key/docs/design/mockups/kit/mockup.css` (search `.hosted {`).
Same brand tokens; Wallet keeps its own wordmark and teal.

| Part | Rule |
| --- | --- |
| Brand | One band above the card: the wordmark (20 px, the 24 px face) at the left, the face's ink on the card's text inset and centred on the mascot's face |
| Scene | The wallet mascot sits on the card's top edge at the right of the band, its pocket on the right text inset, its cards peeking over (motion-and-expression.md, Signature moment 8) |
| Card | One raised card, large radius, generous padding; body, then a footer split off by a divider. Two faces: sign-in and code |
| Title | `h1` names the task ("Sign in", "Enter the code"); at most one short lede ("Check ada@… for a code.") |
| Fields | Label above; full-width input. The 6-digit code is one large mono field, centred and letter-spaced, grouped `123 456`, `autocomplete="one-time-code"` |
| Errors | A callout at the top of the card body (danger border, icon, one sentence: what happened and what to do); field errors under the field |
| Trust | At most one `hosted-note` (shield icon, muted) before the action where it prevents a mistake |
| Action | Email first: full-width primary `Email me a sign-in link →`; in an installed app (standalone display mode) `Email me a code →`, since a link would open in the browser. Polaris ID outline below an "or" divider. The code face: `Sign in`, `Resend code` (30 s), `Use a different email` |
| Footer | Lock icon plus one line on what signing in does |
| Motion | "The wallet fills" (motion-and-expression.md, Signature moment 8), reduced-motion safe |

The trust and footer lines are the only explanatory text allowed on these pages: one line each.

- Landing: `homeFor(roles, next)` (`src/shared/next.ts`) for every way in (email link, code,
  Polaris ID, break-glass, an already signed-in `/login`): a safe `next`, else `/admin` for admins
  and My passes for holders. Every way back from an SSR page (error, expired, no access) links
  `/login?next=…`; `next` survives a plain sign-out. A switch through Polaris ID's end-session
  loses the query, so logout keeps `next` in the short-lived `wallet-next` cookie and `/login`
  reads it once.
- `/login?reason=expired` (a session that ended mid-use) shows one line above the form.
- Link flows: an email link opens a confirm page (SSR, no script) so scanners cannot use it. An
  add-email link asks the right account: the requester confirms, a signed-out browser gets `Sign
  in to confirm`, another account gets `Switch account`. A dead link says what it was for. Success
  lands on `/account?verified=<email>`, which toasts `Email added` and drops the parameter.
- `POST /auth/logout?all=1` ends every session; `Sign out everywhere` is on the Sessions card
  only, the account menu owns `Sign out`.

- Public pass page: the app shell's bar (56 px with its border, sticky) with the org's icon and
  name; the portal's header and pass view (deals in, flips with a no-script `Details` toggle,
  tilts on fine pointers through `/pass-tilt.js`, dips in CSS when the badge is pressed; the
  buddy's scene plays once on load and `/buddy-replay.js` replays it on a click).
  A dead link uses the hosted card (`Link expired`, outline `Go to My passes`).
- Emails match the hosted card: the card's colours, `xl` radius and foil top edge, the kit
  button's type and radius, tokens from `npm run gen`. The sign-in email carries the seated buddy
  cut in two slices at the card seam (top in the header band, legs over the foil; static PNGs,
  `public/email/`); the pass email is the org's, with no buddy unless the org opts in
  (`email.buddy`, org page `Pass email` card with a sample). Fluid container `width:100%;
  max-width:480px`; 3px foil line (teal fallback) over the header bar. One title line. The pass
  email shows the pass (title and two or three key fields) before the badge, then `Open your
  pass` and `Open on iPhone or Mac to add to Apple Wallet.`. The sign-in code is a letter-spaced chip,
  not a field; asked from the installed app (`prefer: 'code'`) the email is `Your sign-in code`:
  the chip first, large and full width, then `Or open this link` and an outline `Sign in`. Buttons 44px. Footer note `12px`. Nothing wider than 320px. No animation.
