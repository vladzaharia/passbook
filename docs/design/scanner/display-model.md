# Scan display: the customizable result model

What a scanner shows about a pass after a scan, how a template author designs it, and how the server renders it.
Status: reconciled with the direction review, 2026-11-04. Builds on `scanner-architecture.md` (cited **SA**),
`ux-door.md` (**UD**), `ux-desk.md` (**UK**), `ux-admin.md` (**UA**), `buddy-motion.md` (**BM**) and the direction
comparison (not shipped, cited **CMP**). Where this file and SA differ on the result content, this file
wins; section 7 lists every delta.

> **Revision 2026-11-04, owner answers** (`scratchpad/scanner-owner-answers.md`): the band title may add the holder's
> name, `{{holder.firstName}}` or `{{holder.name}}` and no other binding, and may take 2 lines for 1 more unit (R16,
> 1.3, 1.6, 6.3, 10.1 E12); two distinct blueprints, **Balance card** and the new **Stamp card**, ship their displays
> (R19, 2.3, 8); ledger rows show the action label only, and the memo idea is dropped (R13, 1.10, 9); starters are
> now **Blueprints**, platform designs you **Use blueprint** from and never issue, so the scanner only sees real
> templates (2.3, 9). Existing paths (`templates/starter-*`) keep their names.

> **Revision 2026-11-05** (stations and Access cards; section 11):
> - **A `customer` audience**: an opt-in `customer` block on the doc (`greet`, ≤ 2 chips per header, ≤ 1 panel), allow-
>   listed rows over a customer scope with every `x-scan` input removed, rendered by a separate pure
>   `renderCustomerView` into `ScanCustomerView`. Verdict copy for customers is the system's `CUSTOMER_COPY`; every
>   refusal reads **Please see the desk**. Desk monitors reuse the Door and Desk filters unchanged (5.2).
> - **Access bindings**: a new scope root `access` (plan, kind, zone, hours, visits, until), and `history.visits.*` /
>   `history.lastVisit.*` count visits (`scans.visit = 1`), not grants, on access templates (1.10).
> - **Icons** 40 → 42: `infinity` and `clock` for plan chips (4.1).
> - Detail: `addendum/stations.md` §3 (**ST**), `addendum/access.md` §1.4, §4.4 (**AX**). Section 11 wins where they
>   differ.

The owner's requirements, in one line each:
- customize the text, the icon, chips and information cards on a result;
- data comes from anywhere on the pass;
- per-card design (the template), in the template package, edited visually in the web app;
- a visual card editor: add, remove and reorder panels and rows.

Sections 1-8 are the model. Section 10 is the editor (the **Scan screen** mode of the template designer).

---

## Decisions after the direction review

The lead's call, pending the owner's confirmation, is **B strengthened**: B's layout (live dimmed camera, the buddy
XL on the dock, its violet middle pass rising into the result card, the bottom strip with the last scan and Undo, desk
input on the card) with A's verdict strength (a taller verdict band with a 40 px headline and a large glyph, a stronger
full-screen tint and ring). These decisions settle every model-side mismatch CMP found. They are already applied in
the sections they cite.

| # | Mismatch | Decision | Where |
| --- | --- | --- | --- |
| R1 | The direction | **The model is direction-agnostic.** `ScanDisplay` carries content, order and fit hints, never geometry, colours or sizes. Switching to "A at the door, B at the desk" touches only the screens (UI) and buddy (BU) workstreams; the renderer, schema, validator, editor and server don't change. The density budget is the one number tied to a layout, and it is set for the smaller of the two cards (B strengthened) | 1.2, 1.6 |
| R2 | Ticket has 4 columns; the model allowed 2-3 | **`columns` allows 2-4 items.** One line when the values fit the width's caps, otherwise two per line. The server marks each `columns` row `oneLine` for the compact width; the client picks the layout by measured width. A 4-item `columns` costs 3 units (its worst case, 2 × 2). The Ticket preset writes Section · Row · Seat · Gate when the template has a gate input | 1.6, 1.7 |
| R3 | B puts Redeem inside a card | **No controls in the display, ever.** Template actions, steppers, keypads, Undo, Let in again and Done live in the **system action area** (card footer and dock). A reached goal promotes the matching `take` action there; the `progress` row only carries the caption "1 reward ready" | 1.2, 1.11 rule 5 |
| R4 | A shows an Order panel on a refusal | **`refused` shows no panels.** Its only template content is `notes.refused`. The compact pass row (tile, holder line, pass title) is system content | 1.1, 1.2 |
| R5 | A shows a "hidden for Door" email tile | **Email and phone are never in scope, for any role.** No surface may imply a role could see them. The binding picker lists them disabled as "Never shown on scanners" | 1.11 rule 8, 10.1 E6 |
| R6 | Holder versus subtitle | **The holder line is system-owned and always shows** (`holder.name`, else the pass title). `header.subtitle` is an extra meta line under it, not a replacement. The verdict sub in the band is system copy | 1.2, 1.3 |
| R7 | Slot order | **Band → identity row (pass tile or photo, holder line, meta line, chips) → panels → notes.** The pass preview comes before the panels on every screen | 1.2 |
| R8 | Default panel of the uncustomized event blueprint | **Ticket.** The event blueprint ships a Ticket panel (Seat, Admission, Doors, Room). A template with no `scan.display` block (uploads, Henry's, boarding pass) gets the Details default from its front fields. The CMP tile is the blueprint as shipped | 2.2, 2.3, 8 |
| R9 | System copy drift in B | **UD and UK copy wins**, always from `SCAN_COPY`: "+2 stamps" (not "2 stamps added"), "Voided Nov 3." (not "Refunded"), milestones add no words (no "400 in tonight" chip). The display can't set any of these | 1.11 rules 3, 4, 6 |
| R10 | Per-event overrides | **Dropped as a display mechanism.** The display lives only in the template. Events keep check-in logic (gates, windows, re-entry). One event field stays: an optional **staff note** (≤ 140, plain text), shown on the Start panel and on `heads_up` and `refused` results only, where staff have to act. It earns its place because one night's instruction ("Wristbands at Gate C") shouldn't be a template version shared by every event | 2.6 |
| R11 | B merges the template's Loyalty panel into the stepper | **Desk `ready` keeps two layers:** the template's panels, then the system action area with the amount control. While an amount control is open, only the first panel shows; a `progress` or `money` row on the action's input previews the draft (7 → 9, $42.50 → $36.00) | 1.2, 1.6 |
| R12 | B's gym shows a large photo instead of the pass tile | **The member photo is an identity setting** (`photo`), not a panel row. It replaces the pass tile in the identity row (the ID check); a missing photo shows initials plus the system chip **No photo**. The `image` row keeps `thumbnail` and `strip` only | 1.3, 1.6, 4.2 |
| R13 | B's ledger labels ("Flat white") | **Ledger rows are labelled by the action** ("Charge", "Top up") or "Changed elsewhere". No item names: scans carry no memo, and none is planned (owner, 2026-11-04) | 1.10 |
| R14 | Saving and scanners | **A save makes a template version.** A save that changes only `scan.display` activates at once (nothing reaches passes), so every scanner shows it on its next scan. Passes are untouched: no rebuild, no push | 2.5, 10.1 E9 |
| R15 | The 7-unit budget doesn't fit BF's card (VIP at 6 units is 434 of 443 px; gym at 3 units with a title and photo is 436) | **The budget counts the header and is per screen.** Capacity 6 units per result (frames included), minus a header cost (custom title 2, `heads_up` 2, photo 1, a second chip line 1, staff note 1). `ok` over capacity is a save error; on other screens the renderer cuts trailing rows. Anything still over (large text, zoom) scrolls inside the card body; the band and identity row never move | 1.6, 1.11 rule 12 |
| R16 | Bound text in the band | **`header.title` is literal text plus, optionally, the holder's name** (`{{holder.firstName}}` or `{{holder.name}}`, no filter), or a plural; no other binding (owner, 2026-11-04). Up to 2 lines (28 graphemes); a title that can take 2 lines costs 1 more unit (1.6). A verdict word in the literal part is an error at save; the name is checked at render (1-3 words of letters, no verdict word, else the band shows the system headline) and needs a `holder` source that can hold a name (1.3). Other inputs and pass fields stay out of the band, so a value like "Refunded" can never land on a green screen; they stay available in the meta line, chips, panels and notes. `heads_up` and `refused` keep the system headline | 1.3, 1.6, 1.11 rule 6 |
| R17 | Secret holes | The blueprints have a plain `phone`, a `wifiPassword`, URL inputs, and fields that can show `pass.scanCode`. **Out of scope for every role:** URL inputs, inputs named like a contact or secret (unless explicitly annotated), and every field that references an out-of-scope input or `pass.*`. The holder source is one path, never free text | 1.11 rule 8, 3.1 |
| R18 | Live pass on a test scanner shows "the pass title" | **Mode mismatches show only the template name** (`ScanOutcome.template`); `display` is `null`. A pass title is often the holder's name | 1.2, 5.5 |
| R19 | The store card has no stamps input (`balance` is USD) | **Two blueprints** (owner, 2026-11-04). **Balance card** (the store card): Charge, Top up and Set balance (Manager) on `balance`, a Balance panel. **Stamp card** (new): Add stamp and Redeem reward on `stamps` (goal 10), a Loyalty panel with the stamp grid. Each ships its `scan.display` | 2.3, 8 |

---

## 0. Decisions

| # | Decision |
| --- | --- |
| 1 | **The display is part of the template.** `manifest.scan.display` (`ScanDisplayDoc`). Baked packages, blueprints and uploads ship one; the designer edits it; saving creates a template version. No per-pass and no per-scanner documents. |
| 2 | **No per-event display.** Events keep check-in logic; their one display-adjacent field is an optional plain-text staff note (`scan_events.note`, ≤ 140), shown on the Start panel, `heads_up` and `refused` (R10). |
| 3 | **Per-pass differences come from bindings, element conditions and header variants.** Variants switch the header (icon, title, meta line, chips), first match wins. Conditions show or hide a panel, row or item. |
| 4 | **A result is header slots plus 0-2 panels, and panels are made of rows.** The card kinds (Membership, Loyalty, Balance, Ticket, Offer, Access, Details, Note) are presets: factories that write ordinary rows. Rows are the truth; presets leave only a provenance tag. |
| 5 | **12 row primitives, one rhythm.** Each row type has a fixed layout, type scale and length caps; group rows (`columns`, `list`, `chips`) state their columns per width. A density budget (6 units per result with frames, minus the header's cost; 5 row units per panel) keeps every composition inside the B-strengthened card on a 390 px phone (1.6). |
| 6 | **System content and template content are separate.** System: the tint, ring and verdict band (glyph, headline, verdict sub), the holder line, the pass tile or photo, flags, refusal reasons, the action area and the buddy. Template: an `ok` icon and title, the meta line, chips, panels, rows and notes. On `ok` a custom icon leads with the verdict glyph as a badge, and a custom title moves the system word into an eyebrow. Refused screens show no template content except `notes.refused`. |
| 7 | **The server renders, the client paints.** `ScanOutcome.display` and `ScanCard.display` are fully rendered (`ScanDisplay`): strings, numbers and asset URLs, never expressions. Role filtering happens before evaluation, so data a role may not see is never in scope. |
| 8 | **The template expression language is reused.** It gets new reserved roots (`holder`, `inputs`, `fields`, `pass`, `scan`, `history`, `event`, `scanner`, `now`), display-only formatting filters, plural texts and numeric and relative-date conditions. It still has no loops, functions or arithmetic. |
| 9 | **The scanner reads the display from the template's active version.** A save makes a version; a display-only version activates on save (2.5), so staff see it on the next scan, mid-event, with no reissue. A version that differs from the previous one only in `scan.display` has the same `build_key`, so the stale job moves no passes and sends no push. |
| 10 | **History is computed from `scans`, not a new ledger.** `scans` already holds `before`, `after`, `amount`, `action_kind` and `outcome` for every value scan and check-in. One partial index makes visits and transactions cheap. A change made outside the scanner shows as one "Changed elsewhere" row, found by comparing the current value with the last scan's `after`. |
| 11 | **40 curated Lucide icons, stored as our own ids.** No uploads. Verdict shapes (check, triangle, octagon, X, clock, ban) are excluded, so a custom icon can never look like a verdict. |
| 12 | **The display never blocks a verdict.** A render error logs `SCAN_DISPLAY_RENDER` and falls back to the system default for that template. Offline verdicts (v2) carry no custom content. |
| 13 | **SA's `scan.values` and `scan.identity` are replaced** by the display (`holder`, `photo`, panels). `scan.flags` stays: it is behaviour (stop), and flags render in the system chip slot. |

---

## 1. Slots, rows, presets and the safety rules

### 1.1 Screens

A display renders for one of four screens, picked from the outcome:

| Screen | When | Template content allowed |
| --- | --- | --- |
| `ready` | desk card after `resolve` (UK 6.4), before an action | meta line, chips, panels, staff note |
| `ok` | an applied action (door check-in, stamp, redeem, ...) | icon and title (the verdict word kept), meta line, chips, panels, staff note |
| `heads_up` | a real pass that needs a person (`already_done`, `cooldown`, `check_required`, ...) | meta line, chips, panels, staff note. **Not** the icon or title |
| `refused` | red outcomes | `notes.refused` only |

System-only screens (`slate`: network, server, rate limit; `saved_offline`; client-local refusals such as `add_link`)
render no display at all. Milestones are an `ok` with a system foil edge and sparks, and add no words (UD 7).

### 1.2 The result layout: system content, then template content

Order from top to bottom, phone portrait, in the B-strengthened card. The screens workstream owns geometry and
motion; the model fixes the order, the owner of each slot and the caps. The same order holds in direction A (band
on top, sheet below), which is why the direction can change without touching the model (R1).

**System-owned content.** The display schema has no field that reaches any of these.

| Slot | `ready` | `ok` | `heads_up` | `refused` |
| --- | --- | --- | --- | --- |
| **Tint and ring** (full screen, over the live camera) | none (the camera dims) | green | amber | red |
| **Verdict band**: glyph, headline, verdict sub | none | glyph (or the custom icon with a verdict badge), headline ("Checked in", "+2 stamps"), sub from `SCAN_COPY` ("9 of 10 stamps") | glyph, "Already checked in", "12 min ago · Side door" | hero band: glyph, "Voided", "Voided Nov 3." |
| **Eyebrow** (in the band) | — | the verdict word, only when the title is custom | — | — |
| **Pass tile or photo** (identity row, leading) | tile; photo when `photo` is set | same | same | compact tile when the pass was found in this mode |
| **Holder line** (identity row) | `holder.name`, else the pass title | same | same | same, when found in this mode. Mode mismatch: the template name only (R18) |
| **Flags** (chip slot, first) | `scan.flags`, **No photo** | same | same | — |
| **Action area** (card footer and dock) | the template's actions, amount controls (stepper, keypad), commit pair | Undo in the strip | Let in again, Done | Done on the desk; the door's red clears after 3 s, **Look up** stays in the dock |
| **Last-scan strip** (dock) | last scan, Undo | this scan, Undo | this scan | this scan |
| **Buddy** (dock seat, BM) | seat pose | beat | beat | beat |

**Template-owned content** (`scan.display`).

| Slot | Source | `ready` | `ok` | `heads_up` | `refused` |
| --- | --- | --- | --- | --- | --- |
| **Icon** (leads the band) | `header.icon` | — | yes, with the verdict badge | — | — |
| **Title** (band headline) | `header.title` | — | yes, the verdict word moves to the eyebrow | — | — |
| **Meta line** (identity row, under the holder line) | `header.subtitle`, else the pass subtitle (list projection) | yes | yes | yes | — |
| **Chips** (identity row, after flags) | `header.chips` | ≤ 2, ≤ 4 with flags | same | same | — |
| **Panels** | `panels` | ≤ 2 (1 while an amount control is open) | ≤ 2 | ≤ 2 | — |
| **Notes** | `notes.staff`, `notes.refused` | staff | staff | staff | refused |

Event notes (2.6) sit in the notes slot on `heads_up` and `refused`, after the template's note. They are event data,
not template content.

**Fit.** The panels get what is left of the card (max 443 px on a 390 × 844 phone, BF) under the band and the
identity row. The density budget (1.6) counts both, per screen, so a valid display fits without scrolling at the
default text size; the renderer cuts what doesn't fit on screens with a bigger header. On iPad two panels stack in
the split card.

**Desk `ready` with an amount control** (R11): the system action area grows (stepper, presets, keypad) and only the
first visible panel shows. A `progress` row on the action's input, or a `money` row listing the action in `pending`,
previews the draft ("7 → 9", "$42.50 → $36.00"). That preview is system formatting of rendered numbers, not a
control. While the phone's keypad tray is open (it shortens the card), a `history` row in that panel shows its
newest item only; the client applies this fixed rule, it doesn't measure.

### 1.3 Identity and header slots

| Slot | Doc field | Type | Caps | Empty or missing |
| --- | --- | --- | --- | --- |
| holder line source | `holder` | one `{{path}}` to a string input, `fields.<key>` or `pass.title`; no literal text, no filter (`SCAN_DISPLAY_HOLDER`) | 40 graphemes, 1 line, truncated | the default in 2.2, else the pass title. The line itself always shows |
| photo | `photo` | `{ minRole?: ScanRole }` or absent | — | pass tile. With `photo` set and no photo on the pass: initials plus **No photo** |
| `icon` | `header.icon` | `ScanIcon` id (section 4) or null | 1 | system glyph |
| `title` | `header.title` | literal text with at most one holder-name token (`{{holder.firstName}}` or `{{holder.name}}`, no filter), or a plural (the count is a number path; its forms may hold the same token) | 28 graphemes, 2 lines at 40 px on a phone (14 a line); literal part ≤ 28, ≤ 20 beside a name | system headline |
| meta line | `header.subtitle` | `Text` | 60 graphemes, 1 line | the pass subtitle (list projection) |
| `chips` | `header.chips` | `Chip[]` | ≤ 2; text 16 graphemes; tone; optional icon | chip hidden |

The title sits in the verdict band, so its only binding is the holder's name, and its literal part is checked at save
(R16): "Welcome back" (12) fits one line of the band's 40 px headline at 294 px; 14 graphemes is the one-line cap and
28 the two-line cap. "Welcome back, {{holder.firstName}}" renders "Welcome back, Maya" on 2 lines. A missing name
empties the title (strict, 1.8), so the band shows the system headline. The renderer truncates the name, never the
literal part, to fit 28, and reports `titleLines` (1 or 2, the compact-width verdict, like `oneLine`). The holder
source is one path because the holder line is the one template-sourced string on a refusal and the ID check.

**The name in the band is checked, because it is data.** `holder` can point at any string input, and holders or a
connection can type anything into a name. So the band takes the name only when the template could have meant a name,
and only when the value reads as one:
- **At save** (`SCAN_DISPLAY_TITLE`): a name token needs a `holder` source that is a string input without `enum` or a
  `fields.<key>`; not `pass.title`, and not the pass-title fallback of 2.2 (a template with no name input).
- **At render**, after rule 9's sanitizing: the name token resolves empty unless its value is 1-3 words of letters and
  marks joined by spaces, hyphens, apostrophes or full stops (`^[\p{L}\p{M}]+([ '’.-][\p{L}\p{M}]+)*\.?$`, ≤ 3
  words), and holds no verdict word of rule 6 (whole word, case- and accent-insensitive). An empty token empties the
  title (strict), so the band shows the system headline. Nothing is logged: the value is personal data.
So "Welcome back, Maya" renders; a holder named "Refunded", "VOID 2", "Access denied" or a URL gets the plain verdict
band.

`Chip = { id, text: Text, tone: 'neutral' | 'teal' | 'violet' | 'gold', icon?: ScanIcon, when?: Cond, minRole?: ScanRole }`.

Chip tones are the buddy's foil hues plus neutral. Green, amber and red are never chip tones, because they are the
verdict colours. Chips sit in the identity row on the card surface, never in the band or on the tint, so a gold chip
on a green result is a tinted pill inside the card, not a second signal. Tone tokens are checked for AA in light and
dark (section 7.4).

### 1.4 Notes (`notes`)

| Note | Type | Caps | Shown on |
| --- | --- | --- | --- |
| `notes.staff` | `Text` (bindings allowed) | 140 | `ready`, `ok`, `heads_up` |
| `notes.refused` | literal string, no bindings | 100 | `refused` (any reason). The pass may be unknown, so there is nothing to bind |
| event note | `scan_events.note`, plain text, not in the doc | 140 | Start panel, `heads_up`, `refused` of a scanner on that event |

A note is one line of staff instruction in a fixed style (icon `Info` or `Hand`, `text-sm`). A Note *panel* (1.7) is
for longer, structured instructions with a heading ("Allergy").

### 1.5 Panels (the "cards")

```ts
interface Panel {
  id: string;                    // ^[a-z][a-z0-9_]{0,23}$, unique in the doc
  preset?: { id: PresetId; v: number };   // provenance only; rendering never reads it
  title?: Text;                  // panel header, 24 graphemes; empty: no header line
  icon?: ScanIcon;               // header glyph, 16 px
  tone?: Tone;                   // tints the header glyph, progress fills and list icons only
  rows: Row[];                   // 1-6, content ≤ 5 units
  on?: ('ready' | 'ok' | 'heads_up')[];   // default all three; `refused` is never valid
  actions?: string[];            // only after these action ids (ok) / for these cards; default any
  when?: Cond;                   // show when ...
  minRole?: ScanRole;            // default 'door' (everyone)
}
```

- A result shows at most **2** panels: the first two visible ones in document order (1 on desk `ready` while an amount
  control is open). A doc may define up to **6**, so conditional panels have room ("Lounge access" only for VIP).
- Every panel shares one frame: radius, padding, a header line (16 px tone icon, 13/600 label), the row rhythm (one
  baseline step between rows) and the same type scale. Kinds differ only by the rows they contain. That is what makes
  them one family.
- A panel never holds a control. Buttons belong to the system action area (1.2, 1.11 rule 5).
- A panel whose rows all render empty is dropped, and the next visible panel takes its place.

### 1.6 Row primitives

Every row has `id`, optional `when` and `minRole`. Texts are `Text` (1.8). The unit column is the density weight,
counted at the worst case (the compact width, every conditional element visible).

| Type | Fields | Renders as | Caps | Units |
| --- | --- | --- | --- | --- |
| `heading` | `text`, `detail?` | small label line, detail at the trailing edge | 24 / 24 | 0.5 |
| `field` | `label`, `value`, `icon?`, `strong?`, `whenEmpty?: 'hide' \| 'dash'` | label left, value right; value wraps to 2 lines | label 20, value 48 | 1 |
| `big` | `label?`, `value`, `unit?`, `tone?` | one large value ("$42.50", "F12", "20% off") | value 12, unit 12, label 20 | 2 |
| `columns` | `items: { id, label, value }[]` 2-4, `size: 'big' \| 'normal'` | label above value in equal columns (Section · Row · Seat · Gate) | label 12; value 8 (big) or 16 (normal) | big: 2 (2-3 items), 3 (4 items); normal: 1 (2 items), 2 (3-4 items) |
| `progress` | `value`, `goal`, `reward?`, `rewards?`, `icon?`, `style?: 'auto' \| 'stamps' \| 'bar'` | stamp grid (goal ≤ 10: two rows of 5 on a phone, one row on iPad) or bar, with a system caption. `auto` picks stamps up to 10; `stamps` over 10 is `SCAN_DISPLAY_PLACEMENT` | goal 1-1000 | stamps 3, bar 2 |
| `money` | `label?`, `amount`, `currency?`, `lowBelow?`, `pending?: string[]` | large amount with this scan's change and an optional low-balance line | — | 2 |
| `history` | `source: 'value' \| 'visits' \| 'scans'`, `input?`, `limit` 1-5, `show: ('amount' \| 'when' \| 'where' \| 'action')[]` | compact list of past scans (the ledger, for `value`) | — | 0.5 + 0.5 per item |
| `image` | `source: 'thumbnail' \| 'strip'`, `title?`, `detail?` | thumbnail as a media row (image + two lines); strip as a full-width 3:1 banner | title 32, detail 40 | 2 |
| `chips` | `items: Chip[]` 1-4 | wrapping pill row | as 1.3 | 1 |
| `list` | `items: { id, icon, text, detail?, when? }[]` 1-4, `pair?: boolean` | icon rows (perks, zones), optionally two per line | text 32, detail 24 | 0.5 per item (worst case one per line) |
| `note` | `text`, `tone: 'neutral' \| 'info' \| 'attention'`, `icon?` | instruction block | 140 | 1 |
| `divider` | — | hairline | — | 0 |

**Group rows: columns per width.** Widths are the panel's content width, measured by the client: **compact** is
under 400 px (a phone, and each of two side-by-side panels on iPad), **wide** is 400 px or more (one panel on iPad).

| Row | Compact | Wide |
| --- | --- | --- |
| `columns`, `big` | 2 items in one line when every value ≤ 8 graphemes; 3 when ≤ 5; 4 when ≤ 4. Otherwise two per line (2 × 2, or 2 + 1) | 2-4 in one line, every value up to its cap |
| `columns`, `normal` | 2 items in one line when every value ≤ 12; 3-4 when ≤ 8. Otherwise two per line, values wrap to 2 lines | 2-4 in one line |
| `list` with `pair: true` | two per line when every text ≤ 14 and every detail ≤ 16, otherwise one per line | two per line |
| `list` | one per line | one per line |
| `chips` (row or header) | wrap; at most 2 lines | one line |
| `field` | label left, value right; a value over 24 graphemes moves under the label | same |

The server knows the values, the client knows the width. So the renderer marks each group row with
`oneLine: boolean`, the compact-width verdict from the table, and the client applies it under 400 px and ignores it
at the wide width. The client never measures text to decide a layout, so the editor preview and the scanner agree.

**Density budget** (R15). Units are counted at the compact width. A panel holds ≤ **5** units of rows. A result
holds ≤ **6** units, counting **1 per panel frame** (header line and padding), minus the header's cost on that
screen:

| Header cost | Units | Why (BF, measured) |
| --- | --- | --- |
| a custom `header.title` on `ok` (base or any variant) | 2 | the stacked custom band is 158 px against 104 |
| that title can take 2 lines (a holder-name token, or literal text over 14 graphemes); render time counts `titleLines` | +1 | a second 44 px headline line: the band is 202 px |
| the `heads_up` screen | 2 | the two-line system headline (160 px) and the event note's slot |
| `photo` set for a role that reaches this screen | 1 | the 96 px photo row |
| more than 2 chips possible (template chips across variants, plus `scan.flags`, **No photo** and the bundle chip) | 1 | a second chip line |
| `notes.staff` set for this screen | 1 | the notes slot |

`ready` has no band; its desk header costs nothing. Calibration from BF's measured cards: VIP `ok` 6 units → 434 px;
gym `ok` 3 + title 2 + photo 1 → 436 px; the blueprint `ok` 6 → 407 px; already checked in (Ticket 4 + `heads_up` 2)
→ 440 px; all under 443. The constants live in one table in `density.ts`; the screens workstream's fit test (7.3)
owns the measurement, and if it fails the capacity goes down, never the type size.

- **Save time** (`SCAN_DISPLAY_DENSITY`, error): a panel over 5 row units, or the `ok` screen's worst case (every
  conditional row and item visible, group rows wrapped, the two panels with the most units among those whose `on`
  sets include `ok`) over its capacity. `SCAN_DISPLAY_CUT` (warning) when `heads_up` or `ready` can exceed theirs.
- **Render time:** the renderer counts the units of what it actually emits (conditions resolved, empty rows dropped,
  a `columns` row at 2 units when `oneLine` holds) and drops trailing rows, then trailing panels, until the screen fits.
  It never drops the first row of the first panel. A cut is deterministic, so the editor shows it on that tab.
- **Paint time** (1.11 rule 12): if the real card is still taller than its limit (Dynamic Type, zoom, a long system
  sub), the body scrolls inside the card; the band and identity row never move.

The six owner examples fit on `ok` (VIP 1 + 3 + 1 + 1 = 6; gym 1 + 2 + 3 header = 6; coffee 1 + 3 = 4; prepaid
1 + 2 + 2 = 5; coupon 1 + 2 + 1 + 1 = 5; blueprint 1 + 2 + 3 = 6). On `heads_up` the blueprint's Ticket keeps Seat and
Ticket and cuts Doors and Room.

**Placement rules** (validator errors, so compositions stay designed):
- `image` is the first row of its panel or not at all, and one per panel.
- `divider` never comes first or last, and never twice in a row.
- `heading` is never last.
- `big`, `money` and `progress` appear at most twice per panel.
- At most one `history` per result.

**Row semantics:**
- `field.value` with `whenEmpty: 'hide'` (the default) drops the row when the value is empty. `'dash'` shows "—", for
  rows staff expect to see ("Dietary: —").
- `columns`: an empty item value renders "—" so the columns keep their alignment; a row whose values are all empty
  drops.
- `progress.value` and `goal` must resolve to numbers (strings of digits are coerced). `goal` is a number, a number
  expression, or omitted when a `take` action on the same input exists: then the goal is that action's amount (a
  coffee card's "Redeem reward −10"). `rewards` defaults to `floor(value / goal)`. The caption is system copy, so no
  arithmetic is needed in templates: "2 more for Free coffee", "1 reward ready", "3 rewards ready". On `ok`, `before` is
  the scan's `before` value when the action changed this input, so the client can animate 7 → 9. When `rewards ≥ 1`
  and a `take` action on the input exists, the **action area** promotes that action (system logic, R3). The row
  itself never shows a button.
- `money.amount` resolves to a number, and `currency` to an ISO 4217 code (`currency` here, else the doc's
  `currency`, else the pass field bound to the input's `currencyCode`, else no symbol). `lowBelow` adds the system line
  "Low balance" in the gold tone (amber is a verdict colour). `pending` lists action ids whose draft amount the client
  may preview on the review step ("$42.50 → $30.50"). On `ok`, the row shows this scan's change ("−$12.00"). The
  client formats both with `Intl` from rendered numbers and the currency. That is formatting, not template evaluation.
- `history` rows come from server records, never from author text (section 1.10).
- `image.source: 'thumbnail'` is the pass's own `thumbnail` override, else the template's; `'strip'` likewise. The
  member photo is not a row: it is the identity setting `photo` (1.3, R12).

### 1.7 The card catalogue (presets)

A preset is a factory: `(manifest, mapping) → Panel`. It writes ordinary rows tagged with a `slot` name, so the editor
can re-map or upgrade them later. Every binding below is the **suggested** default; the author maps each slot to any
source (section 3.1) or deletes the row. A slot whose hints match nothing is left out, not written empty. Units are
rows only; add 1 for the frame.

**Membership** (`membership`, icon `id-card`). Membership information: tier, dates, visits.

| Slot | Row | Default binding | Accepts |
| --- | --- | --- | --- |
| `tier` | `chips`, one gold chip | input named or labelled tier, level, plan | text |
| `dates` | `columns` normal: Member since · Expires | `{{inputs.memberSince\|date}}` (else `{{pass.createdAt\|date}}`) · `{{pass.validUntil\|date}}` | date |
| `visits` | `columns` normal: Last visit · This month | `{{history.lastVisit.at\|ago}}` · plural `# visits` over `{{history.visits.month}}` | history |
| `status` | `field` Status | `{{pass.statusLabel}}`; off by default (the band and pass tile carry it) | text |

Units 3. Adding Membership also offers **Show member photo**, which sets the doc's `photo` (R12), because the photo
belongs in the identity row as the ID check.

**Loyalty** (`loyalty`, icon `stamp`). Loyalty rewards and stamps, or points.

| Slot | Row | Default binding |
| --- | --- | --- |
| `stamps` | `progress` value, goal, reward | `{{inputs.stamps}}`, goal from the `take` action, reward from its `rewardLabel` |
| `rewards` | inside `progress` (system caption) | computed, or `{{inputs.rewards}}` when such an input exists |
| `points` | `big` with unit "points" | `{{inputs.points}}` |
| `last` | `history` source `value`, limit 2, show `amount`, `when` | the stamps input |

Units 2-5. A reached goal promotes the redeem action in the action area; the card shows only the caption.

**Balance** (`balance`, icon `wallet`). Credit balance, this transaction and the ledger.

| Slot | Row | Default binding |
| --- | --- | --- |
| `balance` | `money`, `lowBelow` unset, `pending` = the template's `take` and `add` actions on the input | `{{inputs.balance}}`, currency `{{inputs.currency}}` |
| `transactions` | `history` source `value`, limit 3, show `amount`, `when`, `where` | the balance input (1.10 ledger) |

Units 4. On review the `money` row shows the draft ("$42.50 → $36.00, −$6.50"); on `ok` the result and this scan's
change.

**Ticket** (`ticket`, icon `ticket`). Ticket information: section, row, seat, gate.

| Slot | Row | Default binding (inputs or pass fields named so) |
| --- | --- | --- |
| `seat` | `columns` big: Section · Row · Seat, plus Gate when a gate input exists | `section`, `row`, `seat`, `gate` / `entrance` / `door` |
| `type` | `field` Ticket | `admission`, `ticketType`, `tier` |
| `doors` | `field` Doors | `{{inputs.doorsAt\|time}}` |
| `when` | `field` Starts | `{{inputs.startsAt\|datetime}}`; off when `doors` is set |
| `room` | `field` Room | `venueRoom`, `room`, `hall` |
| `admits` | `field` Admits | plural `Admits #`, count `{{inputs.admits}}` |

When only a single `seat` value exists (the event blueprint has `seat` = "Row F, Seat 12"), the preset writes a `big`
row (label Seat) instead of `columns`. Units: `columns` 2-3 plus up to three fields; the factory stops adding fields
at 5.

**Offer** (`offer`, icon `percent`)

| Slot | Row | Default binding |
| --- | --- | --- |
| `offer` | `big` | `{{inputs.offer}}` or the primary field (`{{fields.offer}}`) |
| `terms` | `columns` normal: On · When | `{{inputs.appliesTo}}` · `{{inputs.terms}}`; else a `field` Conditions (2 lines) |
| `uses` | `columns` normal: Uses left · Use by | `{{inputs.usesLeft}}` · `{{pass.validUntil\|day}}` |

Units 4.

**Access** (`access`, icon `key`)

| Slot | Row | Default binding |
| --- | --- | --- |
| `zones` | `list`, `pair: true`: one item per perk, each with its own `when` | e.g. Lounge (`armchair`) when `inputs.lounge` is true; Dinner (`utensils`) with detail `{{inputs.dietary}}` |
| `table` | `field` Table | `{{inputs.table}}` |

Units 1-3.

**Details** (`details`, icon `info`): 1-4 `field` rows. The editor offers the pass's front fields as quick picks
(`{{fields.<key>}}`, label copied at authoring time). Units 1-4.

**Note** (`note`, icon `hand`): a `heading` (optional) and one `note` row. Units 1-1.5.

Presets never write a control, a refusal panel or a photo row.

### 1.8 Text

```ts
type Text =
  | string                                          // literal or "{{...}}" interpolation
  | { count: string; one: string; other: string; zero?: string };   // plural; "#" is the formatted count
```

- **Strict missing values.** If any interpolation in a text resolves empty (undefined, null, "" or []), the whole text
  is empty. "Row {{inputs.row}} · Seat {{inputs.seat}}" never renders "Row  · Seat 12". Authors who want partial
  output split it into rows or columns.
- **Plural.** `{ count: '{{inputs.admits}}', one: 'Admits #', other: 'Admits #' }`. The count is a number
  expression; `#` becomes the locale-formatted number. `Intl.PluralRules` picks the form (`zero` is used when given and
  the count is 0).
- Rendered texts are plain strings. The client renders them as text nodes, never HTML.

### 1.9 Formatting

All formatting happens on the server with the actor's time zone (`ScanActor.timeZone`: event, else scanner, else the
admin's scope) and the scanner's locale (first supported tag from `Accept-Language`, else `en`). Orgs have no time
zone today; the event or scanner time zone is the right one for staff anyway.

| Filter | Input | Output (en, America/New_York) |
| --- | --- | --- |
| `date` | ms or ISO date-time or date | Nov 3, 2026 |
| `time` | same | 6:02 PM |
| `datetime` | same | Nov 3, 6:02 PM (year only when not this year) |
| `day` | same | Today, Yesterday, Tomorrow, Mon, or Nov 3 |
| `ago` | same | just now, 4 min ago, 2 h ago, 3 days ago, Nov 3 |
| `count` | number | 1,240 |
| `money` | number | $42.50 (the doc's `currency`) |
| `upper` | string | VIP |

Typed rows format themselves (`money`, `progress`, `history`). Filters are for inline text. A path with no filter
interpolated into text is stringified as today (`String(value)`); a lone path in a typed field keeps its type.

### 1.10 Scan history

Cards can show what happened before. The server computes it from `scans` (SA 6.1) and the gates. Every value is
within `retention.scansDays` (396 days by default) and excludes undone scans and undo rows.

| Path | Meaning | Query (index) |
| --- | --- | --- |
| `history.lastVisit.at`, `.where` | the last `ok` check-in before this scan | `scans_pass_ok` (`pass_id, action_kind, at DESC`), `LIMIT 1` |
| `history.visits.today`, `.week`, `.month`, `.year`, `.total` | `ok` check-ins in that period, in the actor's time zone | same index, range count, capped at 9,999 |
| `history.checkedInAt` | first `ok` check-in in the current gate scope (this event, or today for `daily`) | `scan_gates.first_at` (already read by the gate) |
| `history.inside` | `true` / `false` / null under re-entry | `scan_gates.state` |
| `history.scans.today`, `.total` | `ok` scans of any action | `scans_pass_ok` |
| `history.lastScan.at`, `.where`, `.action` | the last scan of any outcome | `scans_pass`, already read for `lastScans` |
| `history` row `source: 'value'` (the ledger) | the last N `ok` scans whose action's input is `input`: `at`, `amount` (signed), `after`, `where`, `label` (the action's label: "Charge", "Top up") | `scans_pass_ok`, kinds `add`, `take`, `set`, over the last 50 rows |
| `history.ledger.<input>.last.at`, `.amount`, `.label` | the newest ledger entry, for inline text ("Last top-up 3 days ago") | the same rows; no extra statement |
| `history.ledger.<input>.month.in`, `.out` | sums of positive and negative amounts this month, in the actor's time zone | one conditional-sum statement in the same batch |
| `history` row `source: 'visits'` | the last N `ok` check-ins: `at`, `where` | same |
| `history` row `source: 'scans'` | the last N scans, any outcome: `at`, `action`, outcome word | `scans_pass` |

`where` is the scanner's current name (`scanners.name`, looked up in the same batch), "Console" for an admin session,
and "Removed scanner" when the row is gone. Staff names are not exposed in history rows.

**What a Balance panel needs, end to end.** The current balance (`inputs.<input>` after this scan's effect), the
currency (1.6 `money`), this scan's change (`scan.amount`, `scan.before`, `scan.after`, set only when the action
changed that input), the draft on review (`pending`, client-side preview of a rendered number), and the ledger
(`source: 'value'`). Ledger rows carry the **action label** only, never an item name: scans have no memo field, and
none is planned (R13). B's "Flat white" rows read "Charge".

**Changes made elsewhere.** An admin edit, an API update or a connection sync changes a balance without a scan row.
For `source: 'value'`, when the pass's current value differs from the newest listed scan's `after`, the renderer
inserts one row at the top: **Changed elsewhere**, with the signed difference and no time. This is honest and costs
nothing: no new table, and the Sync log stays the place to see who changed it.

**What the server must keep.** Nothing new beyond the index:
- value scans already store `amount`, `before_value` and `after_value`;
- check-ins already store `outcome`, `action_kind` and `at`;
- `0014_scan.sql` gains `CREATE INDEX scans_pass_ok ON scans (pass_id, action_kind, at DESC) WHERE outcome = 'ok';`
  (undone rows are filtered as a residual, since `undone_at` changes).

**Cost control.** Section 5.3: history queries run only when the doc references them, and in the same D1 batch as the
card reads.

**Access templates** (11.5): `history.visits.*` and `history.lastVisit.*` count rows with `visit = 1` (one extra
predicate, same index), and `history.lastVisit.where` is the zone name when the row has one, else the scanner's name.

### 1.11 Safety rules (non-negotiable, enforced in code, tested)

1. **Verdict.** The display schema has no field that reaches the tint, the ring, the verdict band (glyph, headline,
   verdict sub), the hold rail, the sound or the buddy. `heads_up` and `refused` ignore `header.icon` and `title`
   entirely, and `refused` also ignores the meta line, chips and panels: the renderer doesn't emit them.
2. **Glyph on `ok`.** A custom icon may lead on `ok` only. The client then draws the system verdict glyph as a badge on
   the icon's lower trailing corner (≥ 40 % of the icon size, never under 24 px, on-colour ring). The shape cue survives.
3. **Verdict word on `ok`.** When `title` is custom, the system headline ("Checked in", "+2 stamps") renders as the
   eyebrow above it, and the live-region announcement starts with the system headline. A custom title can't replace
   the verdict, only add to it.
4. **Refusals.** Reasons and their subs are `SCAN_COPY`, always ("Voided", "Voided Nov 3."). Template content on
   `refused` is `notes.refused` (literal) only; the compact pass row is system content and the event note is event
   data. No panel ever shows on a refusal, so an order number or a refund reason never appears there.
5. **No controls.** The display has no buttons, links, URLs, phone numbers or emails, and no row type can render one.
   The template's actions, amount controls, Undo, Let in again and Done live in the system action area (card footer
   and dock), which the display can't reach. A reached goal promotes its action there, never inside a card.
6. **No verdict look-alikes.** The icon set excludes check, check-circle, triangle-alert, octagon, X, ban, clock and
   lock shapes. Chip tones exclude green, amber and red, and the `note` row's `attention` tone is gold, not the
   warning amber (7.4). A verdict word (refused, denied, invalid, expired, voided, not valid, already, stop, refunded,
   cancelled, blocked, banned) in the literal part of `header.title` (base or variant) is an error (`SCAN_DISPLAY_TITLE`), because the
   title sits in the band; in
   a literal meta line, chip, panel text or note it is a warning (`SCAN_DISPLAY_VERDICT_WORD`). The title's only
   binding is the holder's name, which comes from an input, so it passes the name check of 1.3 at render: a value
   that isn't 1-3 words of letters, or holds a verdict word, empties the title and the band shows the system
   headline. No other input or field value reaches the band. System copy is fixed: action headlines ("+2 stamps"),
   reason subs and milestones (no words, a foil edge and sparks only) come from `SCAN_COPY` and UD/UK, and the display
   adds nothing to them.
7. **Role visibility.** Elements with `minRole` above the actor's role are removed before evaluation. Inputs marked
   `x-scan` above the role are removed from the scope, and conditions run on that filtered scope, so a Door-visible
   element can't reveal a desk-only value by appearing or not. Content hidden from a role stays hidden whatever the
   doc says (section 5.2).
8. **Secrets are never in scope** (R17), for every role, admins included:
   - `pass.scanCode`, the barcode message, `authenticationToken`, `webServiceURL`, the serial and the download token;
   - inputs with `format: email | uri` or `x-widget: email | tel | url`; no annotation brings these back;
   - inputs with a name segment (camelCase or snake_case) of `email`, `phone`, `tel`, `mobile`, `password`, `passcode`,
     `secret`, `token` or `pin`, unless the input carries an explicit `x-scan` (the author's deliberate choice, shown in
     the Inputs section);
   - any front or back field whose `value` references one of the above or any `pass.*` binding (`PassScope`), or whose
     value equals the barcode message. `attributedValue` is never read.
   Referencing a secret is a validator error (`SCAN_DISPLAY_SECRET`). Secrets are never described as "hidden for a
   role": no role can see them. The only system surface that touches an email is the lookup row's masked form
   (`a•••@g•••.com`), which exists to tell namesakes apart and is not display content.
9. **Caps after rendering.** Every string is NFC-normalized, stripped of control and bidi-override characters,
   whitespace-collapsed (notes keep single line breaks), and truncated to its cap by grapheme with "…". The client
   wraps user data in `dir="auto"` / `unicode-bidi: isolate`.
10. **Motion.** Display content has no animation of its own. Only system primitives animate (progress fill, count-up),
    with transform and opacity, reduced-motion stills, and the next scan cuts them (BM 7).
11. **Fail safe.** Any render error → the system default display and a `SCAN_DISPLAY_RENDER` error log. The verdict,
    ledger and counts are unaffected.
12. **The verdict stays in view.** The band and the identity row have fixed positions in the card; content that
    doesn't fit scrolls inside the card body under them (1.6, paint time). The card never grows above its top limit,
    so no amount of template content can push the band under the capsule.
13. **One source per surface.** A result card paints `ScanOutcome.display` only. `ScanCard.display` (screen `ready`)
    is for the desk panel; the client never paints it under a verdict, so a refusal can't show `ready` panels that
    ride along in the card.

---

## 2. Where it lives

### 2.1 Manifest

`wallet.template.json`:

```jsonc
{
  "scan": {
    "actions": [ ... ],            // SA 4.1, unchanged
    "lookup": { "input": "ticketId" },
    "window": { ... },
    "flags": [ ... ],              // stays: behaviour (stop), rendered in the system chip slot
    "display": {                   // ScanDisplayDoc
      "v": 1,
      "holder": "{{attendee}}",    // source of the system holder line; scope `holder.name`
      "photo": { "minRole": "desk" }, // optional: the member photo replaces the pass tile
      "currency": "{{currency}}",
      "header": { "icon": null, "title": null, "subtitle": null, "chips": [] },
      "variants": [ ... ],         // ≤ 8, first match wins
      "panels": [ ... ],           // ≤ 6 defined, ≤ 2 shown
      "notes": { "staff": null, "refused": null }
    }
  }
}
```

`manifest.display` (the passes list projection: title, subtitle, status, search) is unrelated and unchanged. Code
names keep them apart: `ScanDisplayDoc` (authored), `ScanDisplay` (rendered), `DisplayProjection` (the list).

`scan.values` and `scan.identity` (SA 4.1) are removed. Their jobs move to `display`:

| SA field | Now |
| --- | --- |
| `values[]` (`input`, `label`, `goal`) | Loyalty / Balance presets. The card's system `values` (section 7.2) are derived from action inputs for pickers and headlines |
| `identity.photo` | the doc's `photo` setting (identity row) |
| `identity.fields` (≤ 2) | the meta line (`header.subtitle`) or chips |

### 2.2 Defaults: no `display` block

`defaultScanDisplay(manifest, passJson)` (pure, passkit) is applied at read time, like `scanOf`. It is never
persisted, so better defaults reach every uncustomized template at once.

- `holder`: the first of `holder`, `attendee`, `memberName`, `name`, `passenger` that is a string input; else
  `display.title`.
- `header`: all null (system copy). No chips.
- `photo`: absent.
- Panel 1, **from the actions**: for the first number input of an `add` or `take` action, a Loyalty-style
  `progress` row when a `take` action gives it a goal ≤ 1000, else a `big` row with the input's `x-label` as unit.
  `money` instead when a pass field bound to it has a `currencyCode`. Units 2-3 (3 for a stamp grid).
- Panel 2, **Details from the pass**: the first non-empty front fields, at most 4, and only as many as the 6-unit
  budget leaves after panel 1 (1 or 2) (`primaryFields`, `secondaryFields`,
  `auxiliaryFields`, in that order) of the template's style as `field` rows, label from the field's `label` (resolved
  through `en.lproj/pass.strings`), value `{{fields.<key>}}`. Fields whose value is the holder name, and fields out of
  scope (1.11 rule 8), are skipped.
- `notes`: none.

A template with no block, for example an uploaded event ticket, therefore shows: green, **Checked in**, the holder
line, and a Details panel with its first four front fields as the pass shows them. A template made from the Event
ticket **blueprint** is not such a template: it copies the blueprint's Ticket display (2.3), so the CMP "same event template, uncustomized" tile is the Ticket panel
(R8). Details stays the no-block default because it is the one panel that is right for any pass.

Opening the editor on a template with no block materializes this default into the doc, marked as unsaved. The
holder line, tint and band need no default: they are system content.

### 2.3 Baked templates and blueprints (`templates/**`, a2)

- **Blueprints and templates** (owner, 2026-11-04; IA: `scratchpad/template-identity/spec.md`, "IA: Starters vs Templates", once
  it lands). A blueprint is a platform design; it never issues passes. **Use blueprint** makes a real, org-owned
  template with a copy of the blueprint's display. The scanner only ever sees real templates, so every scanned pass
  has a display its org can edit.
- Each blueprint ships a designed `scan.display` in its `wallet.template.json`, validated when `npm run gen` builds the
  baked packages (`tools/lib/baked-templates.ts` → the package analysis → `validateManifest` → `scanDisplayIssues`,
  so the tool itself doesn't change; errors fail `npm run gen`), with a rendered snapshot per screen in
  `src/passkit/template/__snapshots__/` (`baked.test.ts`).
- Blueprint displays:
  - event ticket → holder `{{attendee}}`, one Ticket panel: Seat (`big`, from the single `seat` input), Ticket
    (`{{inputs.admission}}`), Doors (`{{inputs.doorsAt|time}}`), Room (`{{inputs.venueRoom}}`). Units 5, frame 1;
  - **Balance card** (the store card, `templates/starter-store-card`) → holder `{{inputs.holder}}`; Balance: `money`
    on `{{inputs.balance}}` as the primary value (currency `{{inputs.currency}}`, the input the `balance` field's `currencyCode` binds to) and a 3-row
    ledger of action labels, `lowBelow: 5` (the §8 Prepaid doc), for `take` **Charge** (`charge`), `add` **Top up**
    (`top_up`) and `set` **Set balance** (`set_balance`, Manager) (R19). A value
    success plays the buddy's `coins` beat (BM);
  - **Stamp card** (new, `templates/starter-stamp-card`) → holder `{{inputs.holder}}`; Loyalty: `progress` on
    `{{inputs.stamps}}` (integer 0-10), style `stamps` (the grid), goal 10 by default from the `take` **Redeem reward**,
    reward `{{inputs.reward}}`, caption **1 reward ready** at the goal; `add` **Add stamp** (`add_stamp`; staff step 1-5, default 1;
    the add stops at 10, SA 7.4). Add stamp plays `stamp` (the owner's "punches a stamp"), Redeem reward (`redeem_reward`) plays
    `punch` (BM §8). A new blueprint, so no pass is reissued;
  - the two are unmistakable in the gallery, on the pass and on the scan screen: Balance panel, money headline and
    `coins` against the stamp grid, "+1 stamp" and `stamp`. Palettes, strip images, icons and gallery tiles come from
    the template-identity designer (`scratchpad/template-identity/`); the stamp strip is one pre-rendered image per count,
    selected by `stamps`;
  - coupon → Offer;
  - generic → Membership without photo. Its `phone` and `wifiPassword` inputs are out of scope by name (1.11 rule 8);
    PT.3 also marks `phone` `x-widget: tel` so the rule doesn't rest on the name alone;
  - boarding pass and Henry's → defaults (no block).
- Baked templates stay read-only in the app (`TEMPLATE_BAKED`). Customizing a blueprint's display means **Use
  blueprint**, then editing the org's template.
- Adding `scan.display` to a blueprint is a display-only version: `build_key` unchanged, so no reissue (2.5).

### 2.4 Uploads and the versions endpoint (c)

- **Upload** (`import-pipeline.ts` → `analyzePackage`): `scan.display` travels inside `wallet.template.json`. The
  `MAX_MANIFEST_BYTES` 64 KB cap stays. The display has its own 16 KB cap (`SCAN_DISPLAY_TOO_BIG`).
  `validateManifest` calls `scanDisplayIssues(manifest, { passJson, assetNames })` after `scanIssues`; its errors block
  the upload like any manifest error, and its warnings go to the report.
- **Designer save** (`saveVersion`, `POST /api/v1/templates/{id}/versions`): unchanged route. The body's `manifest`
  carries the display; the same `analyzePackage` and dry run validate it. `dryRun: true` returns the issues as
  today. No new endpoint is needed: the editor renders previews in the browser with the same pure renderer (section
  6.6).
- `modules/templates/package/manifest-rules.ts`: `scan` (with `display`) is persisted and round-tripped like n7's
  `messaging`. It is not a `DATA_ROOT` and never reaches `pass.json`.

### 2.5 Versioning: a save makes a version, scanners pick it up, passes stay

Template versions are immutable rows keyed by a content hash, and passes pin `template_version`. Today any manifest
change makes every pass stale, and the stale job rebuilds them (metadata-only when `pass.json` is unchanged).

**The rules:**
1. **A save makes a template version.** Every designer save, upload or API save that changes `scan.display` creates
   a new immutable version, like any other manifest change. There is no separate display store and no draft on the
   server; the browser draft (n5 `drafts.ts`) is the only unsaved state.
2. **A display-only version activates on save.** When the new version's `build_key` equals the active version's, it
   can't change a pass, so the save activates it at once. The designer sends `activate: 'display-only'`; the server
   activates only when the build keys match and otherwise saves without activating, as today
   (`SaveVersionResponse.activated`, `displayOnly`). A save that also changes the pass keeps n5's explicit Activate.
3. **Scanners pick it up on the next scan.** The scanner reads `scan.display` from the template's **active** version
   (5.4), never from the pass's pinned version. A verdict already on screen doesn't change; the next `resolve` or
   action response carries the new display.
4. **Passes are untouched.** No rebuild, no `pass_versions` row, no outbox push, no APNs, no R2 write. Passes keep
   their pinned version.
5. **Rollback is activation.** Activating an older version brings its display back on the next scan, with the same
   no-reissue guarantee when the build keys match.

**How (templates module, c):**
1. `template_versions.build_key TEXT`: SHA-256 of what affects a built pass: `pass.json`, assets, and the manifest
   **without** `scan.display`, `description` and `previewOnlyAssets`. Computed in `persist.ts` on insert. Old rows stay
   `NULL` (the immutability trigger forbids a backfill, and `NULL` means "assume it differs", which is today's
   behaviour).
2. **Stale** means "pinned version's `build_key` differs from the active version's, or either is `NULL`".
   `countStalePasses` and `quietUnqueuedTemplates` compare build keys through a join on `template_versions`.
3. When the new active version has the same `build_key` as the passes' versions, the job sets `reissued_version` and
   moves nothing: passes keep their pinned version, their `pass.json` is identical, no `pass_versions` row, no
   outbox push, no R2 write.
4. `SaveVersionRequest.activate` accepts `true | false | 'display-only'`; `SaveVersionResponse` gains
   `displayOnly: boolean`. Audit: `template.version_created` and, when it activates, `template.version_activated`
   with `displayOnly: true`.
5. The doc's own `v` (6.5) versions the schema, not the content. A new template version can carry a migrated doc.

Result: editing the result screen during an event is safe and instant. The next scan on every scanner shows it.

### 2.6 Events: check-in logic, plus an optional staff note

Per-event display overrides are dropped (R10). The display lives in the template; events keep what they own today:
gates, windows, re-entry and counts.

| Candidate | Verdict | Why |
| --- | --- | --- |
| Event staff note | **Keep, optional** (`scan_events.note`, ≤ 140, plain text) | One night's instruction: "Wristbands at Gate C tonight", "Cash bar only". A template spans a season and many events; making this a template version would show it at every event |
| Event-specific panels or header | No | A design that differs per event is a different template, or a condition on `event.name` / an input. Two places to edit one screen is how screens drift |
| Hide panels for one event | No | Use `when` with `event.*` |
| Per-scanner display | No | A scanner's place is already `scanner.name` in scope; roles cover who sees what |

The note is edited in the event dialog (UA 6.2) and travels in `ScanSessionSchema.event.note`, not in `ScanDisplay`.
It shows on the Start panel, and in the notes slot on `heads_up` and `refused`, where staff have to act. It doesn't
show on `ok` (a 1.2 s glance) or desk `ready` (events are a door concept). If it is empty, nothing renders. If real
use shows it unused, it can go without touching the display model.

---

## 3. Bindings and rules

### 3.1 Scope

Display expressions use the template language (`expr.ts`): `{{path}}` or `{{path|filter}}`, one filter, no loops,
functions or arithmetic, bounded output. The scan display adds roots. A bare first segment that is a reserved root
resolves to the root; anything else is an input, so `{{tier}}` keeps working as in bindings. The editor always writes
`inputs.<name>`.

| Root | Fields | Source | Role |
| --- | --- | --- | --- |
| `holder` | `name`, `firstName` (the first word of `name`), `initials` | `scan.display.holder` evaluated over the inputs (2.2 default). Feeds the system holder line; usable in texts, and the only binding the band title takes, there after the name check of 1.3 (R16) | all |
| `inputs` | every input after defaults (`applyDefaults`) | `passes.personalization` | filtered by `x-scan`; secrets removed (1.11 rule 8) |
| `fields` | `<key>`: the front or back field's value **formatted as Wallet shows it** (`currencyCode`, `numberStyle`, `dateStyle`, `timeStyle`) | the pass's current `pass.json` | filtered per 1.11 rule 8: a field that references a hidden or secret input or any `pass.*` binding, or shows the barcode message, is absent; `value` only, never `attributedValue` |
| `pass` | `title`, `subtitle` (the list projection), `status`, `statusLabel`, `validFrom`, `validUntil` (`validityOf`), `createdAt`, `version`, `templateName`, `style`, `externalId` (desk and up) | pass row | as noted |
| `scan` | `outcome`, `reason`, `at`, `method`, `action.id`, `action.label`, `action.kind`, `amount`, `before`, `after`, `direction`, `previous.at`, `previous.where` | this request | all |
| `history` | section 1.10: visits, last visit, last scan, check-in state, the ledger per input | `scans`, `scan_gates` | all |
| `event` | `name`, `opensAt`, `closesAt`, `arrived`, `expected`, `capacity` | `ScanActor.event`, counts | all |
| `scanner` | `name`, `role` | `ScanActor` | all |
| `lookups` | the template's static tables | manifest | all |
| `now` | ms | `ctx.clock.now()` | all |
| `access` (11.4) | `plan`, `kind`, `zone`, `closesAt`, `nextOpenAt`, `until`, `hours`, `visits.used`, `.limit`, `.left` | `ScanOutcome.access` / `ScanCard.access`, the active version's plans | all; null on non-access templates |

**Reserved names.** An input called `holder`, `inputs`, `fields`, `scan`, `history`, `event`, `scanner`, `access` or `now` is
shadowed in display expressions. The validator warns (`SCAN_DISPLAY_SHADOWED`) and suggests `inputs.<name>`.
`pass` is already reserved (`INPUT_RESERVED`).

**`pass` in display ≠ `pass` in bindings.** In bindings, `pass` is `PassScope` (`scanCode`). In the display scope it is
the object above, and `pass.scanCode` is a `SCAN_DISPLAY_SECRET` error.

**`x-scan` input annotation** (inputs schema, beside `x-label`): `"x-scan": "desk" | "manager" | "hidden"`. Absent
means everyone who can scan sees it. `format: email | uri`, `x-widget: email | tel | url` and inputs used only as
barcode messages are secrets (1.11 rule 8), not `hidden`: they are out of scope for every role and no annotation can
bring them in. Inputs that are secret only by name (`wifiPassword`, `phone`) stay out until the author sets `x-scan`.
The designer's Inputs section gets a "Scanner" visibility control (`section-inputs.tsx`, n5, small) with Everyone,
Desk and up, Manager and Hidden; for a secret input the control is replaced by the line "Never shown on scanners", and
for a name-matched one it defaults to "Never shown on scanners" with **Show on scanners** to opt in.

### 3.2 Conditions

Display conditions extend the manifest's `Condition` with paths and comparisons. `{ input: 'tier', eq: 'VIP' }` stays
valid (sugar for `{ path: 'inputs.tier', ... }`).

```ts
type Cond =
  | { path: string; eq?: Json; in?: Json[]; empty?: boolean;
      gt?: number; gte?: number; lt?: number; lte?: number;
      daysFromNow?: { gt?: number; gte?: number; lt?: number; lte?: number } }
  | { input: string; eq?: Json; in?: Json[]; empty?: boolean }
  | { all: Cond[] } | { any: Cond[] } | { not: Cond };
```

- One operator per leaf. Numeric operators coerce numeric strings and are false on non-numbers.
- `daysFromNow` is `(value − now) / 1 day` in the actor's time zone, calendar-based; negative is past. "Expires within
  30 days": `{ path: 'pass.validUntil', daysFromNow: { gte: 0, lte: 30 } }`. "Hasn't visited in 30 days":
  `{ path: 'history.lastVisit.at', daysFromNow: { lt: -30 } }`.
- A missing path is empty: `eq` and comparisons are false, `empty: true` is true.
- Depth ≤ 4, leaves ≤ 12 per condition.

### 3.3 Variants (header rules)

```ts
interface Variant {
  id: string;
  name: string;            // editor label, 24; never rendered
  when: Cond;
  header: { icon?: ScanIcon | null; title?: Text | null; subtitle?: Text | null; chips?: Chip[] };
}
```

- Evaluated in order; the first whose `when` holds wins. Its set slots override the base header; unset slots fall
  through to the base, then to the system. `null` explicitly clears a base slot.
- ≤ 8 variants. A variant can't add panels. Conditional content is the panel's or row's own `when`. The editor can
  offer "Add a card for this rule", which copies the variant's condition into the new panel's `when`. One condition
  language, two places, no hidden coupling.
- The rendered display reports `variant: id | null`, for the editor preview and for tests.

Owner's example, "when tier = VIP, use the crown icon, a gold chip VIP and the card Lounge access · Table 12":

```jsonc
"variants": [{
  "id": "vip", "name": "VIP",
  "when": { "path": "inputs.tier", "eq": "VIP" },
  "header": { "icon": "crown", "chips": [{ "id": "c_vip", "text": "VIP", "tone": "gold", "icon": "crown" }] }
}],
"panels": [{
  "id": "p_lounge", "preset": { "id": "access", "v": 1 }, "title": "Access", "icon": "key",
  "when": { "path": "inputs.tier", "eq": "VIP" },
  "rows": [
    { "id": "r_lounge", "type": "list", "items": [
      { "id": "i_lounge", "icon": "armchair", "text": "Lounge access" },
      { "id": "i_table", "icon": "utensils", "text": "Table {{inputs.table}}" } ] }
  ]
}]
```

### 3.4 Escaping and lengths

- Filters `html` and `url` are errors in display texts (`SCAN_DISPLAY_FILTER`): output is plain text, so escaping would
  show `&amp;`.
- Expression length ≤ 256 characters, ≤ 8 interpolations per text (tighter than `EXPR_LIMITS`).
- Literal text over its cap is an error at save. Bound text over its cap is truncated at render (1.11 rule 9).
- Rendered output never contains `{{`: an unclosed or unknown path yields empty, which hides the element. Staff never
  see unbound syntax.

### 3.5 Labels and language

- Author text is one language per template in v1, the template's default (as `pass.json`). System copy (verdicts,
  captions such as "1 reward ready", "Changed elsewhere", "No photo", relative dates) comes from `SCAN_COPY` and
  `Intl` in the scanner's locale.
- Reserved for later, additive: `scan.display.strings: { [locale]: { [key]: string } }` and a `t` root
  (`{{t.lounge}}`), resolved by the scanner's locale with fallback to the default. Nothing in v1 blocks it.

---

## 4. Icons and images

### 4.1 The curated set (42)

2026-11-05: `infinity` (Lucide `Infinity`) and `clock` (`Clock3`) join for the Access card's plan chips (P0-7).

Stored as our own kebab-case ids in `SCAN_ICONS` (`src/passkit/template/scan-display/icons.ts`), each mapped to a Lucide 1.58
component in `src/web/scan/display/icons.ts`. Ids, not Lucide names, so a Lucide rename never breaks a stored
template.

| Group | Ids (Lucide component) |
| --- | --- |
| People and status (8) | `user` (User), `users` (Users), `child` (Baby), `accessible` (Accessibility), `id-card` (IdCard), `crown` (Crown), `star` (Star), `gem` (Gem) |
| Recognition (4) | `award` (Award), `medal` (Medal), `trophy` (Trophy), `sparkles` (Sparkles) |
| Event and access (9) | `ticket` (Ticket), `door-open` (DoorOpen), `armchair` (Armchair), `map-pin` (MapPin), `mic` (Mic), `music` (Music), `parking` (SquareParking), `key` (Key), `cloakroom` (Luggage) |
| Food and drink (6) | `coffee` (Coffee), `utensils` (Utensils), `wine` (Wine), `cake` (Cake), `vegetarian` (Leaf), `gluten-free` (WheatOff) |
| Loyalty and money (7) | `gift` (Gift), `stamp` (Stamp), `coins` (Coins), `wallet` (Wallet), `card` (CreditCard), `percent` (Percent), `tag` (Tag) |
| Fitness and care (3) | `dumbbell` (Dumbbell), `pool` (Waves), `health` (HeartPulse) |
| Notes and time (3) | `info` (Info), `hand` (Hand), `calendar` (CalendarDays) |

All 40 exist in `lucide-react` 1.58.0 (checked). Excluded on purpose: every check, triangle, octagon, X, ban, clock,
hourglass, lock and cloud shape (verdict and system glyphs, UD 3.2), and `Ticket`'s check variant.

**Why no uploads:**
- One stroke weight, grid and optical size with the rest of the kit.
- No SVG sanitizing on the hot path, and no third-party URLs (SSRF, tracking, CSP).
- A verdict look-alike can't sneak in.
- The set loads lazily with the result chunk: about 40 × 350 B ≈ 5 kB gzip, measured against the 25 kB `result`
  budget (SA 13.2).

Adding an icon is a one-line, additive code change. Removing one is a breaking change: the validator would error on
templates that use it, so ids are only ever deprecated, and render as `info`.

### 4.2 Images

| Source | What | Rules |
| --- | --- | --- |
| `photo` (identity setting, not a row) | the pass's own `thumbnail` override (per-pass asset, `passes/assets.ts`) | Only when the doc sets `photo` and its `minRole` admits the role. Replaces the pass tile in the identity row. Served by the scanner asset route (SA 5.1: a scan of this pass by this actor in the last hour). `alt` "Photo of {holder.name}". Missing → initials + **No photo** chip |
| `thumbnail` | the per-pass override, else the template's `thumbnail` | same route |
| `strip` | the per-pass `strip`, else the template's | same route; banner 3:1, decorative (`alt=""`) |

- Rendered sizes are the screens workstream's (BF: the photo at 96 px r 18 in the identity row on a phone, 128 px on
  iPad; the thumbnail row at 72 px on a phone and 96 px on iPad). The asset route serves `@2x`/`@3x`; nothing is fetched from outside.
- No image inputs, no URLs from inputs, no `data:` URIs. A future image input would be a new source id, under the same
  route and guard.
- Privacy: `photo.minRole` works like any element's. Lookup rows (`ScanLookupRowSchema.photoUrl`) show the photo
  only when the template's display sets `photo` for that role.

---

## 5. Server rendering

### 5.1 Pipeline (`modules/scan/display.ts`, calls pure passkit code)

```
outcome decided (SA 2.6 / 8.4)
 → screen = ready | ok | heads_up | refused        (system screens: display = null)
 → doc = compiledDisplay(template active version)  (cached, 5.4)
 → drop elements with minRole > role               (role filter on the doc, 5.2)
 → scope = buildScope(actor.role, needs)           (role filter on the data, 5.2, 5.3)
 → identity = holder line (always), photo flag     (system slots, filled from the doc's sources)
 → refused: identity + notes.refused, stop
 → variant = first variant whose when holds
 → header = variant ∪ base ∪ system nulls; heads_up drops icon/title
 → panels = filter(on ∋ screen, actions ∋ action, when) → render rows → drop empty
          → first 2 (first 1 when the request opens an amount control)
 → group rows get oneLine                          (1.6 width table)
 → cut trailing rows, then panels, to the screen's capacity (1.6 render time)
 → sanitize, cap, truncate                          (1.11 rule 9)
 → ScanDisplay (zod-checked in tests, not on the hot path)
```

`renderScanDisplay(doc, scope, { screen, role, locale, timeZone, now })` is pure and lives in
`src/passkit/template/scan-display/render.ts`. The worker only builds the scope.

### 5.2 Role filtering happens first

1. `minRole` on panels, rows, items and chips is applied to the **doc** before evaluation. A desk-only row's
   expressions never run for a Door scanner.
2. The **scope** is built for the role: `inputs` loses `x-scan` inputs above the role and every secret input; `fields`
   loses fields bound to them; `pass.externalId` is desk and up.
3. An expression that reads a removed path resolves empty, so its element hides (strict missing values). There is no
   way to "leak by binding": a Door title `{{inputs.email}}` renders as the system title.
4. Terminals (`kind: 'terminal'`, SA 2.4 "summary only") get the identity, `header` and notes, no panels.
5. The same function runs in the editor preview with a sample scope (6.6) and the chosen role, so "Door hides this
   row" in the editor is the server's behaviour, not a simulation.
6. **Audiences beyond scanners** (2026-11-05): a Desk monitor renders with its audience (`door` or `desk`) through
   these same steps; a Customer screen uses the separate customer path of section 11, never `renderScanDisplay` with a
   lower role.

### 5.3 Static `needs` and cost

Compiling a doc records what it reads: `needs = { fields: bool, photo: bool, history: Set<'lastVisit' | 'visits' |
'value:<input>' | 'ledgerMonth:<input>' | 'scans'>, event: bool }`. `buildScope` only queries what `needs` lists:

| Need | Extra work | Round trips |
| --- | --- | --- |
| none (header from inputs only) | none | 0 |
| `fields` | the current `pass.json` from the current `pass_versions` row (the card already loads it for `passView`) | 0 on resolve; +1 statement in the existing batch on the door fast path |
| `history.*` | ≤ 4 statements (`lastVisit`, a `visits` count with conditional sums, `value` rows, a ledger month sum) | 0: added to the card/counts batch |
| `event` | counts are already in every answer | 0 |

The door check-in target (p95 ≤ 150 ms, SA 13.1) holds. A doc that needs history on the fast path adds statements, not
round trips. Rendering is CPU-only, targeted under 1 ms; a test asserts it under 5 ms for the worst-case doc.

### 5.4 Which version, and caching

- The candidate query joins `templates` for `active_version` (no extra round trip). The display comes from that
  version's manifest.
- `compiledDisplay(templateId, version)`: an isolate-level LRU (64 entries) of parsed, validated and compiled docs.
  Versions are immutable, so entries never go stale; a new active version is a new key.
- Rendered displays are never cached: they hold holder data and are per role. Scan routes stay `no-store`. Replays
  (`replay: true`, SA 7.2) re-render with current data, like the card.
- Template mid-event: a scanner picks up a new display on its next request. A verdict already on screen doesn't
  change. An open desk card keeps its display until the next resolve or action, whose response carries the new one;
  the client crossfades when `templateVersion` changes (UK 6.4 version crossfade).

### 5.5 Rendered contract (`src/shared/contracts/scan-display.ts`, n8)

```ts
ScanIconSchema    = enum [...SCAN_ICONS]                       // 40 ids, section 4.1
ScanToneSchema    = enum ['neutral', 'teal', 'violet', 'gold']
ScanNoteToneSchema= enum ['neutral', 'info', 'attention']
ScanChipSchema    = { id: string, text: string 1..16, tone: ScanToneSchema, icon: ScanIconSchema | null }

ScanDisplayRowSchema = discriminatedUnion('type', [
  { type: 'heading',  id, text: string ≤ 24, detail: string ≤ 24 | null },
  { type: 'field',    id, label: string ≤ 20, value: string ≤ 48, icon: ScanIcon | null, strong: boolean },
  { type: 'big',      id, label: string ≤ 20 | null, value: string ≤ 12, unit: string ≤ 12 | null, tone: ScanTone | null },
  { type: 'columns',  id, size: 'big' | 'normal', oneLine: boolean,
                      items: { label: string ≤ 12, value: string ≤ 8 (big) | ≤ 16 (normal) }[] 2..4 },
  { type: 'progress', id, value: number, goal: int 1..1000, before: number | null, style: 'stamps' | 'bar',
                      icon: ScanIcon | null, rewards: int, caption: string ≤ 48 },
  { type: 'money',    id, label: string ≤ 20 | null, amount: number, currency: string /^[A-Z]{3}$/ | null,
                      text: string ≤ 16, before: number | null, change: number | null, low: boolean,
                      pending: string[] ≤ 6 },
  { type: 'history',  id, items: { at: number | null, when: string | null, amount: string | null,
                      delta: number | null, where: string | null, label: string | null, elsewhere: boolean }[] ≤ 6,
                      empty: string | null },                 // "No visits yet."
  { type: 'image',    id, source: 'thumbnail' | 'strip', url: string | null, alt: string,
                      title: string ≤ 32 | null, detail: string ≤ 40 | null },
  { type: 'chips',    id, items: ScanChipSchema[] 1..4 },
  { type: 'list',     id, pair: boolean, oneLine: boolean,
                      items: { id, icon: ScanIcon, text: string ≤ 32, detail: string ≤ 24 | null }[] 1..4 },
  { type: 'note',     id, text: string ≤ 140, tone: ScanNoteToneSchema, icon: ScanIcon | null },
  { type: 'divider',  id },
])
ScanDisplayPanelSchema = { id, kind: enum [...PRESET_IDS, 'custom'], title: string ≤ 24 | null,
                           icon: ScanIcon | null, tone: ScanTone | null, rows: ScanDisplayRowSchema[] 1..6 }
ScanDisplaySchema = {
  v: literal 1,
  screen: enum ['ready', 'ok', 'heads_up', 'refused'],
  templateVersion: string,
  variant: string | null,
  identity: {                                                  // system slots, filled from the doc's sources
    holder: string ≤ 40,                                       // always set: holder.name, else the pass title
    initials: string ≤ 2,
    photo: { url: string | null, alt: string } | null,         // null: show the pass tile
  },                                                           // always set: an unknown pass has no display at all
  header: { icon: ScanIcon | null, title: string ≤ 28 | null, titleLines: 1 | 2, meta: string ≤ 60 | null,
            chips: ScanChipSchema[] ≤ 2 },                     // ok: all; ready/heads_up: meta, chips; refused: none
  panels: ScanDisplayPanelSchema[] ≤ 2,                        // [] on refused
  notes: { staff: string ≤ 140 | null, refused: string ≤ 100 | null },
}
```

- `null` in a header slot means "use the system copy" (`meta: null` → the pass subtitle). The client never
  substitutes anything else.
- The verdict band, flags, the action area and the event note are not in `ScanDisplay`. They come from
  `ScanOutcome` (`kind`, `reason`, `SCAN_COPY`), `ScanCard.flags`, the template's actions and
  `ScanSessionSchema.event.note`. That is the system/template split in the contract itself.
- The contract carries no geometry, colour value or size. A direction change is a client change (R1).
- The result card paints `ScanOutcome.display`; `ScanCard.display` is the desk panel's (1.11 rule 13). A mode
  mismatch has `display: null` and `card: null`; its compact row shows `ScanOutcome.template.name` (SA 4.2) and
  nothing from the pass (R18).
- `contracts/scan-display.ts` imports only `SCAN_ICONS` from passkit. The authored schemas (`schema.ts`) are imported
  directly by the worker, `tools/` and the designer, never through a contract, so `/scan` never bundles them.

### 5.6 Errors and logs

| Code | Level | When |
| --- | --- | --- |
| `SCAN_DISPLAY_RENDER` | error | the renderer threw. Logged with `templateId`, `version`, element `id`; never a value |
| `SCAN_DISPLAY_INVALID` | error | a stored active version fails `scanDisplayIssues` (should be impossible; a bad baked deploy) |

Rendered strings are never logged (they hold holder data). The suite-wide log check (SA 14.1) gains a rule: no log
line contains a rendered display string from the fixtures.

---

## 6. The document model for the editor

### 6.1 Shape (`src/passkit/types.ts`, a2)

The types are `z.infer` of the schemas in 6.2, re-exported from `src/passkit/types.ts` so passkit callers don't import
zod.

```ts
export type ScanIcon = (typeof SCAN_ICONS)[number];
export type Tone = 'neutral' | 'teal' | 'violet' | 'gold';
export type PresetId = 'membership' | 'loyalty' | 'balance' | 'ticket' | 'offer' | 'access' | 'details' | 'note';
export type DisplayScreen = 'ready' | 'ok' | 'heads_up';      // refused takes no panels

interface Element { id: string; when?: Cond; minRole?: ScanRole }

export interface ScanDisplayDoc {
  v: 1;
  holder?: string;                        // Expr: source of the system holder line; default 2.2
  photo?: { minRole?: ScanRole };         // present: the member photo replaces the pass tile
  currency?: string;                      // Expr or ISO code
  header: { icon?: ScanIcon | null; title?: Text | null; subtitle?: Text | null; chips?: Chip[] };
  variants?: Variant[];                   // ≤ 8
  panels?: Panel[];                       // ≤ 6
  notes?: { staff?: Text | null; refused?: string | null };
}
export interface Chip extends Element { text: Text; tone: Tone; icon?: ScanIcon }
export interface Panel extends Element {
  preset?: { id: PresetId; v: number };
  title?: Text; icon?: ScanIcon; tone?: Tone;
  on?: DisplayScreen[]; actions?: string[];
  rows: Row[];
}
export type Row = Element & { slot?: string } & (
  | { type: 'heading'; text: Text; detail?: Text }
  | { type: 'field'; label: Text; value: Text; icon?: ScanIcon; strong?: boolean; whenEmpty?: 'hide' | 'dash' }
  | { type: 'big'; label?: Text; value: Text; unit?: Text; tone?: Tone }
  | { type: 'columns'; size?: 'big' | 'normal'; items: { id: string; label: Text; value: Text }[] }   // 2-4
  | { type: 'progress'; value: string; goal?: string | number; reward?: Text; rewards?: string;
      icon?: ScanIcon; style?: 'auto' | 'stamps' | 'bar' }
  | { type: 'money'; label?: Text; amount: string; currency?: string; lowBelow?: number; pending?: string[] }
  | { type: 'history'; source: 'value' | 'visits' | 'scans'; input?: string; limit?: number;
      show?: ('amount' | 'when' | 'where' | 'action')[] }
  | { type: 'image'; source: 'thumbnail' | 'strip'; title?: Text; detail?: Text }
  | { type: 'chips'; items: Chip[] }
  | { type: 'list'; pair?: boolean; items: (Element & { icon: ScanIcon; text: Text; detail?: Text })[] }
  | { type: 'note'; text: Text; tone?: 'neutral' | 'info' | 'attention'; icon?: ScanIcon }
  | { type: 'divider' }
);
```

Shape choices for a visual editor:
- **Flat and uniform.** Three levels only: doc → panel → row (→ items for `columns`, `chips`, `list`). Every element
  has `id`, `when`, `minRole`, so one "Show when" control and one "Who sees it" control serve all of them.
- **Stable ids**, generated by the editor (`p_` panel, `r_` row, `i_` item, `c_` chip, `v_` variant + 4 base36
  chars). Undo, reorder, selection, variant references and preset upgrades key on them. Ids are unique in the doc.
- **Every editor op is one JSON op**: insert at index, move, remove, set a field. That matches n5's ops model
  (`apply.ts`, one undo step each).
- **Order is meaning.** Arrays define render order and, for variants, priority. No z-index, no grid positions. The
  designer decides geometry per row type.
- **No free styling.** No colours, sizes, fonts or spacing in the doc. Tone is one of four tokens.
- **Nothing system-owned is addressable.** The doc has no key for the tint, band, verdict sub, holder line text,
  pass tile, flags, actions or buddy. `holder` and `photo` choose the *source* of two system slots, not whether they
  show.

### 6.2 The manifest schema: zod names, validation and limits

**Where.** `src/passkit/template/scan-display/schema.ts` (a2 reviews, n8 writes). It is passkit's first zod use (zod
4.6.7 is already a dependency). The worker, `tools/build-templates.ts` and the designer import it directly;
`src/shared/contracts/scan-display.ts` (the rendered contract) imports only `icons.ts`, so the `/scan` bundle never
carries the authored schemas (5.5). `SCAN_ICONS` lives in
`src/passkit/template/scan-display/icons.ts` (ids only, no React) and the web map in `src/web/scan/display/icons.ts`.

**Authored schemas** (`.strict()` objects, so an unknown key is `SCAN_DISPLAY_SHAPE`):

| Schema | Validates |
| --- | --- |
| `ScanDisplayDocSchema` | the whole `scan.display` block; `v: z.literal(1)` |
| `ScanTextSchema` | `string` ≤ 512, or `{ count, one, other, zero? }` |
| `ScanExprSchema` | a string ≤ 256 that `checkExpr` accepts (refinement), ≤ 8 interpolations |
| `ScanCondSchema` | `z.lazy` union of the leaf, `input` sugar, `all`, `any`, `not` (3.2) |
| `ScanElementSchema` | `id` (`^[a-z][a-z0-9_]{0,23}$`), `when?`, `minRole?` |
| `ScanChipDocSchema` | a header or row chip |
| `ScanVariantSchema` | a header rule (3.3) |
| `ScanRowDocSchema` | `z.discriminatedUnion('type', [...])`, one member per row type in 1.6 |
| `ScanPanelDocSchema` | a panel, `rows` 1-6, `on` subset of `ready`, `ok`, `heads_up` |
| `ScanPhotoSchema` | `{ minRole? }` |
| `ScanIconIdSchema`, `ScanToneSchema`, `ScanPresetIdSchema` | enums |

`ManifestScanSchema` (SA 4.1) gains `display: ScanDisplayDocSchema.optional()` and loses `values` and `identity`.

**Validation, in order** (`scanDisplayIssues(manifest, { passJson, assetNames })`, pure, the same in the browser,
the worker and `tools/build-templates.ts`):
1. Size: the serialized block ≤ 16 KB (`SCAN_DISPLAY_TOO_BIG`), checked before parsing.
2. `ScanDisplayDocSchema.safeParse`: zod issues map to `SCAN_DISPLAY_SHAPE`, `_VERSION`, `_ICON`, `_TONE`, `_ID`
   (format), `_TOO_MANY` (array bounds), each with its JSON path (`scan.display.panels.1.rows.0.items`).
3. Semantic rules on the parsed doc: duplicate ids, literal text caps, expressions and filters, secrets, conditions,
   action and input references, placement, density, currency, then the warnings.
4. Errors block an upload and a save (the dry run returns them). Warnings go to the validation report and the
   designer's Issues list.

**Limits:**

| Item | Limit |
| --- | --- |
| Doc size | 16 KB serialized (inside the manifest's 64 KB) |
| Variants | 8; header chips per variant 2 |
| Panels defined / shown | 6 / 2 (1 while an amount control is open) |
| Rows per panel | 6 |
| Density (compact width, worst case) | rows ≤ 5 units per panel; ≤ 6 units per result with 1 unit per panel frame, minus the header cost (1.6); an error on `ok`, a warning (render-time cut) on `heads_up` and `ready` |
| Items | `columns` 2-4, `chips` 1-4, `list` 1-4 |
| `history.limit` | 1-5 (+1 "Changed elsewhere") |
| `progress.goal` | 1-1000 (stamps style when ≤ 20) |
| Texts | caps in 1.3, 1.4, 1.6 |
| Expressions | 256 chars, 8 interpolations |
| Conditions | depth 4, 12 leaves |
| Ids | `^[a-z][a-z0-9_]{0,23}$`, unique |

"Two panels that can show together": the validator can't solve conditions, so on `ok` it checks every pair of panels
whose `on` sets include `ok` (per action when `actions` differ). Authors who need a dense pair make their conditions
exclusive through `on` or `actions`, or accept the warning `SCAN_DISPLAY_PANELS_HIDDEN` (more than 2 panels can be
visible; later ones are cut at render). `heads_up` and `ready` are checked the same way but only warn
(`SCAN_DISPLAY_CUT`), since the renderer cuts there.

### 6.3 Validation codes

Errors block upload and save:
`SCAN_DISPLAY_SHAPE`, `SCAN_DISPLAY_VERSION` (unknown `v`), `SCAN_DISPLAY_TOO_BIG`, `SCAN_DISPLAY_TOO_MANY`,
`SCAN_DISPLAY_ID` (bad or duplicate), `SCAN_DISPLAY_ICON` (not in the set), `SCAN_DISPLAY_TONE`,
`SCAN_DISPLAY_TEXT_LENGTH` (literal over its cap), `SCAN_DISPLAY_EXPR` (from `checkExpr`), `SCAN_DISPLAY_FILTER`
(`html`, `url`, unknown), `SCAN_DISPLAY_SECRET`, `SCAN_DISPLAY_DENSITY`, `SCAN_DISPLAY_PLACEMENT` (1.6 rules),
`SCAN_DISPLAY_HOLDER` (`holder` isn't one path to a string), `SCAN_DISPLAY_TITLE` (`header.title` binding
anything but `holder.firstName` or `holder.name`, a filter, a literal part over 28 graphemes or 20 beside a name, a
verdict word in the literal part, or a name token while `holder` is `pass.title`, the pass-title fallback or an
input with `enum`), `SCAN_DISPLAY_ACTION` (unknown action id in `actions` or
`pending`), `SCAN_DISPLAY_HISTORY_INPUT` (`source: 'value'`
or a `history.ledger.<input>` path on an input no action changes), `SCAN_DISPLAY_GOAL` (no goal and no `take`
action), `SCAN_DISPLAY_CONDITION` (shape, depth), `SCAN_DISPLAY_CURRENCY` (a literal that isn't ISO 4217).

Warnings: `SCAN_DISPLAY_PATH` (unknown root, input or field key), `SCAN_DISPLAY_SHADOWED`, `SCAN_DISPLAY_CUT`
(`heads_up` or `ready` can exceed its capacity, so trailing rows are cut there), `SCAN_DISPLAY_ROLE_CONDITION` (a
`when` reads an input above the element's own `minRole`, so that role never meets it),
`SCAN_DISPLAY_TYPE` (`progress`/`money` bound to a non-number input), `SCAN_DISPLAY_PANELS_HIDDEN`,
`SCAN_DISPLAY_VARIANT_UNREACHABLE` (a variant after one whose `when` is always true), `SCAN_DISPLAY_VERDICT_WORD`,
`SCAN_DISPLAY_IMAGE` (`photo` set on a template whose passes can't have a thumbnail override, or a `thumbnail` /
`strip` row with no such asset), `SCAN_DISPLAY_ROLE_EMPTY` (an element visible to Door that only binds desk-only
inputs, so it always hides for Door), `SCAN_DISPLAY_COLUMNS_WRAP` (a literal `columns` value longer than the
compact one-line cap, so the row always wraps on a phone).

### 6.4 Presets: factories, tags and upgrades

- `PRESETS: Record<PresetId, { v: number; slots: PresetSlot[]; build(manifest, mapping): Panel }>` in
  `src/passkit/template/scan-display/presets.ts`.
  `PresetSlot = { name, accepts: 'text' | 'number' | 'date' | 'image' | 'history', hints: string[], optional }`.
  `hints` drive the editor's auto-mapping (input names and `x-label`s such as `seat`, `row`, `gate`, `stamps`,
  `balance`, `tier`).
- `build` writes rows with `slot` tags and the panel's `preset: { id, v }`. After that the panel is ordinary data:
  editing, adding or removing rows needs no preset logic.
- **Upgrades.** Presets never rewrite stored docs. When `PRESETS[id].v` is newer than a panel's, the editor can offer
  "Use the new layout". It re-runs `build` with a mapping recovered from the `slot`-tagged rows' bindings, keeps
  untagged (author-added) rows at the end, and shows the diff as one undo step. Rendering doesn't depend on presets,
  so an upgrade is never needed for correctness.
- **Primitive changes** are design-system changes and apply to every template at once. They are additive only: new
  optional fields with defaults, new row types. A renderer that meets an unknown row type skips it (forward
  compatibility during a rollback); the validator refuses it at save.

### 6.5 Schema versioning

- `v: 1` on the doc. A breaking change bumps it and ships `migrateScanDisplay(doc) → latest` (pure), applied when a
  version is read, like `scanOf` defaults. Stored versions are immutable, so migration is always at read. The editor
  saves the latest `v`.
- The validator refuses a `v` it doesn't know (`SCAN_DISPLAY_VERSION`), so an upload built for a newer platform fails
  loudly instead of rendering partly.

### 6.6 Preview inputs the model supports

The editor (section 10) renders with the same pure `renderScanDisplay` in the browser. The model takes:
- `screen`: ready, ok, heads_up, refused;
- `actionId` (for `on` / `actions` / `scan.*`);
- `role`: door, desk, manager, terminal;
- a sample scope: `manifest.sample` inputs, plus `sampleHistory()` (last visit 2 days ago, 6 visits this month, three
  transactions, one "Changed elsewhere"), a sample event and scanner, all labelled as samples in the editor;
- overrides per input, so an author can flip `tier` to VIP and watch the variant switch.

The renderer imports nothing from the worker, and the scanner bundle never includes it (`check-bundle` forbids the
marker `renderScanDisplay` in the `/scan` chunks). The scanner only paints `ScanDisplay`.

---

## 7. Deltas, migration and tests

### 7.1 Against `scanner-architecture.md`

| SA section | Change |
| --- | --- |
| 0 | add decisions 1, 2, 6, 7, 9 and 13 of this file, and R1-R14 |
| 3.1 | `modules/scan/display.ts` (scope, needs, call the renderer), `modules/scan/repo-history.ts` (SQL) |
| 3.2 | `src/passkit/template/scan-display/{schema,validate,scope,condition,format,render,presets,defaults,needs}.ts` (a2 reviews, n8 writes, like `scan.ts`); `icons.ts` (ids); `src/shared/contracts/scan-display.ts` (rendered contract, imports the passkit schema) |
| 3.3 | `src/web/scan/display/` (panel, one component per row type, icons, chip, notes), loaded in the `result` chunk; the designer imports the same components for its preview |
| 4.1 | `ScanManifest`: remove `values`, `identity`; add `display?: ScanDisplayDoc`. `scanOf` gains `displayOf(manifest, passJson)` (2.2). Inputs annotation `x-scan` |
| 4.2 | `ScanCardSchema`: remove `identityFields`, `photoUrl` (now `display.identity`); add `display: ScanDisplaySchema`. `values` stays as system data for pickers and headline subs, derived from action inputs (`label` from `x-label`, `goal` from a `take` amount). `ScanOutcomeSchema`: add `display: ScanDisplaySchema \| null` (null for system screens and when the pass is unknown: no template, so no `notes.refused`, and refused bodies for unknown codes stay byte-equal across orgs). `ScanSessionSchema.event` gains `note`. `ScanLookupRowSchema.photoUrl` follows 4.2. `ScanOutcomeSchema` gains `template: { name, style } \| null` (set when a pass was found, the only identity on a mode mismatch, R18) |
| 4.3 | `ScanEventSchema`, `CreateScanEventSchema`, `UpdateScanEventSchema` gain `note: PlainTextSchema(140) \| null` |
| 6.1 (`0014_scan.sql`, unmerged, n8) | `scan_events.note TEXT CHECK (note IS NULL OR length(note) <= 140)`; `CREATE INDEX scans_pass_ok ON scans (pass_id, action_kind, at DESC) WHERE outcome = 'ok';` |
| 6.2 | rows: history (`scans_pass_ok`), last visit (`scans_pass_ok`) |
| 8.3 step 4 | build the card's `display` (screen `ready`) |
| 8.4 step 8 | build `display` for the outcome's screen with post-effect values |
| 9.2 (v2 offline) | queued check-ins show no custom content; the roster stays hash-only |
| 11, Templates | display-only versions don't reissue and activate on save (`build_key`, 2.5); the active version supplies the display. `SaveVersionRequest.activate` gains `'display-only'`, `SaveVersionResponse` gains `displayOnly` |
| 13.1 | display adds no round trips (5.3) |
| 13.2 | `result` chunk: + display components and 40 icons, estimated 6-8 kB gzip inside its 25 kB |
| 14 | tests in 7.3 |
| 16.3 | `modules/templates/{persist,repo-stale,versions}.ts` (c): `build_key`, display-only activation; `admin/templates/designer/*` (n5): Inputs "Scanner" visibility and the Scan screen mode (section 10) |
| 7.5 (client machine) | B's card layer and camera-live rules are the screens workstream's; the display adds nothing to the machine except "1 panel while an amount control is open" |
| UA 6.2 | event dialog: **Note for staff** field |
| UK 3.1, 6.4 | identity (holder line, photo) and panels on the desk card come from the display; values and headlines stay `SCAN_COPY` |
| UD 3, UK 6 copy | unchanged and binding: "+2 stamps", "Voided Nov 3.", milestones without words (R9) |

### 7.2 Migrations

| File | Owner | Content |
| --- | --- | --- |
| `0014_scan.sql` (n8, not merged yet) | n8 | `scan_events.note`; index `scans_pass_ok` |
| `00NN_templates_build_key.sql` (next free number) | c | `ALTER TABLE template_versions ADD COLUMN build_key TEXT;` and `CREATE INDEX template_versions_build ON template_versions (template_id, build_key);`. No backfill (immutability trigger); `NULL` behaves as today |

No table stores rendered displays. `scans` rows stay free of holder data.

### 7.3 Tests

**Unit (passkit, pure):**
- One case per validation code in 6.3. Every preset's `build` output validates for every blueprint.
- Renderer, per row type: values, caps, truncation by grapheme (emoji, combining marks), strict missing values,
  `whenEmpty: 'dash'`, plurals (en `one`/`other`, a `zero` form), every filter in two time zones across a DST change,
  `day` and `ago` edges (midnight, year boundary).
- Safety: `heads_up` and `refused` never emit a custom icon or title; `refused` emits no meta line, chips or panels;
  `identity.holder` is never empty when the pass is known; `ok` with a
  custom icon still reports the screen (the client draws the badge); no output string contains `{{`; secrets are
  absent from scope for every role, and binding one is a validator error; the generic blueprint's `phone` and
  `wifiPassword`, a `uri` input and a back field that interpolates `pass.scanCode` are all out of scope; a title that
  binds an input or a field, or has a verdict word in its literal part, is `SCAN_DISPLAY_TITLE`; "Welcome back,
  {{holder.firstName}}" saves, renders with `titleLines: 2`, costs 1 more unit and shows the system headline when the
  name is empty; a name token with `holder` on `pass.title`, on the pass-title fallback or on an `enum` input is
  `SCAN_DISPLAY_TITLE`; at render, holder names "Refunded", "not valid", "VOID 2", "Ana Maria de la Cruz" (4 words),
  `https://x.io` and a bidi-override name each give the system headline, while "Maya", "José", "O'Neil",
  "Anne-Marie" and "李小龙" render; a `holder` with literal text is `SCAN_DISPLAY_HOLDER`.
- Density: the header costs of 1.6 per screen; `ok` over capacity is an error; the render-time cut drops trailing
  rows then panels, never the first row, and is deterministic (the blueprint's `heads_up` keeps Seat and Ticket).
- Roles: a desk-only input in the meta line renders the pass subtitle for Door; `minRole` rows vanish; terminals get no
  panels.
- Variants: first match wins, `null` clears, fall-through to base and system.
- Panels: `on`, `actions`, `when`, the 2-panel cut, the 1-panel cut with an amount control, empty-panel drop.
- Group rows: `oneLine` for 2, 3 and 4 `columns` items at each cap boundary (4 vs 5 graphemes for 4 big items),
  `list.pair`, and the density of a 4-item `columns` counted as 3 units.
- Schema: every row type round-trips through `ScanRowDocSchema`; unknown keys are `SCAN_DISPLAY_SHAPE` with the
  right path; `columns` with 5 items and `image` with `source: 'photo'` are refused.
- Defaults: `defaultScanDisplay` for every blueprint and Henry's (snapshots).
- Property test: 1,000 random docs within limits → `ScanDisplaySchema.parse` passes, density holds, render under
  5 ms.

**Worker (`vitest-pool-workers`):**
- `resolve` and `actions` return `display` for each screen; refused bodies for unknown codes stay byte-equal across
  orgs (SA 14.1 snapshot includes `display: null`).
- History: transactions exclude undone scans; "Changed elsewhere" appears after an admin edit; visits per month
  follow the actor's time zone; retention bounds; `where` for a removed scanner and for an admin session.
- Cost: a counting D1 wrapper proves a door check-in with a header-only doc and with a history doc both keep SA
  13.1's round-trip counts.
- Version: saving a display-only version with `activate: 'display-only'` activates it, `build_key` matches, no
  `pass_versions` row, no outbox row, no R2 put; the next scan returns the new display; a pass pinned to an older
  version renders the active display. A save that also changes `pass.json` with `'display-only'` is saved but not
  activated.
- Event note: present in the session; absent from `ScanDisplay`.
- Fail safe: a doc that makes the renderer throw (injected) still returns the verdict, with the default display and
  one `SCAN_DISPLAY_RENDER` log.
- Logs: no rendered fixture string in any log or audit line.

**Web (jsdom, `vitest-axe`):**
- Each row type and the panel frame at 390, 820 and 1180, light and dark, with max-length text: no axe violations,
  no overflow (text clamps), contrast ≥ 4.5:1 for chip tones and note tones on `surface-raised`.
- Verdict badge present whenever `header.icon` is set on `ok`; eyebrow present whenever `header.title` is set.
- Announcement starts with the system headline.
- The result card paints `ScanOutcome.display` and ignores `ScanCard.display`, even on a refusal whose card carries
  `ready` panels (1.11 rule 13).
- Overflow: a card taller than its limit (200 % text) scrolls its body; the band's and identity row's boxes don't
  move.
- Fit: on each screen, the largest composition the budget admits after the header cost (for example `ok` with a
  custom title, a photo and 3 units; `ok` with two panels at 6; `heads_up` with chips on two lines and 3 units) fits
  the B card at 390 × 844 without scrolling, light and dark, at the default text size. This is the measurement behind
  the constants in `density.ts` (1.6). At 200 % text the body scrolls and the band and identity row stay put.
- The event note renders on `heads_up` and `refused` only.
- Every id in `SCAN_ICONS` maps to a component.
- Bundle: `/scan` chunks don't contain `renderScanDisplay`.

**e2e:** the VIP variant (crown, gold chip, 4-column Ticket, Access panel) at the door; the same pass on a Door scanner without the
row marked `minRole: desk`; a coffee stamp 7 → 9 with "1 reward ready" after the redeem threshold; a display edit
mid-session shows on the next scan.

### 7.4 Design tokens the renderer needs (h0, additive, in `scan.css`)

`--wl-scan-chip-{neutral,teal,violet,gold}` and `-fg` pairs, light and dark, each ≥ 4.5:1. These are tints, not foil
fills: the foil gradient stays light-only and never a fill (`motion.css`). The note `attention` tone uses the gold
pair, not the kit's `warning` (amber) tokens: amber is a verdict colour, as for **Low balance**.

---

## 8. The six tiles, as data

Short forms; ids and `preset` tags omitted except where they matter. Units are rows plus 1 per frame.

**VIP event check-in** (an org template made from the Event ticket blueprint with `section`, `row`, `seat`, `gate`,
`tier`, `table` and `dietary` inputs; not the blueprint as shipped; `ok`, units 6):
```jsonc
"holder": "{{attendee}}",
"variants": [{ "id": "vip", "name": "VIP", "when": { "path": "inputs.tier", "eq": "VIP" },
  "header": { "icon": "crown", "chips": [
    { "id": "c_vip", "text": "VIP", "tone": "gold", "icon": "crown" },
    { "id": "c_table", "text": "Table {{inputs.table}}", "tone": "violet" } ] } }],
"header": { "subtitle": "{{inputs.admission}}" },
"panels": [
  { "id": "p_ticket", "preset": { "id": "ticket", "v": 1 }, "title": "Ticket", "icon": "ticket", "rows": [
    { "id": "r_seat", "type": "columns", "size": "big", "items": [
      { "id": "i_sec", "label": "Section", "value": "{{inputs.section}}" },
      { "id": "i_row", "label": "Row", "value": "{{inputs.row}}" },
      { "id": "i_seat", "label": "Seat", "value": "{{inputs.seat}}" },
      { "id": "i_gate", "label": "Gate", "value": "{{inputs.gate}}" } ] } ] },
  { "id": "p_access", "preset": { "id": "access", "v": 1 }, "title": "Access", "icon": "key",
    "on": ["ok", "ready"], "when": { "path": "inputs.tier", "eq": "VIP" }, "rows": [
    { "id": "r_perks", "type": "list", "pair": true, "items": [
      { "id": "i_lounge", "icon": "armchair", "text": "Lounge", "detail": "Level 2" },
      { "id": "i_dinner", "icon": "utensils", "text": "Dinner", "detail": "{{inputs.dietary}}" } ] } ] }
]
```
Renders: green tint and ring; the crown leads the band with the check badge; headline **Checked in** (system, so no
eyebrow); identity row: pass tile, **Anna Meyer** (holder line), "General admission" (meta), chips **VIP**, **Table
12**; Ticket: 104 · F · 12 · C on one line (`oneLine: true`, every value ≤ 4); Access: Lounge · Level 2 and Dinner ·
Vegetarian, two per line. On **Already checked in** (`heads_up`, cost 2) only Ticket shows: Access is `on`
`ok` and `ready`, which is what BF's amber tile renders.

**Gym member at the desk** (`ready`, then `ok` on check-in, units 3 + header 3): `photo: { "minRole": "desk" }`; Membership
panel: `columns` Member since · Expires, `columns` Last visit (`{{history.lastVisit.at|ago}}`) · This month (`#
visits`). Variant `gold` (`tier = Gold`) → chip Gold (gold). On `ok`, variant `back` (`history.visits.total` ≥ 1) sets
the title "Welcome back", so the band reads eyebrow **Checked in** above **Welcome back**. A Note panel `on: ["ready"]`
`when` `pass.validUntil` `daysFromNow ≤ 14`: "Renewal due. Offer the annual plan." (on `ok` it would exceed the
budget; the renewal talk happens at the desk card). The identity row shows the 96 px photo in place of the pass
tile.

**Coffee loyalty stamp** (the Stamp card blueprint's display, reward "Free coffee", `ok` after "Add stamp" ×2, units 4): Loyalty panel: `progress` value `{{inputs.stamps}}`,
goal from the `take` action (10), reward "Free coffee", icon `coffee`. Band: **+2 stamps**, sub **9 of 10 stamps**
(`SCAN_COPY`). The row animates 7 → 9 with the caption "1 more for Free coffee". At 10 (the input's maximum): "1 reward ready", and
the action area promotes **Redeem reward**. No button in the card.

**Prepaid credit redeem** (the Balance card blueprint's display, `ready` → review → `ok`, units 5): Balance panel: `money` `{{inputs.balance}}`, currency
`{{inputs.currency}}`, `lowBelow: 5`, `pending: ["charge", "top_up"]` (the Balance preset's output plus `lowBelow`, as shipped); `history` value of `balance`, limit 3, show amount, when,
where. Review: only this panel shows, above the keypad in the action area: "$42.50 → $30.50, −$12.00". `ok`: $30.50
with −$12.00 as this scan's change. Ledger rows read "Charge", "Top up" or "Changed elsewhere".

**Coupon redeem** (`ok` on `use_up`, units 5): Offer panel: `big` "{{inputs.offer}}" ("20% off"), `columns` On ·
When, `columns` Uses left · Use by `{{pass.validUntil|day}}`. Band **Redeemed** (system); the identity row's meta line
is the offer title.

**Same event template, uncustomized** (the Event ticket blueprint as shipped, units 5): holder `{{attendee}}`; Ticket panel:
Seat `big` ("Row F, Seat 12"), Ticket (admission), Doors, Room. A template with no block at all shows a Details panel
of its first four front fields instead (2.2).

**Refused, voided** (no units): red tint and ring; hero band **Voided**, **Voided Nov 3.**; compact pass row with the
holder line; `notes.refused` "Send them to the box office, left of the doors."; the event note when set. No panels.

**Live pass on a test scanner** (`live_pass`): `display` and `card` are `null`; the compact row shows the template's
name from `ScanOutcome.template` and no meta (R18). Nothing from the pass, not even its title.

**Annotated slot names** for the designer's tile. System: tint and ring · verdict band (glyph or `header.icon` with the
badge, eyebrow, headline, verdict sub) · pass tile or photo · holder line · flags · action area · last-scan strip ·
buddy. Template: icon and title (`ok`) · meta line (`header.subtitle`) · chips (`header.chips`) · panel 1 / panel 2
(header line = `title` + `icon`; rows by type) · notes (`notes.staff`, `notes.refused`). Event: the event note.

---

## 9. Open questions for the owner

1. **B strengthened.** The lead's call is B's layout with A's verdict strength (R1). The model works for either and for
   "A at the door, B at the desk"; please confirm the direction.
2. **Staff names in history.** Rows show where (scanner), not who. Showing "by Sam" helps disputes but puts staff
   names on every desk. Default off; say if you want it as a `show` option.

Settled by the owner, 2026-11-04: names in the band (R16: the holder's name only, 2 lines for 1 more unit); no item
names in the ledger (R13); blueprints never issue passes, so no per-org display for shared templates is needed (2.3).
The holder question is settled: the holder line is system-owned and always shows; `holder` only picks its source (R6).

---

## 10. Editor

The visual editor for `scan.display`: the **Scan screen** mode of the existing template designer
(`src/web/admin/templates/designer/**` in the `next` checkout). Mockups: `directions/display/editor/*.html` (1440 and
820, light and dark, and the 390 preview-only page). Sheets: `directions/display/sheets/`. Status: design,
2026-11-04, reconciled with R1-R19. Nothing is built. The sheets paint the canvas with the B-final kit, so they
follow R1-R19: Ticket with 4 columns, the photo as an identity setting, the system holder line with the meta under it,
the fit meter per screen "of 6" (1.6), and a display-only save that is live at once (E9). The canvas paints whatever
the shared result components paint, so it follows the chosen direction without editor changes.

### 10.1 Decisions

| # | Decision |
| --- | --- |
| E1 | **One editor: a mode of the template designer.** A `Pass` / `Scan screen` segmented control sits under the designer's page header. Both modes share one `DesignerState`, one draft in the browser, one undo history, one `SaveBar` and one **Save version**. The display lives in `doc.manifest.scan.display`, so the existing draft, dirty check and save path carry it without changes. |
| E2 | **Same frame as n5.** `DesignerLayout` is unchanged: structure, stage and issues at 1280 px and wider; structure beside the stage with issues under it on a tablet; preview only on a phone. The open outline section is the inspector, as in n5. There is no third inspector column. |
| E3 | **The canvas is the real result renderer.** The stage paints `renderScanDisplay(doc, sampleScope, preview)` through the `/scan` result components (`src/web/scan/display/**`) at 0.8 scale inside a device frame. Every element can be selected, and the selection syncs both ways with the outline. |
| E4 | **Outcome tabs choose the screen.** Event templates get Checked in, Already checked in and Refused. Desk templates get Card, then one tab per action (Add stamp, Redeem), then Heads-up and Refused. A tab's dot uses the verdict colour, and Refused carries a lock. System content (tint, verdict band, holder line, pass tile, flags, action area, buddy) shows as dashed outlines with a lock, and its outline rows read **System** with a one-line reason ("The holder line always shows. Choose its source in Header."). The Refused tab edits only the refused note. |
| E5 | **Presets are a starting point.** The empty state is a palette of eight preset tiles plus **Empty panel**. Each tile has a small schematic of its layout and an "N found" badge when the preset's slot hints match inputs. Hovering or focusing a tile previews it as a ghost on the canvas. Adding writes ordinary rows (section 6.4). **Reset to preset** sits in the panel menu. |
| E6 | **Bindings are tokens, not syntax.** A text field shows literal text and teal field tokens. **Insert field** opens a picker with groups for holder, inputs, pass fields, pass, scan history and event, each entry showing its live sample value. Secrets (email, phone, the barcode message, tokens) are listed but disabled with "Never shown on scanners", so authors learn why; nothing in the editor says "hidden for Door" about them (R5). Authors never type `{{ }}`; an advanced toggle shows the raw expression. |
| E7 | **One condition builder for three uses.** The same builder edits a variant's `when` (Rules), a panel's or row's **Show when**, and list or chip items. **Who sees it** is a three-way segmented control: Everyone, Desk and up, Manager. The value menu lists an input's enum values with pass counts. **Try another pass** switches the sample so the author sees a rule take effect. |
| E8 | **The fit meter makes the density budget visible, per outcome tab.** "Fits on a phone: 5 of 6" (frames and the header cost included; the header's share is labelled, for example "Title 2") is coloured by panel tone. Each panel header shows "2 of 5 units". Rows the renderer cuts on the current tab (1.6) show dashed with **Cut on this screen**. On `ok` the palette greys out a row type that would break the budget and gives the reason in its tooltip. |
| E9 | **A save makes a version; a display-only save goes live.** **Save version** sends `activate: 'display-only'`. When only the scan screen changed, the server activates it and the callout reads "Version 5 is live on scanners. Passes are unchanged." The Version card says it ahead of saving: "Only the scan screen changed. Scanners show it on the next scan." A save that also changes the pass is saved without activating and falls back to n5's copy and **Activate** button. Needs `displayOnly` and `activated` in `SaveVersionResponse` (templates module c, from `build_key`, 2.5). |
| E10 | **No per-event editing here.** The display has no per-event overrides (R10). The optional event staff note stays in the event dialog (2.6); the Notes section links to it when the template has events: "Event notes are set per event." |
| E11 | **The action area is shown, not edited.** The canvas paints the template's actions in the system action area (locked) so the author sees the whole screen; actions are edited in the manifest's scan actions, not here. No row type in the palette is a button (R3). |
| E12 | **Header holds the identity sources.** The Header section edits the holder line's source (`holder`, a binding picker), **Show member photo** (`photo`, with Who sees it), the `ok` icon and title, the meta line and chips. The holder line itself can't be removed. The title field's **Insert field** offers only the holder's name (**First name**, **Full name**), disabled with **The holder line's source isn't a name.** when the holder source is the pass title or an `enum` input (1.3); a name makes the fit meter read **Title 3** (2 lines, 1 more unit; R16). The title field's help: **Names that look like a verdict show the plain headline.** |

### 10.2 Reuse and new parts

**Reused unchanged from n5 (`src/web/admin/templates/designer/`):**
- `layout.tsx` (`DesignerLayout`), `context.tsx` (`useDesigner`) and `drafts.ts` (the draft already carries
  `doc.manifest`, so `scan.display` rides along).
- `issues.tsx` (`Issues`; new targets come from `targets.ts`).
- `controls.tsx`: `TextEdit`, `PickEdit`, `NameEdit`, `Group`, and `SourcePicker` as the pattern (not the component)
  for the binding picker.
- The `designer.css` row pattern: `dz-section`, `dz-head`, `dz-row`, the grip, Alt+Arrow keys, the move up and down
  buttons, the live region, and the `dz-assemble` and `dz-deal` motion.
- `api.ts`: `useDesignCheck`, `useBaseVersion`, `mergeAssets`.
- `preview.tsx` (`DesignerPreview`) stays the Pass mode's stage; the Scan mode has its own stage.

**Reused from the kit:**
- `SegmentedControl`: mode, role, theme, device and size.
- `Tabs`: outcomes, which become a `Select` below 1280.
- `Popover` and `Combobox`: binding picker and icon picker.
- `MoreMenu`: panel menu.
- `OptionTile`: preset palette.
- `Callout`, `Badge`, `Checkbox`, `Switch` and `ConfirmDialog` (Reset to preset, Remove panel with changed rows).
- `toast.undo`: delete from the canvas.
- `Tooltip`: lock reasons.
- `Skeleton`: renderer loading.

**Reused from other workstreams:**
- The result components: `ScanResult`, `ResultPanel`, the identity row and one component per row type
  (`src/web/scan/display/**`, n8 / screens). The canvas paints whichever direction those components implement (R1).
- The pure `renderScanDisplay`, `scanDisplayIssues`, `density`, `PRESETS`, `defaultScanDisplay` and
  `ScanDisplayDocSchema` (passkit).

**Extended in n5** (each change under 20 lines unless noted):

| File | Change |
| --- | --- |
| `model.ts` | `Section` gains `scan-header \| scan-rules \| scan-panel \| scan-notes`; `Selection.key` holds the element id |
| `apply.ts` | `Op` gains `ScanOp` (10.3); `applyOp` delegates `scan-*` ops to `applyScanOp` from `scan/ops-scan.ts` |
| `reducer.ts` | `added.kind` gains `panel \| row \| chip \| variant`; `mode` and `preview` become editor state outside the history; new ids come from `uniqueId` like `field-add`'s key |
| `targets.ts` | maps `scan.display.*` issue paths to selections |
| `outline.tsx` | renders `ScanOutline` when the mode is `scan` |
| `designer.tsx` | the Pass / Scan screen `SegmentedControl` under the page header; mounts `ScanMode`; **Save version** sends `activate: 'display-only'`; the saved callout uses the display-only copy (E9) |
| `designer-page.tsx` | reads `?mode=scan` into the initial mode |
| `api.ts` | `useSaveVersion` accepts `activate: boolean \| 'display-only'` and returns `displayOnly` |
| `section-inputs.tsx` | the **Scanner** visibility control for `x-scan` (Everyone, Desk and up, Manager, Hidden; "Never shown on scanners" for secrets) |
| `designer.test.ts`, `designer-ui.test.tsx` | mode switching, display-only save |

**Extended outside the designer** (`src/web/admin/templates/`):

| File | Change |
| --- | --- |
| `template-overview.tsx` | a **Scan screen** card: a still of the `ok` result and **Edit scan screen** (`?mode=scan`) |
| `versions-panel.tsx` | a "Scan screen only" badge on display-only versions |

**New, in `src/web/admin/templates/designer/scan/`** (each file under 300 lines, each with a test beside it):

| File | What |
| --- | --- |
| `scan-mode.tsx` | Mounts the scan outline, stage and side cards in `DesignerLayout` |
| `scan-model.ts` | `ScanSelection` (section and element id), labels, row-type metadata (icon, name, units) and `slotPolicy(screen)`, which decides between template, system and hidden per slot of 1.2 |
| `ops-scan.ts`, `ops-scan-items.ts` | `applyScanOp` and the pure document ops in 10.3 |
| `scan-outline.tsx` | Header, Rules, one disclosure per panel, Add panel and Notes |
| `section-header.tsx` | holder source, photo, `ok` icon and title, meta line, chips (E12) |
| `section-rules.tsx`, `section-panel.tsx`, `section-notes.tsx` | The other inspectors |
| `row-editor.tsx` plus `row-editors-{text,value,list}.tsx` | One editor per row type, grouped; `columns` shows its compact one-line cap next to each value |
| `expr-field.tsx` | Text with tokens. Tokens are buttons: Backspace removes one, Enter opens Format (date, time, ago, count, money, upper) |
| `binding-picker.tsx` | Popover and Combobox over `scopeCatalog(manifest, role)` with sample values; secrets disabled |
| `icon-picker.tsx` | The 40 `SCAN_ICONS` in 7 groups, with search |
| `cond-builder.tsx` | Leaves of the form field, operator, value. All or Any. Up to depth 2 in the UI (deeper conditions show as "Custom condition" with raw editing) |
| `preset-palette.tsx`, `row-palette.tsx` | Add panel and Add row, with budget-aware disabling; no button row exists |
| `scan-stage.tsx`, `canvas.tsx`, `canvas-overlay.tsx` | Tabs, preview controls, device frame, hit targets, the selection ring, tag and mini toolbar, ghosts and lock outlines over system content |
| `sample.ts` | Sample scope: `manifest.sample`, sample history and ledger, a sample event, or a real pass through the preview endpoint (10.7), plus per-input overrides |
| `fit-card.tsx`, `version-card.tsx` | The side cards: the fit meter (6 units less the header cost, per tab) and what a save will do |
| `scan.css` | Canvas and overlay styles (`ed-*`), using tokens only |

**Entry points:**
- Template detail: a **Scan screen** card with a still of the result and **Edit scan screen**, linking to the designer with `?mode=scan`.
- Scanning, event page: "Result screen: Saturday gala template · Edit" goes to the same URL.
- A blueprint goes through **Use blueprint** first, which makes the org's own template.

### 10.3 Reducer ops

All ops are plain data, one undo step each. Typing coalesces under `merge: scan:<id>:<field>` (n5's 1 s window). New ids are fixed in the reducer, like `field-add`'s key: `uniqueId(doc, 'p_' | 'r_' | 'i_' | 'c_' | 'v_')`, deterministic from the doc, so replays match.

```ts
type ScanOp =
  | { op: 'scan-init'; from: 'default' | 'empty' }                         // materialize 2.2 or an empty doc
  | { op: 'scan-holder'; expr: string } | { op: 'scan-currency'; expr: string | null }
  | { op: 'scan-header'; variant?: string; slot: 'icon' | 'title' | 'subtitle'; value: unknown }
  | { op: 'scan-chip-add'; variant?: string; id?: string; index?: number }
  | { op: 'scan-chip-set'; id: string; patch: Partial<Chip> }
  | { op: 'scan-variant-add'; id?: string; from?: Cond } | { op: 'scan-variant-set'; id: string; patch: Partial<Variant> }
  | { op: 'scan-panel-add'; preset: PresetId | 'empty'; index: number; id?: string }
  | { op: 'scan-panel-set'; id: string; patch: Partial<Panel> }              // title, icon, tone, on, actions
  | { op: 'scan-panel-duplicate'; id: string; newId?: string }
  | { op: 'scan-panel-reset'; id: string }                                   // re-run preset build, keep untagged rows
  | { op: 'scan-row-add'; panel: string; type: Row['type']; index: number; id?: string }
  | { op: 'scan-row-set'; id: string; patch: Partial<Row> }
  | { op: 'scan-row-duplicate'; id: string; newId?: string }
  | { op: 'scan-item-add'; row: string; index?: number; id?: string } | { op: 'scan-item-set'; id: string; patch: object }
  | { op: 'scan-when'; id: string; when: Cond | null }                       // any element
  | { op: 'scan-role'; id: string; minRole: ScanRole | null }
  | { op: 'scan-photo'; on: boolean; minRole?: ScanRole | null }          // Show member photo
  | { op: 'scan-notes'; staff?: Text | null; refused?: string | null }
  | { op: 'scan-remove'; id: string }                                        // chip, variant, panel, row or item
  | { op: 'scan-move'; id: string; parent?: string; index: number }          // reorder; rows may change panel
  | { op: 'scan-nudge'; id: string; delta: -1 | 1 };                         // Alt+Arrow, the buttons, the canvas toolbar
```

- Collapse is editor state (`collapsed: Set<id>`), not a document op.
- `scan-remove` of a panel whose rows differ from its preset asks first (`ConfirmDialog`, "Remove Access? Its 2 changed rows go too."). Every other remove is immediate, with `toast.undo`.
- `scan-move` refuses a move that breaks the placement rules (1.6), for example an image row that isn't first. The drop target shows the reason, and the live region says it.
- An op that would push a panel or the result over budget is still applied, so that the author can then remove something else. `scanDisplayIssues` reports `SCAN_DISPLAY_DENSITY`, and the meter turns red. The palette prevents most of these cases up front.

### 10.4 Behaviour details

- **Selection:**
  - Clicking a canvas element selects it; clicking a selected text element starts an inline edit. Inline editing is only for literal text. Bound text opens its field in the inspector.
  - A selected element opens its outline section and row, scrolls the row into view and shows the ring, the type tag and the mini toolbar (up, down, duplicate, remove) on the canvas.
  - Clicking a system element shows its lock reason in a tooltip and selects nothing.
- **Preview controls:**
  - Sample pass: a sample or a real pass (search), plus "Edit sample inputs".
  - Role: Door, Desk or Manager. Role filtering runs exactly as on the server, so Door hides desk-only rows.
  - Theme and device: light or dark, phone or iPad, as canvas-corner toggles.
  - None of these settings is saved in the document.
- **Live rules:** a panel hidden by its `when` shows on the canvas as a dashed placeholder, for example "Access · Hidden for Leo Park: tier is General". It stays selectable, so the author can edit the rule from the canvas.
- **Validation:**
  - `scanDisplayIssues` runs in the browser on every change (it is pure and fast). The server dry run still gates the save.
  - Issue rows link to their element through `targets.ts`.
  - Field-level errors (an over-long literal, a filter that isn't allowed) show under the control.
  - A warning flag sits on the outline row.
- **Empty states:**
  - No display block: the palette plus a **Default** card ("Without panels, scanners show the pass's front fields." and **Use the default**).
  - A panel with no rows: "Add a row" with the row palette.
  - Refused: the lock line and the refused note only.
- **Undo and drafts:**
  - Cmd or Ctrl+Z and Shift+Cmd or Shift+Ctrl+Z work across both modes.
  - Switching modes doesn't clear the history.
  - The draft autosaves after 800 ms, as in n5.
  - The unsaved-changes guard covers route changes and the mode switch never triggers it.
- **Reduced motion:** a panel that joins appears at once, and the selection ring shows at once. Only the loading rail moves.

### 10.5 Accessibility

- **Canvas semantics:** the canvas is `role="group"` with `aria-label="Scan screen preview, Checked in"`. Every selectable element is a button in one roving-tabindex sequence in document order, with labels such as "Panel Access, 2 rows, shows when tier is VIP" and "Row Section, Row, Seat, columns". System elements are reachable and announce "System. Heads-up headlines can't change."
- **Keyboard:**

  | Keys | Action |
  | --- | --- |
  | Arrow keys | Move through canvas elements |
  | Enter | Edit (inline for literal text, otherwise focus the inspector's first control) |
  | Esc | Return focus to the canvas element |
  | Alt+Up / Alt+Down | Move the element |
  | Cmd+D | Duplicate |
  | Delete | Remove, with an undo toast |

  The outline keeps n5's shortcuts.
- **Live region:** a polite live region says what each op did ("Access moved to panel 1 of 2.", "Row removed. Undo with Cmd+Z.").
- **Pickers:** the binding picker and the icon picker are comboboxes with listbox semantics. Every icon option is named ("Coffee"). Disabled entries give their reason.
- **Field tokens:** each token is a button named "Field Seat, inputs.seat, sample 12".
- **Contrast and touch:** the selection ring and the lock outlines meet 3:1 against both themes. Every control is at least 44 px on touch, as in the kit.
- **Phone:** the 390 preview-only page puts nothing editable in the tab order.

### 10.6 Tests

- **Unit, `ops-scan*.test.ts`:**
  - Each op is pure. Replaying an op list gives the same document, ids included.
  - `scan-panel-add` for every preset against every blueprint manifest validates.
  - `scan-panel-reset` keeps untagged rows and is one undo step.
  - `scan-move` refuses moves that break placement rules.
  - `scan-remove` cleans up references.
  - Coalesced typing makes one undo step.
- **Unit, `scan-model.test.ts`:**
  - `slotPolicy` for all four screens matches 1.2.
  - Every row type has an icon, a name and a unit count that match `density`.
  - The issue-path to selection mapping covers every `SCAN_DISPLAY_*` code that has a path.
- **Web (jsdom, `vitest-axe`):**
  - **Rendering:**
    - Mode switching keeps the draft, the history and the dirty state.
    - Selecting on the canvas opens the matching outline row, and the reverse works too.
    - System elements can't be edited and give their reason.
    - The Refused tab shows only the notes editor.
    - Heads-up shows the header as locked.
    - The binding picker lists sample values, disables secrets and inserts a token.
    - The icon picker offers exactly `SCAN_ICONS`.
    - The condition builder round-trips 3.2 conditions, and deeper ones show as custom.
    - The fit meter matches `density()`.
    - A hidden panel shows the placeholder.
    - The saved callout uses the display-only copy when `displayOnly` and `activated` are true, and n5's copy with
      **Activate** otherwise.
    - The holder line is locked and always on the canvas; Header edits only its source.
    - No palette entry produces a button; the action area is painted locked.
    - The Ticket preset on a template with a gate input writes a 4-item `columns` row.
  - **Keyboard:** a full flow without a pointer: add Ticket, bind Seat, add Access, write Show when tier is VIP, reorder with Alt+Arrow, then save.
  - **Accessibility checks:** no axe violations at 1440, 820 and 390 in both themes.
- **e2e:**
  - Open from the template page, build the VIP display, save (it goes live, display-only), then scan with a test scanner: the next scan shows the crown, the VIP chip, the 4-column Ticket and Access, and no pass version is created.
  - The same flow opened from Scanning reaches the same editor.
  - A phone viewport shows the preview only.

### 10.7 Open questions

1. **Real-pass preview.** Decided in the plan: `GET /api/v1/scan-display/preview?templateId&passId&role` (DS.5, M3), returning the role-filtered scope, never a rendered display.
2. **Inline editing on the canvas.** Should bound text be editable on the canvas through a token-aware input? The proposal keeps canvas editing to literal text, to avoid a second token editor.

---

## 11. Customer audience and access bindings (2026-11-05)

Stations put a **Customer screen** beside a scanner and **Desk monitors** anywhere (SA §18). Monitors are staff: they
render exactly as a Door or Desk scanner would (5.2 step 6). Customers are not staff, so they get their own audience,
opt-in content, a narrower scope and a separate renderer. Access cards (SA §19) add a scope root and change how visits
count.

### 11.1 The `customer` block

```ts
// ScanDisplayDoc (6.1) gains, optional:
customer?: {
  greet?: boolean;      // default true: "Hi, {holder.firstName}" on ok and ready
  chips?: string[];     // ids of header chips (base or variant); ≤ 2 from any one header; schema max(18)
  panel?: string | null; // ≤ 1 panel id
};
```

- **Opt-in.** Nothing a template author wrote reaches a Customer screen unless the block names it. A named panel keeps
  its staff rendering too; the block only points at it.
- **No block** → `defaultCustomer(doc)`: greet on, no chips, the first panel whose `preset.id` is `loyalty` or
  `balance` (the Stamp card's stamps, the Balance card's balance), else nothing.
- **Chips per header.** Ids are unique in the doc (7), so a chip that changes tone per variant has one id per
  variant. Only one header renders, so ≤ 2 per header keeps the customer at ≤ 2 chips. The Access card names
  `c_plan`, `c_timed`, `c_guest`.
- The station can still turn the greeting off (`greet` switch); either off means no name.

### 11.2 Rules (`customerIssues`, in `scanDisplayIssues`)

| Rule | Detail | Code (error) |
| --- | --- | --- |
| Allow-listed rows | `heading`, `field`, `big`, `columns`, `progress`, `money`, `chips`, `list`, `divider`; `history` only with `source: 'visits' \| 'value'` and `show ⊆ ['when', 'amount']`. Never `note`, `image`, or a `history` with `where` or `action` | `SCAN_DISPLAY_CUSTOMER_ROW` |
| No raised elements | the panel, its rows and items, and the named chips have no `minRole` | `SCAN_DISPLAY_CUSTOMER_ROLE` |
| Customer scope | the Door scope minus every input with any `x-scan` annotation, the fields bound to them, `pass.externalId`, `scanner.*`, `event.arrived`, `event.expected`, `event.capacity`, `history.*.where`; a named element reading a removed path is an error | `SCAN_DISPLAY_CUSTOMER_SCOPE` |
| Density | 1 panel, ≤ 4 units (1.6 weights) | `SCAN_DISPLAY_CUSTOMER_DENSITY` |
| Chips | ≤ 2 named chips in any one header | `SCAN_DISPLAY_CUSTOMER_DENSITY` |
| References | named ids exist | `SCAN_DISPLAY_CUSTOMER_REF` |
| Screens | `ok` and `ready` only; `heads_up` and `refused` show nothing from the doc | renderer |
| Safety | 1.11 rules 5, 6, 8, 9, 10 and 11 apply unchanged | — |

### 11.3 Rendering

`renderCustomerView(doc, scope, { screen, outcome, locale, timeZone, now }) → ScanCustomerView` in
`src/passkit/template/scan-display/customer.ts` (DS; pure, browser and worker). The band and the system lines come
from `CUSTOMER_COPY` and the outcome; `greet`, `chips` and `panel` from the doc over the customer scope. On any throw:
the system view (band only) and one `SCAN_DISPLAY_RENDER` log. The contract (SA §18.4) has no pass id, scan id,
reason or image URL. The Worker calls it from `live/audiences.ts` with data the request already loaded; `needs` is the
union of the actor's role, the monitor audiences present and the customer block, so history statements still ride in
the existing batch (5.3).

| Screen | Band | Greet | Chips, panel | Lines |
| --- | --- | --- | --- | --- |
| `ok` | `CUSTOMER_COPY` ok headline and sub ("Access granted · Pool", "+2 stamps · 9 of 10", "Paid $12.00") | yes | from the block | access: **Until 9:00 PM today** when `closesAt` is today; **2 of 5 visits left** for limited guests |
| `ready` | **Hi, Sam** (or **Hello**) · template name | in the headline | from the block | none |
| `see_desk` | the station's `refusedLine`; sub only for `outside_hours` (**Your plan opens at {time}.**) and `guest_expired`, `guest_visits_used` (**Your guest pass has ended.**) | no | none | none |

### 11.4 The `access` root

Present when the template has `scan.access` (null otherwise, so expressions hide):

| Path | Value |
| --- | --- |
| `access.plan`, `access.kind` | the pass's plan label ("Off-peak") and kind (`always`, `timed`, `guest`) |
| `access.zone` | the deciding zone's name ("Pool"); null on a scanner without zones |
| `access.closesAt`, `access.nextOpenAt` | instants (format with `time`, `ago`) |
| `access.until` | the pass's end (input, or the guest's computed end), ms |
| `access.hours` | the plan's hours text: "Mon–Fri 6 AM–4 PM, 8 PM–11 PM · Sat–Sun 8 AM–8 PM" |
| `access.visits.used`, `.limit`, `.left` | guests and members; `limit` null when unlimited, so strict interpolation hides "of {limit}" |
| `access.zones` (build only) | "All zones", or names joined, ≤ 3 then "+2": the pass face's **Zones** field |

The same values reach the pass build through `PassScope.access` (`accessScope()`), so the face and the scanner agree.
`build_key` includes `scan.access` only when a binding reads `{{access.…}}`.

### 11.5 Visits on access templates

A grant is a visit when it comes more than `visitGapMinutes` (default 120) after the last grant (`scans.visit = 1`).
`history.visits.*` and `history.lastVisit.*` count visits; `history.scans.*` still counts every grant. "This month 12
visits" stays true when a member passes the main door and then the pool.

### 11.6 The Access card's display (blueprint)

`addendum/access/pass/starter-access-card/wallet.template.json` (AX §4.4): `holder` `{{memberName}}`; `photo`
`minRole: door`; base header chip `c_plan` (violet, `infinity`); variants **Timed** (`access.kind = timed`, chip
`c_timed`, teal, `clock`) and **Guest** (`c_guest`, gold, `ticket`); panel `p_visits` (preset `membership`, icon
`door-open`, title **Visits**): members a `columns` row (**This month** `{{history.visits.month}}` with zero form
**First visit**, **Last visit** `{{history.lastVisit.at|ago}}`), guests a `columns` row (**Visits left** `{{access.
visits.left}} of {{access.visits.limit}}`, **Until** `{{access.until|time}}`), and **Guest of** `{{inputs.sponsor}}`
for Desk; `notes.refused` **Ask at the front desk.**; `customer { chips: [c_plan, c_timed, c_guest], panel: null }`.
Density on `ok`: 3-4 of 6 units. It parses with Phase 0's frozen schema once P0-7 lands (checked with
`addendum/access/gen/check-package.mjs`: parse true, access block ok, ids and customer block ok).

### 11.7 Editor

The Scan screen mode (10) gets a **Customer** tab beside Ready, OK, Heads-up and Refused: a preview at customer scale
(the customer face's card, SD §16.2) and two pickers, **Chips** (per header, ≤ 2) and **Panel** (one; disallowed panels
greyed with the reason from 11.2). Ops `customer.set` (one undo step each). Owner: TD, `designer/scan/customer-tab.tsx`.

### 11.8 Tests

DS (`customer.test.ts`): the allow-list, the scope removals (a row bound to an `x-scan: desk` input renders empty),
the per-header chip cap, density, the default for a doc without the block (the Stamp card's stamps only), `greet:
false`, the fail-safe; a recursive scan of every outcome fixture's customer view for holder data beyond the first name.
`access` root: every path for 24/7, Off-peak and a 2-visit guest; null on a ticket; `history.visits.month` counts
visits at a month edge in the zone's time zone.
