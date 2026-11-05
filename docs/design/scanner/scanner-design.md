# Scanner design

The one UX and UI design for PassBook's scanner: the `/scan` app (door and desk), the admin side and the holder
touches. 2026-11-04. Status: decided, ready to build with `scanner-architecture.md`.

> **Revision 2026-11-04** (the owner's three changes):
> - **Results are B strengthened.** The old flood-and-card result screens are replaced by the B layout with A's verdict
>   strength: live dimmed camera, a full-screen tint and 10 px ring, the buddy XL on the dock, its violet pass rising
>   into the result card (104 px band, 56/64 px solid glyph, 40 px headline), the last-scan strip with Undo, desk input
>   on the card. The visual source of truth is `docs/design/scanner/b-final/` (**BF**: README and sheets). Changed: D2, D3, D5-D7,
>   D9, D10, D13 and new D15-D18; sections 2.2-2.3, 3, 4, 5.3-5.7, 6, 7, 9, 10.4-10.5, 13-15.
> - **Customizable result content** (new 5.8): per-template slots, panels and rows from `scan.display`, with the
>   verdict system-owned. Model: `docs/design/scanner/display-model.md` (**DM**).
> - **The Scan screen editor** (new 10.8): a mode of the template designer. Sheets: `docs/design/scanner/display/sheets/`.
> - **Settled here:** keypad entry on a phone uses a dock tray; **Not found** reads "This code isn't a pass here.";
>   a reached goal keeps the check and promotes **Redeem reward** in the dock; the first scan's time and staff move to
>   the last-scan strip; the event staff note shows on Start, heads-up and refused.
> - `mockups/` result tiles are superseded (section 14). Door, desk and admin flows are unchanged.
> - **Review fixes** (DM R15-R19): the fit budget counts the header per screen and the server cuts trailing rows; the
>   band title is a literal (widened to the holder's name by the owner answers below); mode mismatches show only the
  template name; the store card is a balance card (now the **Balance card** blueprint);
>   five BF captions and two editor tiles are corrected in section 14.
> - **Owner answers** (later the same day): the band title may add the holder's name and take 2 lines for 1 more unit
>   (5.8, 10.8); two blueprints, **Balance card** (`coins` beat) and the new **Stamp card** (`stamp` beat), each with
>   its own display and identity (5.3, 5.8); no item names in the ledger (15); "starter" is now
>   **Blueprint** in every string, and **Use blueprint** replaces **Duplicate to edit** (10.8).

> **Revision 2026-11-05** (stations and the Access card; sections 16 and 17, D19-D25):
> - **Customer screen** (16.2): a phone or iPad facing the customer, the buddy large, one result at a time, every
>   refusal **Please see the desk** on slate, never red. **Desk monitor** (16.3): a live feed with counters, filters,
>   an alert strip and presence. **Roles on the device** (16.4): **Show to customer**, **Which scanner is it facing?**,
>   hold the capsule for **Back to scanning?** with a staff PIN. **Station setup** in the console (16.5): the
>   Scanners tab becomes **Devices**, grouped by station.
> - **Access results** on the scanner (17.1): **Access granted** with the zone, the plan chip, a Visits panel, the
>   `gate` beat; five red refusals with **Let in anyway** for a Manager. **Zones** tab and the plan editor (17.2),
>   the **Access card** blueprint (17.3).
> - Admin tabs are now **Devices · Events · Zones · Staff · Scans** (10.1).
> - Layout, sizes and per-state copy in detail: `addendum/ux.md` (sections 16-17 here win where they differ; the
>   differences are listed in 16.7).
> - Sheets: `addendum/sheets/ux-{customer-phone,customer-ipad,monitor-desk,monitor-ipad,roles,access-phone,access-ipad}-*.png`,
>   `addendum/sheets/x-admin-*.png` (console), `addendum/stations/sheets/stations-topology-*.png`,
>   `addendum/access/sheets/access-{card,gate}-*.png`; screens `addendum/shots/{c,m,r,a,ad}-*.png` (phone 390 × 844,
>   iPad 1180 × 820, desk 1440 × 900, light and dark), console `addendum/access/admin/shots/`.

**Precedence.** `scanner-architecture.md` (SA) wins on principals, rights, data, API, reasons and timings. This file
wins on everything a person sees: layout, copy, components, feedback, the buddy's seats and the admin pages. It
replaces the overlapping parts of `ux-door.md` (UD), `ux-desk.md` (UK), `ux-admin.md` (UA) and `buddy-motion.md` (BM);
those stay the detail references for what this file doesn't restate (BM's keyframe tables, UK's keypad behaviour,
UA's empty states and toasts). Section 1 lists what changed from each. For the result screens, BF wins on geometry,
z-order, type steps, colour tokens and motion timings, and DM wins on what the result says and who owns each slot;
this file states the decisions and the copy.

Visuals: **`docs/design/scanner/b-final/sheets/` is the source of truth for the `/scan` shell, every result and the desk
panels**; `docs/design/scanner/display/sheets/` for the Scan screen editor; `mockups (not shipped) ` for the admin pages and
the boot screens' content (section 14 lists what is superseded).

---

## 0. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | **One app, one screen that adapts.** `/scan` has no door/desk mode switch for staff. The *posture* comes from the scanner's `flow` (SA 2.2): `auto` acts on scan (the door), `choose` opens the desk panel (the desk). A **ready action** turns `choose` into `auto` for one action. Width decides the layout. | Staff can't pick the wrong mode. One reducer, one set of components. The admin already decides what a scanner accepts, so it decides the posture too. |
| D2 | **One frame on every width (BF):** a glass *capsule* on top, the live camera edge to edge under it, a *card layer*, and a *dock* at the bottom with the last-scan strip and a thumb row. No rail: **Look up** and **Recent** open sheets from the dock. The iPad and a desktop with a webcam or wedge get the same frame with a one-row dock. | The camera visibly keeps reading; the thumb reaches every control; one frame at every width. |
| D3 | **A verdict tints the whole screen over the live camera**, with a 10 px verdict ring; the capsule and the dock stay above it, so the counter and the next action stay readable. | Reads from 2 m in a dark venue, and the feed visibly keeps running (rev. of "floods the stage"). |
| D4 | **Four verdict colours, theme-invariant:** green in, amber talk, red no, slate ours. Green and amber are light fills with dark text; red and slate are dark fills with white text. | A door's green matches the next door's; polarity separates red from green for deuteranopes (UD D2, SA 7.5). |
| D5 | **The result card is the buddy's violet pass, risen.** One card per result: verdict band, identity row (pass tile or photo, holder line, meta, chips), the template's panels, notes. It rises from the pocket, holds, and tucks back; a different code swaps it. Actions are never in the card: they live in the dock. | One object, one story; the verdict reads first and the who second; no control on the card. |
| D6 | **The desk panel is the one "ready" view.** A picked lookup row, a desk scan and an ambiguous pick all open it: the same card without a band, over the dimmed camera. At the door it is the confirm step (one primary: **Check in**, in the dock). | UD's confirm step and UK's member card were the same thing. |
| D7 | **The action area is system-owned:** the stepper, presets, review and Manager PIN sit in the card under the first template panel; the commit pair sits in the dock. On a phone an amount keypad opens as a dock tray. | Identity and the value being changed stay in view; the verb is under the thumb; the template can't place a control. |
| D8 | **One keypad** for amounts, staff PINs and Manager PINs (`inputmode="none"`). | A Bluetooth or NFC reader is a hardware keyboard, so iOS hides its own keypad (R crit 2). |
| D9 | **Locked actions stay visible.** A Door or Desk person can open a Manager action and review it; the commit reads **Ask a manager** and turns the panel into **Manager PIN**, which sends the same draft with `approval` (SA 2.7). | The manager approves the exact change, in place. |
| D10 | **Status lives in capsule chips, never banners:** count, reader, sync, ready action, Test. | A banner would cover the camera (SA conflict "Offline indicator"). |
| D11 | **No event picker on the device.** The admin binds a scanner to one event or a set of templates (SA D6). An admin scanning with their own session picks an org and an event once, in the **Scan as admin** sheet. | Fewer taps at the door; "x of y" is exact. |
| D12 | **Copy follows the camera, not a layout setting.** The front camera speaks to the guest ("Hold your code up to the camera"), the back camera to staff ("Point at the code"). | UD's Handheld/Stand setting only changed the camera and the copy. |
| D13 | **The buddy is the primary interface: one seat, on the dock, XL** (192 × 144 phone, 256 × 192 iPad). Its middle pass becomes the card; its outer passes fan and carry the beats. Beats start 150 ms after the verdict and are still by 700 ms; a new scan cuts them (BM, SA D16). Sheets on top hide it. | The owner's brief: the buddy is the interface, and the card comes to it. |
| D14 | **Admin: one nav item, Scanning,** with tabs **Scanners · Events · Staff · Scans** (2026-11-05: **Devices · Events · Zones · Staff · Scans**); NFC on the Apple identity page; scan actions in the designer (SA D19). | |
| D15 | **What the card says about the pass is the template's** (`scan.display`, DM): the `ok` icon and title, the meta line, chips, up to two panels of typed rows, notes. Everything that says the verdict is the system's. | The owner: "customize what the screen says per card"; staff keep one verdict language everywhere. |
| D16 | **The Scan screen editor is a mode of the template designer** (10.8): the canvas is the real result card, presets start a panel, rows are added, removed and reordered, bindings are tokens. | One editor, one draft, one save; what you see is what scanners paint. |
| D17 | **Refusals show no template content** except the org's refused note. The pass shows as a compact row with a neutral ticket tile, never its art. | A refused pass never looks admitted; an order panel or a refund reason never appears at a door. |
| D18 | **The visual direction is isolated.** Only the screens (`ui`, `result`, `display`, `desk`) and the buddy carry geometry, tokens and motion; the display contract has none. | "A at the door, B at the desk" later would touch only those. |
| D19 | **A Customer screen is the same `/scan` document with a customer face.** The buddy is the interface (XL, centred low), the card rises from its violet pass as on the scanner, the capsule names the org and station. No controls, no counts, no camera. | One app, one pairing; the buddy greets the customer as it greets staff. |
| D20 | **Customers never see red or a reason.** Every heads-up and refusal is one slate card, **Please see the desk** (the station's line), the buddy bowing (`sorry`). Three access refusals add a sub the customer can act on. | The verdict is staff's to explain; a customer at a till must not read "Suspended". |
| D21 | **A Desk monitor is a feed, not a scanner.** Counters, filters, rows newest first, one alert strip for the newest refusal, presence. It never acts; rows open a read-only detail. | The owner's "desk interface shows the scans in realtime". |
| D22 | **Flip on the phone, unlock with a PIN.** A paired phone becomes a Customer screen from its menu; holding the capsule brings back **Back to scanning?** with a staff PIN. | Two handhelds, one facing the customer, with no console trip. |
| D23 | **Access granted every time.** An access card never shows "already checked in"; a re-entry within the gap reads the same **Access granted**, with the last-scan strip saying **Again · 2 min ago**. | The owner: unlimited access, no "already scanned" screen. |
| D24 | **The plan chip names the plan, its icon names the kind:** `Infinity` 24/7, `Clock3` Timed, `Ticket` Guest. Tones violet, teal, gold. | Staff read "Off-peak" and see at a glance it has hours. |
| D25 | **Zones are a tree the admin draws once.** Scanners pick what they **Check**; plans pick what they grant. | A gym sets up its doors once; passes only pick a plan. |

---

## 1. What changed from the inputs

| Topic | Inputs | Now |
| --- | --- | --- |
| Postures | UD door screen, UK desk screen, separate layouts | One frame (D1, D2); posture from `flow` |
| Wide layout | UD: stage 7fr, panel at the end; UK: rail 360 at the start | Rail at the start for both (superseded: no rail, D2) |
| Verdict extent | UD: whole viewport; UK: flood then band | Superseded: full-screen tint and ring over the live camera (D3); desk `ok` keeps the card up after the tint; amber and red hold |
| Verdict colours | UD: invariant hex; UK: theme tokens | Invariant (D4), values in section 6.3 |
| Confirm step | UD `ConfirmPass`; UK member card | The desk panel (D6) |
| Event pick | UD Start-screen event radio list, `scan.event` manifest | Admin events (SA D6); none on the device (D11) |
| Layout setting | UD Handheld/Stand | Removed; copy follows the camera (D12) |
| Offline | UD shell banner; UK chip | Sync chip (D10) |
| Pairing code | UD 8 digits; UA 8 Crockford | 10 Crockford, `K7QH2-M9XTR` (SA) |
| Manager approval | UK manager codes, UA manager PIN on prompt | Review first, then **Ask a manager** (D9) |
| Sound toggle | UD header; UK bottom bar and menu | The menu (**⋯** in the capsule), on every width |
| Reader rings | UK loop while armed | Once per trigger (BM M8) |
| Audit actor | UA `device` | `scanner` (SA D20) |
| Admin "Pair this phone" | UA opens a new tab | **Pair this browser** (`pair-here`, SA 2.7) |
| Reasons and kinds | UD/UK/UA names differ | SA 4.2 vocabulary; copy in section 5 |
| Result screens (rev.) | This file's v1: a flood over the stage, a small result card at its foot, a rail on wide screens | B strengthened (BF): tint and ring over the live camera, the card from the buddy's pass, the dock (D2, D3, D5) |
| Result content (rev.) | Fixed: pass still, one subtitle line, `values`, ≤ 2 identity fields | The template's display (D15, 5.8) |
| Desk drawer (rev.) | A drawer inside the member card | The system action area in the card, commit pair in the dock (D7) |
| Buddy seats (rev.) | S/M seats on the viewfinder, result card, sheets | One dock seat, XL (D13) |
| Test band on `/scan` (rev.) | n6's `ModeBand` under the header | A **Test** chip in the capsule, above the tint |
| Goal reached (rev.) | `Gift` glyph and a **Reward ready** pill | The check keeps its shape; the panel caption says **1 reward ready**; the dock promotes **Redeem reward** |

---

## 2. Information architecture

### 2.1 Boot

```
/scan ──► #pair=CODE in the URL? ──yes──► strip it ──► Pair this device? (confirm) ──Pair──► session
   │                                   no
   ├─ scanner cookie ──► GET /scan/session ─┬─ staff_required ──► Who's scanning? ──PIN──► Start
   │                                         ├─ ready / not_open / closed ──────────────► Start
   │                                         └─ 401/403 ──► block panel (removed, expired, suspended)
   ├─ admin session ──► Scan as admin (org, event or templates) ──► Start
   ├─ user session ──► Sign in prompt (403)
   └─ nothing ──► Pair this device
Start ──Start scanning──► the loop (camera, audio and wake lock unlocked in one tap)
```

- `/scan` is its own document (`scan.html`, SA D12). Admin links into it are plain `<a href="/scan…">`.
- The only URL inputs: `#pair=` (stripped before any request) and, for admins, `?event=` (an event id is not a
  capability). Never a code or a name in the URL.
- A reader or search works before **Start scanning**; Start only gates the camera, audio and wake lock (AC D7).

### 2.2 The loop and its surfaces

One screen: the live camera with the capsule over it and the dock under it. Results and desk panels are cards on the
card layer; everything else is a sheet.

| Surface | Phone (< 640) | Tablet portrait (640–1023) | Wide (≥ 1024: iPad landscape, desktop) |
| --- | --- | --- | --- |
| Camera layer | edge to edge under the capsule; reticle and live pill while aiming | same | same; reticle 320 |
| Reader stage (camera off or reader only) | replaces the camera layer's content, same frame | same | same |
| Result card | rises from the buddy's pass; 342 wide, bottom fixed 284 from the screen bottom, max 443 tall | 560 wide | split card 980 wide: the verdict band as a 360 px column, content beside it at the wide width (BF iPad) |
| Desk panel (`ready`, review, Manager PIN) | the card without a band; camera dims and keeps decoding | same | header on top, template panel and system input side by side |
| Amount keypad | dock tray (the dock grows; the buddy peeks over it) | beside the panel | beside the panel |
| Last scan | dock strip; tap opens **Recent** (20) as a sheet | same | dock strip as a 460 px group; same sheet |
| Lookup | full-height sheet from **Look up** | sheet, `max-h 80dvh` | side sheet at the start, 400 px, over the dimmed camera |
| Staff sign-in, Scan as admin | bottom sheet | dialog `md` | dialog (`lg` for sign-in: list and keypad side by side) |
| Shift summary, Start, Pair, blocking panels | a card on the card layer, the camera off behind it | same | same |
| Menu | action sheet | dropdown | dropdown |

### 2.3 Capsule

A floating glass capsule (phone 366 × 52, r 26, 12 px inset; iPad 60 tall, r 30): `[Scanner name · staff]` over
`[state]` · chips · **⋯**

- Title: `Front door`, then `· Sam K.` (muted) when staff are signed in. Second line: a green dot and **Scanning**
  (while aiming and during a result), **Checking…**, **Scanning offline**, **Paused**. The event or the accepted
  templates show on the Start card and in **This shift**. Tapping the title opens **This shift**.
- Chips, in order (28 tall, 44 px hit area on touch): **Test** (`ModePill`, test scanners), **Ready: Add stamp ×**
  (accent), **Reader**, **Sync** / **Offline**, **Count**. Each is in section 5.6. Widths are reserved, so a chip
  change never moves the title.
- **⋯** is a 44 px icon button; **Sound** is in the menu.
- The capsule draws above the tint and ring; glass is opaque 92 % under `prefers-reduced-transparency`.

### 2.4 Menu (⋯)

One list for the action sheet and the dropdown; every item has an icon.

1. **This shift** (`Activity`)
2. **Direction: In / Out** (`ArrowLeftRight`; event scanners with re-entry)
3. **Sound** (switch)
4. **Keep results until tapped** (switch; turns off every auto-dismiss and the card idle clear, WCAG 2.2.1)
5. **Camera** › Back · Back wide · Front (radio; remembered per device)
6. **Camera off** (when the scanner has a reader)
7. **Reader tips** (when the scanner has a reader): a static sheet, four lines: **Hold the top of the iPhone near
   the reader.** · **If asked, unlock with Face ID, then hold it near again.** · **Still nothing? Scan the barcode
   instead.** · **No keyboard for Look up? Tap the keyboard button at the bottom of the screen.** (iOS hides its
   keyboard while a reader is connected, R crit 2 [U on device])
8. **Switch staff** (`staffSignIn` on)
9. **End shift** (`LogOut`)
10. **Unpair this device** (danger), or **Stop scanning as admin**

2026-11-05: **Show to customer** (`MonitorSmartphone`, sub **Turn this phone into a customer screen.**) sits after
**Keep results until tapped / Camera**, for paired phones when the scanner's `customerToggle` is on (16.4).

---

## 3. Who sees what

Rights are decided by the server (SA 2.4, `scanPolicy`); the UI mirrors them with the card's `actions[].lock`.

| Principal | Signs in | Sees and can do |
| --- | --- | --- |
| Paired scanner, nobody signed in | pairing once | Its `roleWithoutSignIn` (Door or Desk). Never Manager |
| Paired scanner, staff signed in | name + 6-digit PIN | That person's role. Header shows the name; signs out after 15 min idle or 12 h |
| Admin session on `/scan` | **Scan as admin** sheet | Manager rights, any org, picks event or templates; mode from the n6 switch; offline off; scanner name **Admin console** |
| Terminal (till) | token, no UI | API only (SA 5.1) |
| User session | — | **Sign in** prompt |

| UI element | Door | Desk | Manager / admin |
| --- | --- | --- | --- |
| Scan, typed code, reader | yes | yes | yes |
| Name / email search | when the scanner's `lookup` is on | same | same |
| Card actions with `minRole` ≤ role | buttons | buttons | buttons |
| Card actions above role | in **More** with `Lock` and the meta **Managers only**; opening them leads to **Ask a manager** | same | buttons |
| Amount over the action's max | `+` stops at max; hint **Up to 5 per scan.**; **Ask a manager** to go over | same | allowed up to the input's own maximum |
| **Let in again** (`letInAgain`) | anyone: button; manager: **Ask a manager**; never: hidden | same | button (unless never) |
| Undo | own scans, 10 min (Recent and the band) | same | Manager: any scan on this scanner today; admin session: any scan of the org, 24 h (SA 2.4) |
| Holder data | the holder line, template, the template's display (elements and inputs marked for a higher role removed), masked email in search rows only, photo when the display sets it for the role | same, plus desk-only elements | same, plus manager-only elements |
| Never on a scanner | full email, phone, barcode, scan code, download link, export; no display can bind them, and the editor lists them as **Never shown on scanners** | | |

**View only** (a scanner whose role has no action on this template): the action row becomes one line,
`Eye` **View only. This scanner can't change this pass.**

---

## 4. Layouts

B strengthened on every width (D2). BF is the build spec: geometry, z-order, every row's sizes, type steps, colour
tokens with contrast ratios and motion timings. This section fixes the frame and the rules; it does not restate BF's
numbers. Controls in sheets and dialogs keep the admin scale (14 px body, 36 px on fine pointers, 44 px with 16 px
field text on touch); the dock and the card use BF's scale (dock buttons 50, r 14, 17/600). Transform and opacity
only; no layout shift: the capsule chips, the dock strip, the card's bottom edge and the buddy seat have fixed boxes
from the first frame.

### 4.1 Phone, 390 × 844 (BF "Phone geometry"; sheets `b-final-phone-*`)

```
  0 ┌────────────────────────────┐ status bar (drawn above the ring)
 53 │ ╭ Front door ▣313/500   ⋯ ╮ │ capsule 366 × 52, glass, z 20
    │ ╎    camera, edge to edge   ╎ │ aiming: reticle 236, live pill "Point at the code"
117 │ ┌ card top limit ─────────┐ │ the card never rises above 117
    │ │ verdict band ≥ 104      │ │ x 24-366, r 28, z 11
    │ │ identity row 44-96      │ │ pass tile or photo · holder line · meta · chips
    │ │ panels · notes          │ │ the template's display (5.8)
560 │ └ card bottom (fixed) ────┘ │ where the pass leaves the pocket
546 │       ╲▯ buddy XL ▯╱        │ 192 × 144, z 12, passes overlap the card's edge
678 │╭ dock ─────────────────────╮│ z 10
    ││ ✓ Leo Park · 6:42  ↶ Undo ││ last-scan strip 40
    ││ [  Look up  ] [🔦] [⌨]    ││ thumb row 50 (amber: [Let in again] [Done])
844 ╰╰───────────────────────────╯╯
```

- **Aiming:** reticle, lock outline and live pill are on the camera layer and fade out (120 ms) while a card is up.
  The capsule's second line keeps **Scanning**.
- **Result:** the tint and ring cover the whole screen under the capsule and dock (D3). The card's height is its
  content, at most 443; the density budget (5.8) keeps every valid display inside it at the default text size, and
  anything still over (large text, zoom) scrolls in the card body while the band and identity row stay put. Refusals
  use the stacked band and stop after the compact row and notes.
- **Desk:** the camera dims (200 ms) and keeps decoding; the panel takes the card's place with no band; the commit pair
  replaces the thumb row; an amount keypad opens as a dock tray.
- **Thumb row:** door **Look up** (gray, grows), torch, keyboard; desk **Look up**, NFC, torch. Camera switch is in the
  menu.
- At 200 % zoom the card's body scrolls inside the card (the band stays); nothing scrolls horizontally.

### 4.2 Tablet portrait, 640–1023

The phone frame with a 560 px card and a one-row dock. Lookup opens as a sheet (`max-h 80dvh`).

### 4.3 Wide, 1180 × 820 and up (BF "iPad"; sheets `b-final-ipad-*`; desktop with a webcam or wedge gets the same)

- Capsule 60 tall, insets 24. Dock 128, one row: the last-scan strip as a 460 px gray group with **Undo** trailing,
  the actions at the end.
- **Split card**, 980 wide, r 32: the band is a 360 px column at the start, full card height, always stacked (glyph 80,
  headline 52/56); the identity row and up to two panels sit beside it at the wide width, so `columns` and paired
  `list` rows stay on one line. A band-only card (not found) is 600 wide.
- Desk panels keep the header on top, then the template panel (1.25 fr) and the system input (1 fr) side by side;
  presets show; the keypad sits beside the panel.
- Lookup is a 400 px side sheet at the start over the dimmed camera; a picked row opens the desk panel.
- **Camera at the desk:** the camera is always the backdrop; the first decode opens the panel. With **Camera off** in
  the menu, the reader stage takes the camera layer's place.

### 4.4 The buddy's seat

One seat on every screen of `/scan`: the dock's top edge, centred, XL (BF "Dock and buddy"). While a card is up its
violet pass is hidden and the pocket shows a 2 px notch; the outer passes fan to ±24° and carry the beats. Sheets and
dialogs on top hide it (the topmost surface owns the buddy; a sheet has none). Start, Pair, the shift summary and
blocking panels are cards on the card layer, so the buddy stays on the dock for them too.

---

## 5. State catalog

Columns: what shows, the exact copy, the buddy (beat or pose, BM names), the chirp (section 8), and the
announcement (S = `role=status`, A = `role=alert`). Copy lives in `src/shared/copy/scan.ts` (`SCAN_COPY`); the
admin pages and CSV read the same file. `{}` marks values.

### 5.1 Boot

| State | Copy | Buddy | Notes |
| --- | --- | --- | --- |
| Pair this device | h1 **Pair this device** · line **Scan the code in Scanning, or type it.** · label **Pairing code** (placeholder `K7QH2-M9XTR`) · **Pair** · **Scan pairing code** · footer `Lock` **Admins make codes in Scanning.** | M `pair` pose (holds its violet pass up like a key card) | `CodeField length=10 group=5`, Crockford, case-insensitive, separators ignored; mono, tracking .12em |
| Confirm from a link | h1 **Pair this device?** · **As Front door for Northwind Live.** (+ `Test` pill) · **Pair** · **Cancel** | `pair` | `pair/preview` consumes nothing |
| Paired | callout (success) **Paired as Front door.** | `hello`, happy | ok chirp (the Pair tap unlocked audio); S "Paired as Front door." |
| Code not valid (unknown, expired, used) | callout **Code not valid. Ask for a new one.** | flat, the sign-in slip | one answer for all (SA 2.7) |
| Too many tries | **Too many tries. Wait a minute and try again.** | `wait` | |
| Offline | **No connection. Pair when you're back online.** | `cloud` | |
| Scan as admin | title **Scan as admin** · **Organization** (EntityPicker) · **Event** or **Templates** · `ModePill` + **Switch to Test / Switch to Live** · **Continue** | — | prefilled from the last choice |
| Who's scanning? | title **Who's scanning?** · rows: initials, name, role pill · then **{Name}** / **Enter your PIN** · six dots · keypad · **Back** | — (dialog) | wrong PIN: **Wrong PIN. {n} tries left.**; locked: **Too many tries. Try again in 5 min.** |
| Start | h1 **{Front door}** · meta **{Northwind Live}** · event row **{Saturday gala} · Nov 14 · 6:00 PM – 11:00 PM** with **{312 of 500 in}** (or templates) · the event's staff note (`Info`, when set) · **Direction** In/Out (re-entry) · **Start scanning** (`Camera`) | dock seat, one idle beat at 2.4 s | not open yet: line **Scanning opens {4:00 PM}.**; closed: **Scanning closed {11:00 PM}.** Both still scan (heads-up) |
| Scanner removed | **Scanner removed** · **Ask an admin for a new code.** · **Pair again** | `tug` + lock | slate panel; camera and wake lock released; A, focus to the action |
| Pairing expired | **Pairing expired** · **Ask an admin for a new code.** · **Pair again** | `tug` | |
| Organization suspended | **Organization suspended** · **Scanning is off until an admin restores it.** · **Try again** | `tug` | |
| Not set up (session `unassigned`) | **Not set up** · **Ask an admin to choose what this scanner accepts.** · **Try again** | `tug` | event archived or last template deleted (SA 2.8) |
| Settings changed mid-shift (`configRev`) | nothing: the session refetches between scans; capsule, chips, posture and the Test chip follow | — | an open card or drawer finishes first |
| Signed out (admin) | **Signed out** · **Sign in again to keep scanning.** · **Sign in** (`/login?next=/scan`) | sad | |

### 5.2 Aiming and input

| State | Copy | Buddy | Sound / announcement |
| --- | --- | --- | --- |
| Starting camera | status **Starting camera…** (spinner after 300 ms) | `aim` | S "Starting camera." |
| Aiming | status **Ready**; hint **Point at the code** (back) / `ArrowUp` **Hold your code up to the camera** (front) | `aim`, one idle beat | S once: "Ready to scan." |
| Hints | after 4 s **Move back a little**; 8 s **Tilt to cut the glare**; 12 s **Won't scan? Tap Look up.** (front: **Move your phone back a little**, **Tilt your phone to cut the glare**) | lean, first hint only | none |
| Detected (D0) | frame freezes; reticle presses to .96; the lock box (2 px, placed on the code's corners by transform) fades in over 80 ms (opacity, no stroke drawing) | `lock` (eyes on the box) | none |
| Checking (D0 + 300) | capsule line and live pill **Checking…**; with a card still up, the card stays and the pill says it | `rummage` (pending loop) | `tick`; S "Checking." |
| Same code, accepted, < 5 s | chip over the reticle **Scanned just now** (1.5 s) | none | none; S |
| Same code, refused, < 30 s | chip **Same code · {Not found}** | none | none; S |
| Card already open (desk) | chip **Already open** (1.2 s) | none | none |
| Paused (60 s idle on the back camera; back from background) | video dimmed; **Tap to scan** (whole card is the target); status **Paused** | `sleep` | S "Paused. Tap to scan." |
| Switching camera | **Switching camera…**; controls disabled | `aside` | S "Front camera." / "Back camera." |
| Reader stage (camera off or reader only) | **Hold your iPhone near the reader** · **Or scan the barcode at the reader.** | `reader` + rings once | |
| Camera and reader | a line on the camera layer above the dock `Nfc` **Or hold your iPhone near the reader** (barcode reader: **Or scan at the reader**) | rings once from the line's icon | |
| No read on the reader (8 s with a reader configured and activity) | **Not reading? Show the barcode, or search by name.** | none | |

**Camera panels** (replace the feed inside the same card, so nothing shifts; Look up and the reader keep working):

| Panel | Icon | Copy | Actions | Buddy | Announcement |
| --- | --- | --- | --- | --- | --- |
| Asking | `Camera` | **Allow the camera** · **Safari is asking.** | — | `ask` | S |
| Blocked | `CameraOff` | **Camera blocked** · **Allow it in Settings › Apps › Safari › Camera.** (+ **The reader still works.**) | **Look up** (primary in the dock; opens the lookup sheet, no directional copy), **Try again** | `cover`, then points to Look up | A, focus to Look up |
| Unavailable | `CameraOff` | **Camera unavailable** · **Close other apps using it, then try again.** | **Try again**, **Look up** | sad | A |
| No camera | `CameraOff` | **No camera** · **Look up passes, or connect a reader.** | **Look up** | flat | S |
| Decoder failed | `CameraOff` | **Scanner didn't load** · **Reload the page, or use Look up.** | **Reload**, **Look up** | `plug` | A |

### 5.3 Verdicts

Every verdict is the result card (D5) over a full-screen tint and a 10 px ring (BF "Verdict band", "Colour tokens").
The band is system content; the body under it is the identity row and the template's display (5.8). Kinds and holds
(SA 7.5):

| Kind | Tint, ring, band | Solid glyph (shape alone says the verdict) | Band layout | `auto` hold | `choose` | Focus | Region | Chirp | Mood |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ok | green | circle with a check | row (stack when the template sets a title) | 1.2 s; a different code from 0.35 s | tint 1.2 s, then the card stays up untinted until **Done**, the next scan or the idle clear | stays | S | `ok` | happy |
| heads_up | amber | triangle with a mark; a clock mark for time reasons; a refresh mark for `stale` | row | until **Done**, a tap or a different code | holds until **Done** | **Done** (dock) | S | `headsUp` | curious |
| refused | red | octagon with an X | stack | 3 s (`ambiguous`: until a tap) | holds until **Done** or the next scan | stays | A | `refused` | sad |
| system | slate | squircle with a cloud, plug or hourglass | stack | until a tap or any scan | same | first action (dock) | A | `system` | sad |
| queued (v2) | green | circle with a check and a 30 px upload badge | row | 1.2 s | — | stays | S | `ok` | neutral |

Results differ without colour: the glyph shape, the band layout (row for ok and amber, stacked hero for red and
slate), and the order: green leads with the verdict and then the **who**, amber with **when and where** in the sub,
red with the **reason** and only a compact row. Headlines are 40/44 (52/56 on iPad), two lines at most.

**ok** (the band's headline and sub are system copy; "Body" is what the card adds under the identity row besides the
template's display)

| Case | Headline | Sub | Body | Beat |
| --- | --- | --- | --- | --- |
| Check-in | **Checked in** | — | the display (blueprint: Ticket panel) | `hop` |
| Re-entry | **Checked in** | **Back in. Out since {8:12 PM}.** | display | `hop` |
| After an override | **Checked in** | **Let in again.** | display | `hop` |
| Check-out | **Checked out** | — | display | `dip` |
| Bundle | **Checked in** | **{3} more from {Anna}'s group** | chip **{4} of {4} in group** (system, flag slot) | `hop` |
| Stamps | **+{2} stamps** (**+1 stamp**) | **{9} of {10} stamps** | the display's `progress` row animates 7 → 9; new stamps land from T0 + 220 | `stamp` (+ `thump`) |
| Points or balance | **+{120} points** · **+{$5.00}** / **−{$5.00}** | **{1,360} points** · **{$29.50} balance** | `big` or `money` row with this scan's change | points `sparkle`; money `coins` (in on a rise, out on a fall; BM 6.1) |
| Set | **{Balance} set** | **{500} points** | display | `nod`; `coins` on a money input |
| Reward | **Redeemed** | **{Free coffee} · {0} of {10} stamps** | display | `punch` (+ `click`) |
| Coupon (use up) | **Redeemed** | **{20% off}** | display (Offer) | `punch` |
| Goal reached | as above; the check keeps its shape | **{10} of {10} stamps** | the `progress` caption **1 reward ready**; the dock's primary becomes **Redeem reward** | `fan`, `reward` chirp |
| Custom title (template) | the template's title, the verdict word as an eyebrow beside the template icon | as above | display | as above |
| Member photo (template sets `photo`) | **Checked in** (or a custom title) | — | the photo replaces the pass tile in the identity row (96 px phone, 128 iPad); missing: initials + **No photo** | `hop` |
| Saved offline (v2) | **Checked in** | **Saved offline** | note `CloudUpload` **Syncs when you're back online.**; no identity row, no display | `stash` (neutral) |

Announcement: "{System headline}. {Holder}. {Sub}." with "Undo available." on the desk. A custom title follows the
system headline, never replaces it.

**heads_up** (reason, then the variant the card decides). The band is a row with the two-line headline and the when
and where in the sub; the body keeps the identity row, the template's meta, chips and panels (no custom icon or
title), then the notes slot: `notes.staff`, then the event's staff note. Actions sit in the dock.

| Reason | Headline | Sub | Dock | Beat |
| --- | --- | --- | --- | --- |
| `already_done`, check-in | **Already checked in** | **{12 min ago} · {Side door}** (after 60 min **Today {6:29 PM} · {Side door}**); the last-scan strip reads **First in {6:29 PM} · {Side door} · {Sam K.}** (the meta line under the holder belongs to the template) | **Done**, **Let in again** | `wrist` (back) |
| `already_done`, daily | **Already checked in today** | **{9:14 AM} · {Desk iPad}** | **Done**, **Let in again** | `wrist` |
| `already_done`, out | **Already checked out** | **{8:12 PM} · {Side door}** | **Done** | `wrist` |
| `already_done`, out on a pass never in | **Not checked in** | **Check them in instead?** | **Check in**, **Done** | `tilt` |
| `already_done`, use up | **Already redeemed** | **{Nov 3, 2:10 PM} · {Till 2}** | **Undo that redeem** (own, in window), **Done** | `wrist` |
| `cooldown` | **{Stamped} {2} min ago** (verb by kind: Checked in, Stamped, Added points) | **Next {stamp} in {3} min** | **Done**, **Add anyway** / **Let in again** | `wrist` (fwd) |
| `not_yet_valid` | **Not open yet** (pass window: **Not valid yet**) | **Opens {6:00 PM}.** / **Valid from {Nov 10}.** | **Done**, **Let in anyway** | `wrist` (fwd) |
| `ended` | **Event ended** (pass window: **Ended**) | **Ended {11:00 PM}.** | **Done**, **Let in anyway** | `wrist` (fwd) |
| `capacity_full` | **Event full** | **{500} of {500} in.** | **Done**, **Let in anyway** | `wrist` |
| `check_required` | **{Check ID}** (the flag's label) | **Then check them in.** | **Check in**, **Done** | `tilt` |
| `needs_approval` | **Needs a manager** | **{Set balance} is for managers.** | **Manager PIN** (when `approvals`), **Done**; no managers: **Ask an admin to allow it.** | `wrist` |
| `stale` | **Balance changed** | **Now {1,300}. Check it and set again.** | **Review**, **Done** | `wrist` |
| `in_progress` | **Being scanned** | **Another scanner has this pass. Scan again in a moment.** | **Done** | `wrist` |

- Overrides (**Let in again**, **Let in anyway**, **Add anyway**) send a new key with `overrideOf`. Check-in overrides
  follow `letInAgain` (anyone: button; manager: the button leads to **Manager PIN**; never: hidden). **Add anyway**
  (a cooldown on `add`/`take`) is Manager-only whatever `letInAgain` says (SA 2.4): Door and Desk see it lead to
  **Manager PIN**. The result is green with the sub **Let in again.**
- Times: venue time zone (event, else scanner). `6:29 PM`, `Sat, Jun 2`, relative under 60 min.

**refused**

| Reason | Headline | Sub | Card body | Beat |
| --- | --- | --- | --- | --- |
| `not_found` (also another org's code) | **Not found** | **This code isn't a pass here.** (one sub for door and desk; UD's "ticket" wording is replaced) | none: the band is the card (600 wide on iPad) | `peek` |
| `not_found`, offline v2 | **Not found** | **Not on the offline list from {6:58 PM}.** | none | `peek` |
| `ambiguous` | **More than one match** | **Look it up by name instead.** | **Look up** (holds) | `peek` |
| `test_pass` | **Test pass** | **Live scanners don't take test passes.** | template row: neutral tile, **{Event ticket}** (`ScanOutcome.template.name`) + `Test` pill, no meta; nothing from the pass, not even its title: modes never show each other's holders (SA 2.6) | `sign` |
| `live_pass` | **Live pass** | **This is a test scanner.** | template row, as above | `sign` |
| `not_accepted` | **Not accepted here** | **{Gym membership} isn't on this scanner.** | compact row | `shake` |
| `wrong_event` | **Wrong event** | **For {Jazz Night · Sat 8:00 PM}.** | compact row | `peek` |
| `removed` | **Removed** | **Removed {Nov 3}.** | compact row | `tear` |
| `voided` | **Voided** | **Voided {Nov 3}.** | compact row + **Voided** pill | `tear` |
| `expired` | **Expired** | **Ended {Jun 1}.** | compact row | `droop` |
| `no_balance` | **Not enough {stamps}** | **Has {7}, needs {10}.** | the tapped button shakes once | `empty` |
| `managed_elsewhere` | **Set by a connection** | **{Points} come from {Square}. Change them there.** | compact row | `shake` + lock |
| `limit_reached` | **Daily limit reached** | **This scanner's limit resets at midnight.** | compact row | `shake` |
| `add_link` (client) | **Add-to-Wallet link** | **Ask them to open the pass in Wallet.** | none | `peek` |

Refusals use the stacked band (glyph 64, headline on the full measure). The **compact row** is system content: a
neutral 40 px tile with a muted ticket icon (never the pass art), the holder line, the pass title as meta, a neutral
**Voided** pill when voided, no chevron: a refused pass is never shown like an admitted one. Then the notes slot: the
template's `notes.refused` (a literal, ≤ 100) and the event's staff note. No panels, chips or meta on a refusal (D17).
Live/test mismatches show the template name instead (the pass title is often the holder's name): modes never show
each other's holders. HTTP 422 codes
(`SCAN_ACTION_UNKNOWN`, …) render as **Something went wrong** · **Scan again.**

**system** (client-only, never stored)

| Reason | Headline | Sub | Actions | Beat |
| --- | --- | --- | --- | --- |
| `network` | **No connection** | **Scan again. It won't count twice.** | **Done** | `cloud` |
| `timeout` | **No answer** | **Scan again. It won't count twice.** | **Done** | `cloud` |
| `unconfirmed` | **Not confirmed** | **Checking again when you're back online.** | **Done** | `cloud` |
| `still_unconfirmed` | **Still not confirmed** | **Check Recent before trying again.** | **Done**; that card's actions stay locked until reopened | `cloud` |
| `server` | **Something went wrong** | **Scan again.** + `Ref {7F3K}` (`xs` mono) | **Done** | `plug` |
| `rate_limited` | **Too many scans** | **Try again in {20} s.** (text countdown) | none; clears at 0 | `wait` |

System verdicts get a band-only slate card (stacked, squircle glyph); their single action (**Done**) sits in the
dock. They carry no display.

**Milestones** (server-decided, SA `milestone`): the normal green card with a 3 px foil ring around it and six foil
sparks from the glyph (BF), `fan` and the `reward` chirp; the count lives in the capsule. No extra words; the hold never extends. Kinds: `count` (each hundredth at the event),
`all_in` (x = y), `reward` (goal reached on a pass); client-side, this device's hundredth ok of the day.

### 5.4 Desk: desk panel, action area, undo

The desk panel is the card without a band, over the camera dimmed to `rgb(4 6 12 / .55)` (it keeps decoding). Its
header is the pass tile, the holder line (or the review question) and the meta; then the template's panels (the
`ready` display); then the system action area. The commit pair replaces the dock's thumb row. Sheets:
`b-final-phone-desk-*`, `b-final-ipad-desk-*`.

| State | Shows | Copy |
| --- | --- | --- |
| Idle (`choose`, nothing scanned) | the live camera with the reticle; the dock's thumb row | live pill **Scan a pass** (with a reader: **Scan a pass or hold it near the reader**); **Look up** in the dock |
| Desk panel | header (tile or photo, holder line, meta `{Gold} · {Coffee card}`, flags and chips, **No photo**, chevron) · bundle meta **In {Family pack} ({3})** · the template's panels (≤ 2) · notes · the dock: actions (first primary, the next as gray, the rest and locks in **More**) and a reason line under a disabled action. The status line and the last 3 scans with **Undo** are in the `PassSheet` behind the chevron (BF's desk cards have no room for them) | `PassSheet` status line: **{Active} · Valid until {Dec 31, 2026}**, coupon **Active · Use by {date}**; disabled: **Not enough stamps to redeem.**, **Next stamp in {8} min**; empty: **No scans yet.** |
| Amount, stepper (counts with a goal) | only the first template panel, its `progress` row previewing the draft (pending stamps outlined), then the system input: title, hint, − value +, presets (iPad); dock **Cancel** · verb | **Add stamps** · **Up to {5} per scan.** · **Add {2} stamps** · **Use on next scan** |
| Amount, keypad (numbers) | the first template panel previewing the draft (`money`: old struck, new large), the readout; phone: the keypad in a dock tray with the commit pair above it, and the panel's `history` row shows its newest item only while the tray is open (DM 1.2); iPad: beside the panel | **Add points** · **Enter an amount** (disabled at 0) · **Up to {1,000} per scan.** (danger when over) |
| Amount, set | empty field, placeholder = current value; readout **1,240 → 500** **points · −740** | **Set balance** · commit **Review** |
| Review | header with the question; before (17/22 muted) → after (28/32); the consequence; the template's first panel under it; dock **Back** · verb | Set: **Set to {500} points?** · **Replaces the current balance.** · **Set balance**. Reward: **Redeem {1} {Free coffee}?** · **Uses {10} stamps.** · **Redeem**. Coupon: **Redeem {20% off}?** · **Active → Used** · **It can be used once.** · **Redeem**. Large add: **Add {800} points?** · **More than usual for one scan.** · **Add {800} points** |
| Locked commit | review face; the dock's primary reads **Ask a manager** (`ShieldCheck`) | the panel turns into **Manager PIN** · **Approves: {set balance to 500 points}.** · manager row (**Change**) · six dots · keypad; no template content |
| Applying | the dock's verb busy (keeps width); **Saving…** after 300 ms | |
| Applied | the panel tucks and the green card rises (5.3 ok); after 1.2 s the tint fades and the card stays up; the strip offers **Undo**; a reached goal makes **Redeem reward** the dock's primary | as 5.3 ok |
| Undone | the strip reads `Undo2` **{Add stamp} undone**; the panel's `progress` row returns to **{7} of {10} stamps** | `rewind`, `undo` chirp; S |
| Can't undo | amber card **Can't undo** · **Too late to undo here. An admin can fix it.** / **The pass changed since. An admin can fix it.** | |
| Another pass scanned with a draft | a strip drops from the panel's top edge **Another pass was scanned.** · **Switch** · **Keep editing**; with no draft the panel tucks and the new card rises | `headsUp` chirp |
| Ready action armed | capsule chip **Ready: {Add stamp} ×**; live pill **Ready: {Add stamp}**. No reader: **Scan the pass.** · **Each scan {adds 1 stamp}.** · **Cancel** in the dock. NFC reader: reader rings in the reticle's place, **Hold your iPhone near the reader** · **Or scan the barcode. Each scan {adds 1 stamp}.** | rings once; S "Ready. Add stamp. Waiting for a scan." |
| Ready action doesn't apply | the panel opens with the line **Ready action doesn't apply to this pass.** | |
| Card idle clear | after 60 s untouched the card tucks (off with **Keep results until tapped**) | |

### 5.5 Lookup

| State | Copy |
| --- | --- |
| Field | placeholder and hidden label **Name, email or code**; `type=search`, `enterkeyhint=search`, no autocorrect |
| 1–2 letters | **Type 3 letters or more.** |
| Partial email | **Type the full email.** |
| Code typed | **Press Enter to look up this code.** |
| Searching | 3 skeleton rows after 150 ms |
| Results (≤ 10) | row: initials or photo · title · status pill (**In {6:29 PM}** success, **Out {8:12 PM}** neutral, **Voided**/**Removed** neutral, muted row) · meta **{Saturday gala} · a•••@g•••.com** · `ChevronRight`; footer **{3} results** / **Showing 10. Type more to narrow.** |
| No matches | inline empty, lens art S: **No matches** · **Check the spelling, or use the full email.** |
| Rate limited | **Too many lookups. Try again in {40} s.** |
| Offline | **Look up needs a connection.** (field disabled) |
| Pick | the sheet closes and the desk panel rises; the field clears; focus to the panel heading; S "{4} results." on each result change |

A burst from a reader inside the field is a scan (the field restores and the code goes to checking). `/` focuses the
field; ↓ enters the results; Esc clears then blurs.

### 5.6 Chips

| Chip | States |
| --- | --- |
| Count | event scanners: phone **{312}/{500}**, wide **{312} of {500} in** (re-entry: **{290} in · {22} out**); template scanners **Today {42}**. Width reserved for the longest value; `CountUp` from the last value |
| Reader | **Reader** (configured, nothing read yet) · `●` **Reader ready** · amber **Reader paused** (tap refocuses) · amber **Set the keyboard to U.S.** |
| Sync | slate `CloudOff` **Offline** (+ badge with the queue count); **Syncing {3}**; amber **{3} not synced** after 10 min |
| Ready action | accent **Ready: {Add stamp}** with × |
| Test | `ModePill` **Test** on test scanners, first in the capsule |

### 5.7 Recent, undo, shift

- **Last-scan strip** (dock, 40 px): a 24 px verdict disc, the holder (or **Unknown code**), the meta **{Checked in}
  {6:42 PM} · {Camera}** and **Undo** (44 × 44) while this device can undo. At T0 it becomes this scan; on amber it
  reads **First in {6:29 PM} · {Side door} · {Sam K.}**. Tapping it opens **Recent** as a sheet (20 rows).
- **Recent row** (`ListRow`): outcome icon in its status tone (`success`, `warning`, `danger`, `fg-muted`), title (or
  **Unknown code**), meta **{Checked in} · {6:41 PM} ·** method icon (`Camera`, `ScanBarcode`, `Nfc`, `Keyboard`),
  trailing **Undo** (ghost `sm`) while undoable. Undo has no confirm; the row swaps to the pill **Undone**; failure:
  `toast.error(error, 'Could not undo')`. S "Check-in undone. Anna Meyer."
- **This shift** sheet: **{312} of {500} in** with a bar · **You: {128} checked in · {9} refused · {3} undone** ·
  **Started {6:02 PM} · {2 h 41 min}** · v2: **{3} waiting to sync** with **Sync now** · **End shift**.
- **Shift ended** (a card on the card layer; the camera stops): **{128}** **checked in** (desk: one stat per action with a non-zero count) ·
  **{9} refused · {3} undone · {4} looked up** · **{6:02 PM} – {8:43 PM} · {Front door}** · event bar · **Start new
  shift**. Unsynced: warning callout **{3} scans haven't synced. Keep this page open while online.** Buddy `count`.
- **Unpair this device?** · **You'll need a new code to scan here.** (+ **{3} unsynced scans will be lost.**) ·
  **Unpair** (danger).

### 5.8 Result content: what a template can say (DM)

Per template ("per card"), stored in the template package as `scan.display`, edited in the Scan screen mode (10.8).
Data can come from anywhere on the pass: inputs, the pass's front and back fields as Wallet shows them, pass facts
(status, validity, created), this scan, scan history (visits, last visit, the value ledger), the event and the scanner.

**Who owns what on the card** (top to bottom, every screen; DM §1.2):

| Slot | Owner | What staff see |
| --- | --- | --- |
| Tint, ring, band: glyph, headline, sub, hold rail | system | the verdict, always `SCAN_COPY` ("+2 stamps", "Voided Nov 3.") |
| Custom icon, custom title | template, `ok` only | the icon leads the band with the verdict glyph as a badge; a title moves the verdict word to an eyebrow |
| Pass tile or member photo | system (the template only turns the photo on, per role) | the ID check |
| Holder line | system, always shown (the template picks its source) | "Anna Meyer" |
| Meta line | template (`header.subtitle`), else the pass subtitle | "General admission" |
| Flags, then chips | flags system; ≤ 2 chips template (gold, violet, teal, neutral; never green, amber or red) | **VIP** · **Table 12** |
| Panels | template, 0-2 shown (1 while an amount control is open), none on refusals | Ticket, Access, Loyalty… |
| Notes | template staff note (not on refusals), the refused note (refusals only), then the event's note (heads-up and refused) | "Wristbands at Gate C tonight." |
| Action area, last-scan strip, buddy | system | Undo, Let in again, Done, Redeem reward, the stepper |

**Panels** are the "additional information cards". They share one frame (16 px icon, 13/600 label, the row rhythm) and
differ only by their rows. The catalogue starts each one: **Membership** (tier, member since, expires, last visit,
visits this month), **Loyalty** (stamps or points, rewards ready, last stamps), **Balance** (credit with this
transaction and the ledger), **Ticket** (Section · Row · Seat · Gate, ticket type, doors, room), **Offer**, **Access**
(perks and zones), **Details** (front fields) and **Note**. Rows: heading, field, big value, columns (2-4), progress
(stamps or bar), money, history, image (thumbnail or strip), chips, list, note, divider. No row is ever a button, a
link, a phone number or an email.

**Rules that keep every card designed:** at most two panels and six density units per result, less what the header
takes on that screen (a custom title 2, heads-up 2, a photo 1, a second chip line 1, a staff note 1; DM 1.6). Over
budget on **Checked in** can't be saved; on heads-up and the desk card the server cuts trailing rows. So a valid card
fits a 390 px phone without scrolling (BF measured: limit 443 px, the six owner examples fit with 7-15 px to spare);
the band's custom title is plain text plus, at most, the holder's name (**Welcome back, {Maya}**), up to 2 lines
(28 characters; a title that can take 2 lines costs 1 more unit); a name that doesn't read as one (more than 3
words, digits or symbols, or a verdict word such as "Refunded") shows the plain verdict headline instead; no other
field reaches the band; `columns` stay on one line on a phone only when every value fits the compact cap (four values of ≤ 4
characters: "104 · F · 12 · C"), else two per line; bound text that is missing hides its row instead of printing
gaps; header **variants** switch the icon, title, meta and chips by a rule ("tier is VIP"), first match wins;
**Show when** hides a panel, row or item by a rule; **Who sees it** hides it from Door (or Door and Desk).

**Defaults.** A template with no `scan.display` shows a Details panel built from its first front fields. Blueprints
ship displays, copied by **Use blueprint**: Event ticket a Ticket panel (Seat, Ticket, Doors, Room); **Balance card**
a Balance panel (the balance as its primary value and the last transactions; Charge, Top up, Set balance for a
Manager; the buddy's `coins`); **Stamp card** a Loyalty panel (the stamp grid and **1 reward ready**; Add stamp,
Redeem reward; the buddy's `stamp` for a stamp, `punch` for a reward); Coupon Offer; Generic Membership. The two cards differ at a glance in the
gallery, on the pass and on the scan screen; their palettes, strip images and tiles come from `scratchpad/template-identity/`.
Rendered: `b-final-phone-custom-*` (VIP, gym, coffee = Stamp card, prepaid = Balance card, coupon, the event blueprint).

**Copy rules for the display:** author text is plain, sentence case, one language per template; the editor warns on
verdict words (refused, denied, invalid, expired, voided, not valid, already, stop, refunded, cancelled, blocked, banned): an
error in the band title, a warning in literal meta, chips, panels and notes. System
captions ("1 reward ready", "2 more for Free coffee", "Changed elsewhere", "No photo", "Low balance") come from
`SCAN_COPY`.

---

## 6. Components

### 6.1 Reused (one implementation each)

`ModePill` (the capsule's **Test** chip) · `Button` (`sm`/`md`/`lg`, `busy`, `done`) · `IconButton` · `StatusPill`, `StatusIcon` · `ListRow` ·
`Card` · `Dialog` (bottom sheet < 640) · `Sheet` · `Input`, `Field` · `SegmentedControl` · `OptionTile` ·
`SwitchRow` · `EmptyState inline` · `ErrorState` · `Skeleton` · `LoadingRail` · `Spinner` · `CountUp` ·
`Celebrate` · `toast` · `EntityAvatar` · `CodeField` (moved from `portal/` to `ui/`, `length` and `group`) ·
`SecretReveal` · `PassCard`/`PassCardStage` (`barcode={false}`) · `Buddy`/`BuddyArt` (beat API, BM 2.1) ·
`Scan` sign from `portal/add/scan.tsx` (the admin pairing QR) · `LineChart` (admin dashboard) · `lib/gaze.ts`
(caret gaze, shared with sign-in).

### 6.2 New on `/scan` (`src/web/scan/`, names as SA 3.3)

| Component | File | Does |
| --- | --- | --- |
| `ScanShell` | `ui/scan-shell.tsx` | the layers in BF z-order: camera, verdict tint, card layer, dock, buddy, capsule, ring; live regions |
| `Capsule` | `ui/capsule.tsx` | title button, state line, chips, menu (2.3) |
| `CountChip`, `ReaderChip`, `SyncChip`, `ReadyChip`, `TestChip` | `ui/chips.tsx` | 5.6 |
| `StartPanel` | `ui/start-panel.tsx` | 5.1 Start, as a card |
| `CameraLayer` | `ui/camera-layer.tsx` | feed, reticle, live pill, lock outline, dim |
| `CameraPanel` | `ui/camera-panel.tsx` | 5.2 panels |
| `ReaderStage` | `ui/reader-stage.tsx` | reader prompt, rings in the reticle's place, no-read hint |
| `VerdictTint` | `ui/verdict-tint.tsx` | scrim, per-kind pre-painted wash, the 10 px ring with its inner glow |
| `Dock` | `ui/dock.tsx` | strip and thumb row; amber pair; desk commit pair; phone keypad tray |
| `LastScanStrip` | `ui/last-scan-strip.tsx` | 5.7 |
| `RecentScans` | `ui/recent-scans.tsx` | the Recent sheet; Undo |
| `ShiftSheet`, `ShiftSummary` | `ui/shift-*.tsx` | 5.7 |
| `ScanMenu` | `ui/scan-menu.tsx` | 2.4 |
| `LiveAnnouncer` | `ui/live-announcer.tsx` | two persistent regions |
| `Keypad`, `PinDots` | `ui/keypad.tsx` | one keypad for amounts, staff PINs and Manager PINs |
| `ApprovalPanel` | `ui/approval-panel.tsx` | Manager PIN, as a desk panel |
| `CardLayer` | `result/card-layer.tsx` | FLIP from the violet pass's box: rise, tuck, interrupt swap; z 9 / 11 |
| `ResultCard` | `result/result-card.tsx` | band, identity row, display, notes (5.3, 5.8) |
| `VerdictBand`, `VerdictGlyph` | `result/verdict-band.tsx`, `result/verdict-glyph.tsx` | row, stack, stack custom, split (iPad); solid glyphs; custom icon with the verdict badge; hold rail |
| `IdentityRow` | `result/identity-row.tsx` | pass tile or photo, holder line, meta, flags and chips, chevron; compact pass row |
| `NotesSlot` | `result/notes-slot.tsx` | staff, refused and event notes |
| `PassSheet` | `result/pass-sheet.tsx` | the full `PassCard` (no barcode) behind the chevron, lazy `pass` chunk |
| `DisplayPanels`, `Panel`, row components, `ScanChip`, `scanIcon` | `display/*` | paint a `ScanDisplay`; the designer's canvas imports them |
| `BlockPanel` | `boot/block-panel.tsx` | removed, expired, suspended, signed out |
| `PairCard`, `PairConfirm` | `boot/pair-*.tsx` | 5.1 |
| `AdminScopeSheet` | `boot/admin-scope.tsx` | Scan as admin |
| `StaffSheet` | `boot/staff-sheet.tsx` | Who's scanning? |
| `LookupSheet`, `LookupResults` | `lookup/*.tsx` | 5.5 |
| `DeskPanel` | `desk/desk-panel.tsx` | the ready view for both postures: header, template panels, action area |
| `ActionArea`, `Stepper`, `Review` | `desk/action-area.tsx`, `desk/stepper.tsx`, `desk/review.tsx` | the system input under the first panel |
| `ScanBuddy` | `buddy/scan-buddy.tsx` | dock seat, XL, `card` prop, beat, pose, mood, props (BM 2.2) |

### 6.3 Tokens

`src/web/scan/ui/scan.css` and `result/result.css` (scan chunks only). Verdict hues are theme-invariant (band, glyph,
ring, strip disc); BF "Colour tokens" has every value:

| Token | Fill | `-on` | Contrast |
| --- | --- | --- | --- |
| `--scan-ok` | `#22c55e` | `#04170b` | 8.1:1 |
| `--scan-heads` | `#f59e0b` | `#1f1600` | 8.3:1 |
| `--scan-refused` | `#b91c1c` | `#ffffff` | 6.5:1 |
| `--scan-system` | `#334155` | `#ffffff` | 10.4:1 |

Full-screen layers differ by theme (deeper and more opaque in dark, for a dark venue): scrim, one wash per kind and
the ring (10 px plus an inner glow). The card, inset, glass, text, line, fill-gray and accent tokens, chip tones
(gold, violet, teal, neutral; each ≥ 4.5:1 in both themes) and template tones (violet, teal, gold; they colour stamps,
progress fills, list icons and the caption gift, nothing else) are BF's. `verdict.test.ts` checks every pair ≥ 4.5:1
from resolved tokens.

### 6.4 Shared-file asks (owners in SA 16.3)

`PassCard barcode={false}` and `usePassView` move (b) · beat API, `TEAR` export, the `xl-scan` tier and the `card`
prop, entity art `scanner`/`stub`/`badge` (h0) · `CodeField` move (j) · `lib/gaze.ts` (h0, j) ·
`lib/{nav,entities,status,actions,confirms}.ts` (h0) · rename `ENTITY.activity` label to **Entry** (h0, n1). `/scan`
no longer needs `AppShell` or `ModeBand` props: its shell is its own.

---

## 7. Feedback stack and the buddy

### 7.1 Timeline of one scan

BF "Motion" is the build spec (all transform and opacity; ms from the verdict, T0):

| t | Screen | Sound | Buddy | Words |
| --- | --- | --- | --- | --- |
| D0 read | frame freezes, reticle presses to .9, lock outline | — | `lock` (camera) / `catch` (reader) | — |
| D0 + 300 | capsule and live pill **Checking…** | `tick` | `rummage` | S "Checking." |
| T0 verdict | tint, scrim and ring fade in over 80 ms (pre-painted layers, opacity only); the card takes the violet pass's exact box | main chirp | mood swaps, old beat cut; violet pass hidden (`card="out"`) | S or A sentence |
| 0 – 380 | the card rises (210), overshoots and settles (380); the violet skin lifts off in 60; glyph or icon pops from 60; text rises 4 px from opacity .6; reticle and live pill fade; the strip becomes this scan | | | |
| 150 – 700 | | garnish at 350 (`thump`, `click`) | result beat on the outer passes | |
| 220 + 90k | new stamps land | | | |
| 350 | a different code is accepted (interrupt: the old card tucks in 150 behind, the new one rises in its colour) | | earliest cut | |
| hold | the rail runs: ok 1200, refused 3000, amber until **Done**; then the card tucks (180) into the pocket | | violet pass back | |

Reduced motion: the card cross-fades in place over 120 ms; no rise, tilt, scale, rail, sparks or beats; the tint
switches at once; the buddy shows each beat's still (BM 10: the lens held for `peek`, the tear for `tear`, the plate
for `sign`, the hole for `punch`).

### 7.2 Buddy per state

One seat, the dock (D13); the table gives pose, mood and motion.

| State | Mood | Motion |
| --- | --- | --- |
| Pair | neutral | `pair` pose; falls in once per page load |
| Paired | happy | `hello` |
| Start | neutral | one idle beat at 2.4 s |
| Aiming | neutral | `aim` pose, eyes up at the reticle |
| Detected / checking | neutral | `lock`, then `rummage` (the only loop, ≤ 4.7 s); with a card still up, no rummage: it keeps its pose |
| Each verdict | by kind (5.3) | the card leaves from its pocket (`card="out"`), then the beat from 5.3 on the outer passes |
| Desk panel opens | neutral | `glance`; the violet pass is the panel |
| Lookup | neutral | sheets hide it |
| Reader stage, armed | neutral | `reader` pose, `rings` once per trigger |
| Camera blocked | flat | `cover` (1.2 s), then points to Look up |
| Paused | neutral | `sleep`; `wake` on the tap |
| Blocking panels | sad | `tug` with the lock |
| Shift ended | happy (flat with no ok) | `count` |

Rules: one buddy (`useRegisterBuddy`); sheets and dialogs on top hide it; `aria-hidden`, `pointer-events: none` (a
gloved dismiss tap is never eaten); colour, glyph and words always carry the result.

---

## 8. Sound

BM 12, synthesized with Web Audio (no files, no CSP change), unlocked by the first tap (**Start scanning**, **Pair**,
**Tap to scan**, the Sound toggle). On by default, remembered per device (`passbook-scan-sound`), toggled in the
header and the menu; turning it on plays `ok` once. Contour carries meaning: up yes, down no, flat repeat look, low
step ours.

| Chirp | Use |
| --- | --- |
| `ok` (rising 1175 → 1568 Hz, 110 ms) | green, paired, queued |
| `reward` (three rising notes, 300 ms) | milestones, reward ready |
| `headsUp` (two 784 Hz triangles) | amber, a pass scanned mid-picker |
| `refused` (two falling low triangles) | red |
| `system` (523 then 392 Hz) | slate |
| `undo` (short falling) | undone |
| `tick` (2 kHz, 25 ms, quiet) | still checking at D0 + 300 |
| `thump`, `click` garnishes | `stamp`, `punch` impacts |

Never: the same code in its ignore window, a card opening, poses, admin pages. `navigator.audioSession.type =
'playback'` where present [U]. No haptics are promised on iPhone.

---

## 9. Accessibility (WCAG 2.2 AA)

- **1.4.1** Each verdict has its own colour, solid glyph shape (circle, triangle, octagon, squircle), band layout (row
  or stacked), verb and order (who first on green, reason first on red). A custom icon always carries the verdict
  glyph as a badge.
- **1.4.3 / 1.4.11** Band on-colours ≥ 6.5:1, chips and muted text on inset ≥ 4.5:1, glass text ≥ 7:1 on every tint
  (6.3); stamps, bars, the ring and the reticle ≥ 3:1; tested from resolved tokens.
- **1.4.10** Reflow at 320 CSS px and 200 %: the card body scrolls inside the card under its band, group rows go two
  per line, no horizontal scroll.
- **2.1.1** Everything works by keyboard (iPad Magic Keyboard, desktop): Esc dismisses a card or closes a sheet,
  Enter commits, arrows drive the stepper, `/` focuses lookup. The wedge detector ignores human typing.
- **2.2.1** **Keep results until tapped** turns off every timed dismissal and the card idle clear; the undo window is
  shown, not hidden.
- **2.2.2** Only pending indicators loop (spinner, rail, rummage); idle art moves once; the admin dashboard has
  **Pause updates**.
- **2.3.1** One tint transition per verdict, at most one per 350 ms (under three a second).
- **2.4.3 / 2.4.11** Focus moves only to **Done** (dock) on amber, to the first dock action on slate, into the action
  area's field, and to the panel heading after a search pick; the dock reserves its height, so nothing it covers takes
  focus.
- **2.5.8** 44 px targets on touch; dock buttons 50, **Undo** 44 × 44, keypad keys 48; chips get a 44 px hit area.
- **3.3.1** Amount and PIN errors are text tied with `aria-describedby`.
- **4.1.3** Two persistent live regions; `alert` only for red, slate and blocking panels; one sentence each, starting
  with the system headline (a custom title follows it).
- Camera preview, the pass tile and the buddy are `aria-hidden`; the camera layer is a `region` "Camera" with a
  hidden status. Stamps are `role="img"` ("7 of 10 stamps"). Display text is plain text in `dir="auto"`. `lang="en"`; numbers in the device locale.
- Light and dark from tokens (the verdict hues are invariant, 6.3); checked at 390, 820, 1180 and 1440.

---

## 10. Admin side

All pages are platform-admin only (SA D3), follow the console's list, dialog and tabbed-detail patterns, filter lists
by the n6 mode, and in Test mode carry the band.

### 10.1 Nav and frame

- Nav: **Scanning** (`ScanLine`) in the Messages group, replacing **Scanners**. Route `/admin/scanning?tab=`
  (`devices` default, `events`, `zones`, `staff`, `scans`; 2026-11-05: **Devices** replaces Scanners, 16.5, and
  `?tab=scanners` redirects; **Zones**, 17.2); details `/admin/scanning/scanners/$id`,
  `/admin/scanning/events/$id`.
- `PageHeader` **Scanning**; one primary per tab: **New scanner**, **New event**, **Add staff**; Scans has **Export
  CSV** (outline). Palette: **New scanner**, **New event**, **Add staff**.
- Entities: `scanner` (`ScanLine`, art: a phone frame whose scan line sweeps), `event` (`CalendarCheck`, art: a
  ticket stub whose hole pops), `staff` (`IdCard`, art: a lanyard badge that swings).

### 10.2 Scanners and pairing (mockup `admin-scanners`)

- **List:** Name (`RowLink`, second line `Safari on iPhone` / `Till · token` / **Not paired**) · Status (**Online**
  seen < 2 min, **Offline**, **Not paired**, **Revoked**; + `ModePill compact`) · Accepts (event chip or
  **{2} templates**) · Staff (signed-in name, **Sign-in off**, —) · Today · Last seen · actions (**Pair**/**Pair
  again**, **Duplicate**, **Revoke** last). Not-paired rows show a ghost **Pair**. Revoked behind **Show revoked
  (n)**. Polls every 30 s while visible; a changed pill rings once.
- **New scanner** (`md`): **Name** (placeholder **Front door**, help **Shown on scans as where they happened.**) ·
  **Organization** (only with All organizations) · **How it scans**: **Browser** / **Till** · **Accepts**: **An
  event** / **Templates** · **On scan**: **Do the first action at once** / **Show the actions** (`flow`) · **Ask staff
  for their PIN** (checkbox), else **Without sign-in, scans as** **Door** / **Desk** · **Let in again**: **Anyone** /
  **Managers** / **Never** · **Reader**: **None** / **Barcode reader** / **NFC reader** · **Look up by name**
  (switch) · **Keep scanning offline** (event scanners, v2; help **Check-ins only. Keep the page open to sync.**) ·
  **Daily limit** (optional amount). Footer **Cancel** · **Create and pair** (Browser) / **Create** (Till: the token
  shows once in `SecretReveal`, label **Token**, **I saved the token**).
- **Pairing face** (New scanner, **Pair**, **Pair again**): the buddy's sign (`Scan` component, buddy M `pair`
  pose) with the QR of `{origin}/scan#pair=K7QH2M9XTR` (`location.origin`, never a hard-coded host: wallet.plrs.im
  and passbook.mobile both serve); beside it `Smartphone` **On the scanner** ·
  **Open the camera and scan this code.** · **Or open {host}/scan and type** `K7QH2-M9XTR` + **Copy** · muted
  **Using the Home Screen app? Pair inside it.** (it has its own cookies; AC §6.3) ·
  **Expires in 9:42** (outside the live region). Status line **Waiting for the scanner…** (polls every 2 s). Footer
  **Pair this browser** (outline; `pair-here`) · **Close**. Paired: crossfade to the scanner art, buddy `hello`,
  title **Front door is paired**, line **Safari on iPhone · Paired just now**, **Done**; Test scanners add **Show a
  test pass**. Expired: QR dims, **Code expired.**, **New code**, buddy shakes its head.
- **Pair again?** · **The device using it now signs out at its next scan.** · **Pair again**. **Revoke Front door?**
  · **The device stops scanning at once. Its scans stay.** · **Revoke** (danger). **Make Front door live?** · **It
  starts accepting live passes and stops accepting test ones.** · **Go live**.
- **Detail:** header with status, mode, last seen, Accepts, `MetaLink` **Scans**; actions **Pair again** · **Go
  live** (test) · More (**Duplicate**, **Show a test pass**, **Replace token** for tills, **Revoke**). `TwoPane`:
  Settings (the dialog's fields, `SaveBar`), Activity (`LineChart` + **Done · Heads-up · Refused · Undone** counts as
  `CountLink`s), Recent scans; aside Device (`Safari on iPhone`, paired, last seen, signed in, reader seen), How
  (**Camera 92% · Reader 6% · NFC 0% · Manual 2%**), Danger.

### 10.3 Staff and rights (mockup `admin-staff`)

- **List:** initials + name · role pill (**Door** `DoorOpen`, **Desk** `Store`, **Manager** `ShieldCheck`) · PIN
  (**Set {Nov 2}** or the warning pill **Locked**) · Today (`CountLink`) · Last scan (**{2 min ago} · {Front
  door}**) · menu (**Edit**, **Reset PIN**, **Disable**). Disabled behind **Show disabled (n)**. Staff have no mode.
- Callout (info) when some scanners don't ask for a PIN: **{Front till and Lobby iPad} don't ask for a PIN, so their
  scans don't name staff.** · **Scanners**.
- **Add staff** (`md`): **Name** (help **Shown on scans and to other staff on the scanner.**) · **Role** as three
  `OptionTile`s: **Door** *Look up passes and check in.* · **Desk** *Also add, take and use up.* · **Manager** *Also
  set values, go over limits, let in again and undo any of that scanner's scans today.* · help **A PIN is shown once after you add
  them.** Then `SecretReveal`: **{Priya S.}'s PIN** `482 019`, **Copy PIN**, **I saved the PIN**.
- **Reset {Sam K.}'s PIN?** · **Their old PIN stops working at once.** **Disable {Sam K.}?** · **They can't sign in
  to scanners. Their scans stay.** (danger).
- What each role may do is the template's business: each action's **Who can do it** (10.5). The tiles above are the
  ladder's summary; section 3 is the full matrix.

### 10.4 Events and the live dashboard (mockup `admin-event`)

- **Events list:** Name (templates as line 2) · When (event time zone, `(PT)` when it differs) · Status
  (**Upcoming**, **Live** `Radio`, **Ended**, **Archived**) · Checked in (**{312} of {500}**) · Scanners.
- **New event** (`md`): **Name** · **Templates** (1–20; templates without a check-in read **No check-in action**,
  disabled) · **Only passes where** {input} = {values} (help **Leave empty to admit every pass of these
  templates.**) · **Scanning opens** / **Scanning closes** (`DateTimeField` + zone) · **Capacity** (optional) ·
  **Allow re-entry** · **Note for staff** (optional, ≤ 140; help **Shown on scanners at the start and on heads-up and
  refused results.**) · **Scanners** (moves them here). Create opens the dashboard with **Event created** and next
  steps **Add a scanner**, **Assign scanners**, **View passes**.
- **Dashboard:** header with status, window, templates, the staff note, and **Result screen: {Saturday gala ticket} ·
  Edit** per template (the template's Scan screen mode, `?mode=scan`; more than 3 templates: **{5} templates**, a menu
  of the same links); actions **Pause updates** (live only), **Open scanner**
  (`/scan?event=`), More (**Edit**, **Assign scanners**, **Export CSV**, **Archive**). Polls every 5 s while visible.
  - Hero (2 columns, buddy S): **Checked in** · **{312}** **of {500}** · **62%** · 8 px progress bar
    (`aria-valuetext`) · `CountLink`s **{188} not checked in ›** (the door list: passes filtered) and **{312} checked
    in ›** · **{3} let in again** · re-entry adds **{340} entries**.
  - **Per minute:** **{18}** **last 5 min**, `LineChart` of 30 one-minute points, **Peak {41} at {6:24 PM}**.
  - **By scanner:** online icon, name, staff, In, Last 10 min (number + single-hue bar), Heads-up, Refused, Last scan;
    not-paired rows show **Pair**.
  - **Heads-up and refused:** reason rows with counts, each a link into Scans filtered.
  - **Latest scans:** 20 rows (outcome icon, time, pass, result, where · who, method icon); new rows get the insert
    highlight; no live region except a throttled hero announcement (30 s).
  - Upcoming: **Opens {Nov 14, 4:00 PM}** + **Readiness** (**Scanners: 2 of 3 paired**, **Online now: 1**, **Pair**
    per scanner). Ended: totals and **Arrivals** chart.
  - Buddy: `count` on open; `wave` at the first check-in seen live; `cheer` + sparks when everyone's in; each once
    per event per browser.

### 10.5 Template designer: Scanning and NFC (mockup `admin-designer`)

Outline: … Inputs · Barcode · **Scanning** · **NFC** · Relevance (n5's designer, additive files).

- **Banner:** barcode bound to the scan code: success **The barcode is the scan code. Scanners can tell every pass
  apart.**; bound to an input: info **Scanners match this barcode by its text. Two passes with the same text can't be
  told apart.** · **Use scan code**; static: warning **Every pass has the same barcode, so scanners can't tell them
  apart.** · **Use scan code**; none: warning **Scanners need a barcode or NFC to find these passes.**
- **Actions** (1–6, drag to reorder; the first carries **First**; help **Scanners set to "Do the first action at
  once" run the first one.**). Row summary examples (plurals via `Intl.PluralRules`): **Once per event · Door**,
  **+1 stamp · every 5 min · Desk**,
  **−10 stamps · Desk · Confirm**, **Staff type points · Managers · Confirm**, **Voids the pass · Desk · Confirm**.
  No `scan` block shows the implied **Check in** with **Default**.
- **Inspector:** **Label** (help **The button staff press.**) · **Does**: **Check in** · **Add to a number** ·
  **Take from a number** · **Set a value** · **Use up the pass** · **Number** / **Input** · **Amount** (fixed, unit
  from the input) or **Staff enter the amount** with **Up to**, presets · **Repeat**: **Once** (under an event: **Once
  per event.**) · **Once a day** · **After a wait** + minutes · **Any time** · **Who can do it**: **Door staff and
  up** · **Desk staff and up** · **Managers only** · **Confirm before applying** (+ **Confirm above**) · **Allow
  check in again** (check-in) · **Reward name** (take) · **Notify the holder** (help **Uses 1 of 3 notifications a
  day per pass. Past that it updates silently.**; off by default) · **Allow on connected passes** (help **The value
  becomes manual and the connection stops changing it.**) · **Record the time on the pass** (check-in; date input).
- **On the scanner:** an inert strip of the buttons as staff will see them.
- **Lookup and rules:** **Look up by** (member, card or ticket number input), **Window** (from/until inputs, early/late
  minutes), **Flags** (≤ 4, **Stop and check** switch). What the result card shows (the old **Values** and
  **Identity**) moved to the **Scan screen** mode (10.8); this section links to it: **Result screen** · **Edit scan
  screen**.
- **Issues** (SA 4.1 codes): **{Label}: pick a number.** · **{Label}: {input} isn't a number.** · **Two actions are
  called {Label}.** · **{Label}: amount is outside {input}'s range.** · **{Label}: wait must be 1 minute to 7
  days.** · **Up to 6 actions.** · **Scanners can't tell passes apart by this barcode.** (warning) · **{Label}
  notifies holders on every scan.** (warning) · **NFC is off for passes signed by {identity}.** (info).
- **NFC section:** **Hold near reader (NFC)** switch, disabled with **NFC needs an approved certificate.** and **Set
  up NFC** until every gate allows it (SA 10.2); when on: **Message** *Scan code of the pass* (fixed), **Ask for
  Face ID first** (help **Turns off sharing of the pass.**), muted **The barcode stays as a fallback.**

### 10.6 NFC setup (mockups `admin-nfc`, `admin-nfc-test`)

- **Apple identity page, NFC card** (n2), replacing the bare switch. Pill **Not approved** / **Approved** /
  **Ready**. Checklist: **Apply to Apple** (Team ID, Pass type ID, reader **Dot Origin VTAP100**, **Open Apple's
  form**) · **Upload the NFC certificate** (**Rotate certificate**) · **Mark as approved** (confirm **Mark {label} as
  NFC approved?** · **Only after Apple approves. Passes signed without NFC approval may not add to Wallet.**; how
  Wallet treats an `nfc` block under an unapproved certificate is unverified, so the copy assumes the worst [U]) · **Make a reader key per organization**.
- **Reader keys** table, one row per (identity, org): Organization · **Reader key** (`a3f1 9c02`, mono) · State
  (**Active**, **Retiring** with **{24} left**, **No key**) · **Passes with NFC** · actions (**Make reader key**,
  **Rotate key**, **Retire**). Works the same for the platform identity (SA 10.3).
- Platform flag: warning callout **NFC is off for the platform. Passes get NFC once it's on in Settings.** ·
  **Settings**. Settings › Scanning gets **NFC for passes** (switch, off).
- **Make reader key** (`md`): **Each reader needs the private key. PassBook keeps only the public half, so download
  it now and keep it with your reader setup.** → browser makes the pair → **Download the reader key** with **For VTAP
  readers** and **Key file (PEM)**, **I saved the key file** gates **Done**, muted **Lost it? Rotate the key and set
  up readers again.**
- **Rotate the reader key for {1,204} passes?** · **New passes get the new key now. Existing passes update silently
  over the next day. Keep the old key on readers until they're done.** · **Rotate** (danger).
- **Test a reader** (`md`): **Organization** select; a focused panel (wedge detector from `/scan`) **Hold a pass near
  the reader.**, buddy M `reader` pose with rings; **Listening…**; results **Read a pass.** (still + link), **The
  reader works. No pass here has this code.**, **Nothing read yet.** · **Check the reader is plugged in and set to
  keyboard mode. If the phone showed a tap but nothing came, the reader's key doesn't match.** Focus lost: **Click here
  to listen**.

### 10.7 Scans everywhere else

- **Scans tab:** filters **Pass name or ID**, **Scanner**, **Staff**, **Event**, **Result** (**Done**, **Heads-up**,
  **Refused**, **Undone**), **Reason**, **Date: today**; columns Time · Result pill · Pass (or **Unknown code**) ·
  What (**Add stamp · 7 → 8**, **Already checked in · first 6:12 PM**) · Where (scanner or **Admin console**) · Who ·
  How (method icon) · **Undo**. Row opens a right sheet with KeyValues (time, pass, template, event, scanner, staff,
  approved by, how, amount, before → after, pass version; reason code and scan ID under **Details**). Undo confirms
  per kind: **Undo check-in?** · **The pass can be checked in again.**; **Undo Add stamp?** · **Stamps go back to 7.
  The pass updates without a notification.**; **Undo Redeem?** · **The pass is active again on the holder's device.**
  Export CSV is audited.
- **Pass Sync log:** filter **All · Scans · Delivery · Devices · Changes** (`?log=scans`); titles **Checked in**,
  **Checked in again**, **{Add stamp}** (with **7 → 8 · Till 2 · Ana R. · v9**), **Already checked in** (warning),
  **Refused: {Expired}** (danger), **Undone: {Checked in}** (neutral); method icon as the dot; inline **Undo**;
  publishes from scans read **Updated to v9 by a scan**, and over-budget ones carry **Silent: daily limit**.
- **Pass header** meta: **Checked in {6:02 PM} · {Front door}**, **Checked in at {3} events**, or **Last scan {Nov
  3}**, linking to the Scans log.
- **Passes list:** filters **Event** and **Check-in: Checked in / Not checked in**, **Last scan: in 30 days / none in
  30 days / none in 90 days / never**; an event filter adds a **Checked in** column (the admin door list).
- **Overview:** **Live now** card while an event is live (up to 3 rows: **{312} of {500} · {18} / min** and a 96 px
  bar); counts **Scans** and **Refused**; a **Scans** chart. AE for charts, D1 for numbers.
- **Broadcasts:** **Scans** select in the audience: **Any**, **Not checked in · {Saturday gala}**, **Checked in ·
  {Saturday gala}**, **No scan in 30 days**, **No scan in 90 days**; help **Checked when it sends.**
- **Audit:** actor **Scanner: {Front door}**, Actor filter **Scanners**; codes per SA 2.11 with labels (**Scanner
  paired**, **PIN locked after 5 tries**, **Checked in again**, **Scans exported**, **Reader key made**…).

### 10.8 Template designer: Scan screen (DM §10; sheets `docs/design/scanner/display/sheets/editor-*`)

The visual card editor for `scan.display`: a **Pass** / **Scan screen** `SegmentedControl` under the designer's page
header. Both modes share one draft, one undo history and one **Save version**.

- **Entry points:** template detail, a **Scan screen** card with a still of the `ok` result and **Edit scan screen**
  (`?mode=scan`); the event dashboard's **Result screen · Edit**; the designer's Scanning section. A blueprint goes
  through **Use blueprint** first, which makes the org's own template; the scanner only sees real templates.
- **Frame:** n5's `DesignerLayout`. At 1280 px and wider: the outline (the inspector) at the start, the stage in the
  middle, Issues and the side cards at the end; on a tablet the outline beside the stage; on a phone the preview only,
  nothing editable.
- **Stage:** the real result card (the `/scan` display painter, BF look) at 0.8 scale in a device frame, with the
  outcome tabs: event templates **Checked in · Already checked in · Refused**; desk templates **Card**, one tab per
  action (**Add stamp**, **Redeem**), **Heads-up**, **Refused**. Preview controls: sample pass (a sample, or a real pass
  from M3), **Role** (Door, Desk, Manager; filtering runs as on the server), theme and device. None is saved.
- **System content is drawn, locked:** tint, band, holder line, pass tile, flags, the action area and the buddy show as
  dashed outlines with a lock; clicking one shows its reason ("The holder line always shows. Choose its source in
  Header.") and selects nothing. The Refused tab edits only the refused note. No palette entry makes a button.
- **Outline:** **Header** (holder source, **Show member photo** with Who sees it, the `ok` icon and title, meta line,
  chips) · **Rules** (variants) · one disclosure per panel (its rows, reorder with the grip or Alt+Arrow) · **Add
  panel** · **Notes** (staff, refused; "Event notes are set per event." when the template has events).
- **Add panel:** eight preset tiles with a schematic and an **{N} found** badge when the preset's slots match inputs,
  plus **Empty panel**; hovering previews a ghost on the stage. **Reset to preset** in the panel menu. **Add row**
  offers the twelve row types; a type that would break the budget is greyed with the reason.
- **Bindings are tokens:** **Insert field** opens a picker grouped by holder, inputs, pass fields, pass, scan history
  and event, each with its sample value (in the band title, only **First name** and **Full name**, disabled with **The holder line's source isn't a name.** when Header's holder source is the pass title or a pick list; the title's help reads **Names that look like a verdict show the plain headline.**); email, phone, the barcode and tokens are listed disabled as **Never shown on
  scanners**. Authors never type `{{ }}` (an advanced toggle shows the raw expression). Tokens open **Format** (date,
  time, ago, count, money, upper).
- **Rules:** one condition builder for **Show when** and variants (field, operator, value; All or Any), **Try another
  pass** to watch a rule switch; a hidden panel shows as a dashed placeholder ("Access · Hidden for Leo Park: tier is
  General").
- **Fit meter**, per outcome tab: **Fits on a phone: {5} of 6** with the header's share named (**Title 2**,
  **Title 3** when it can take 2 lines, **Photo 1**), and **{2} of 5 units** on each panel header; red with `SCAN_DISPLAY_DENSITY` when **Checked in** is
  over. Rows the server cuts on a tab show dashed with **Cut on this screen**.
- **Save:** **Save version** always makes a template version. When only the scan screen changed, the version card says
  so first (**Only the scan screen changed. Scanners show it on the next scan.**) and the saved callout reads
  **Version {5} is live on scanners. Passes are unchanged.** A save that also changes the pass falls back to n5's copy
  and **Activate**. The versions list badges display-only versions **Scan screen only**.
- **Inputs section:** a **Scanner** control per input: **Everyone**, **Desk and up**, **Manager**, **Hidden**; for an
  email, phone, URL or barcode-only input the line **Never shown on scanners** instead; an input named like a password
  or a phone number starts as **Never shown on scanners** with **Show on scanners** to opt in.
- **Keyboard and screen readers:** the canvas is one roving-tabindex group in document order, each element a named
  button ("Panel Access, 2 rows, shows when tier is VIP"); Enter edits, Esc returns, Alt+Up/Down moves, Cmd+D
  duplicates, Delete removes with an undo toast; a polite live region says what each change did.

---

## 11. Holder-facing touches

| Touch | Decision |
| --- | --- |
| Check-in on the Wallet pass | Nothing changes: no publish, no push (SA D11). Opt-in **Record the time on the pass** writes a date silently |
| Stamps, points, balances | The field updates (it is the product), silently by default; **Notify the holder** opts in and spends the 3-a-day budget, with n7's silent fallback |
| Coupon used | The pass voids silently; Wallet greys it |
| Portal pass detail (signed in) | Header meta **Checked in {Nov 14, 6:02 PM}** or **Last scan {Nov 3}**; no scanner or staff names (later slice) |
| `/p` public page | Nothing: a bearer link, often forwarded, and scan times reveal where someone was |
| Email | Never per scan |
| Buddy | None for holders: nothing happens in real time on their side |

The scanner never mentions push to staff.

---

## 12. Copy rules

Sentence case; headlines are verbs or states (**Checked in**, **Voided**), subs say what to do or when/where; no
"Oops", no mascot lines, no celebratory copy. Units pluralize with `Intl.PluralRules` (never "1 stamps"). "Hold near",
never "tap" or "NFC", in holder-facing words. One word per meaning: **scanner** (the credential), **reader**
(hardware), **staff**, **event**, **scan**, **heads-up** (admin only), **refused**, **undo**, **use up** (designer
only; staff see the action's label).

---

## 13. Build notes for the UI

- Everything on `/scan` loads in the scan document's chunks (SA 13.2): the buddy layer after first paint into its
  fixed dock seat; `desk` when `flow` is `choose`; `lookup` and `result` (card layer, band, identity row, display
  painter, icons) on idle; `pass` on the chevron; the decoder prefetched on Start.
- The direction lives in `ui/`, `result/`, `display/`, `desk/` and `buddy/` only (D18). The display painter reads
  `ScanDisplay` and `oneLine`; it never measures text to choose a layout.
- Tests beyond SA 14: every state in section 5 renders at 390, 820 and 1180 in both themes with no axe violations;
  copy test that every SA reason and client reason has headline, sub, glyph, beat and chirp; no-shift test on the
  capsule chips, the dock strip, the card's bottom edge and the buddy seat; one-buddy test across every overlay
  combination; the **fit test** (5.8) for the six owner examples and, per screen, the largest composition the budget admits at 390 × 844; a
  check per sheet in BF against the rendered component (card top, height and band height within 2 px).

---

## 14. Mockups

**Source of truth for `/scan`: `docs/design/scanner/b-final/`.** README is the build spec; the 18 sheets render every result,
desk and motion state at 390 × 844 and 1180 × 820, light and dark:

| Sheet | Contents |
| --- | --- |
| `b-final-phone-door-{light,dark}.png` | checked in, already checked in, voided, not found, wrong event, saved offline, milestone, live pass on a test scanner |
| `b-final-phone-desk-{light,dark}.png` | desk panel with the stepper, stamp added (reward ready), redeem confirm, Manager PIN |
| `b-final-phone-custom-{light,dark}.png` | the six owner examples: VIP, gym, coffee, prepaid, coupon, the event blueprint |
| `b-final-ipad-{door,desk,custom}-{light,dark}.png` | all 18 states at 1180 × 820 (split card) |
| `b-final-strip-checked-in-*`, `b-final-strip-interrupt-*` | motion frames D0 → 1400 ms; amber interrupted by red |
| `b-final-annotated-{light,dark}.png` | slots and measurements |

**Source of truth for the Scan screen editor: `docs/design/scanner/display/sheets/`** (`editor-1440-*`, `editor-820-and-390`,
`cards-catalog-*`, `slots-annotated-*`, `in-context-390-*`, `motion-add-panel`). The canvas, catalog, slot map and
in-context tiles are painted by the B-final kit, so they match `/scan`: Ticket with 4 columns on one line, the member
photo in the identity row, the system holder line with the meta line under it, the fit meter "N of 6" per outcome tab
(header cost included), and a display-only save that is live at once (**Version 5 is live on scanners. Passes are
unchanged.**, no Activate).

**`mockups (not shipped) ` (v1), superseded where B applies.** The `scan-*` result tiles are **superseded** and must
not be matched: 04 Checked in, 05 Already checked in, 06 Refused, 07 Offline saved, 10 Desk add stamps, 11 Stamps
added, 12 Redeem confirm, 13 Needs a Manager, 15 Milestone, 16 iPad door, 18 Test scanner live pass. The others keep
their content and copy but take the B shell (capsule, live camera, dock, buddy on the dock) before they are matched:
01 Pair, 02 Who's scanning?, 03 Aiming, 08 Camera blocked, 09 Lookup (now a sheet), 14 Hold near the reader, 17 End of
shift. The `admin-*` mockups stay the source for the admin pages, except **Admin 03 Designer**'s "On the card" block
(now the Scan screen mode, 10.8).

**Renders still owed before the build matches them** (the screens stream renders them in B first): the phone keypad
tray (prepaid, amount entry), Look up as a sheet and the iPad side sheet, Who's scanning? over the live camera, Start,
camera blocked, reader stage, shift summary; and from v1: **Admin 03 Designer** row summary **+1 stamp**,
**Admin 01 Pairing** host text `{host}` and the Home Screen line (10.2).

---

## 15. For the owner

Decided here, nothing needed unless you disagree: one adaptive app with no staff-facing mode switch; theme-invariant
verdict colours; the review-then-**Ask a manager** flow; no device event picker; the result content per template with
the verdict system-owned; the phone keypad in a dock tray; one **Not found** sub for door and desk; the band's custom
title is plain text plus, at most, the holder's name, up to 2 lines; two blueprints, Balance card and Stamp card; no
item names in the ledger.

Genuinely yours:
1. **Confirm B strengthened** for the result screens. Switching later to "A at the door, B at the desk" touches only
   the screens and buddy workstreams.
2. **Apple NFC application** for `pass.im.plrs.wallet`, naming the VTAP100. Nothing in the build waits on it.
3. **Hardware for device checks:** one VTAP100 and one Bluetooth barcode reader.
4. **The personalization fix** before `nfc.enabled` is ever turned on.
5. **Staff names in history** (SA 17): off for now.

Added 2026-11-05 (defaults set; SA §17 items 6-11 hold the detail):
6. **Flip back with a PIN** (no staff: a 2 s hold, flagged in the console). Fine, or require staff?
7. **"Hi, Maya" on customer screens**, on by default per station. Keep, or default off?
8. **Access card style** generic (photo on the card), pending Apple's NFC rule for generic passes.

---

## 16. Stations: customer screens, desk monitors and setup

The owner: "one or more handheld scanners … a customer interface while a desk interface shows the scans in realtime
… any combination." Concepts and data: SA §18 (detail `addendum/stations.md`). Layout and sizes: `addendum/ux.md` §1-§4, §6-§8; sheets `addendum/sheets/ux-{customer,monitor}-*`, `ux-roles-*`.
Mockups: customer `addendum/shots/c-*`,
monitor `m-*` (phone 390, iPad 1180 × 820 `-ipad`, desk 1440 × 900 `-desk`), device roles `r-*`, console `ad-*` and
`addendum/sheets/x-admin-*.png`; every combination on one sheet: `addendum/stations/sheets/stations-topology-*.png`.
CSS for the builders to read sizes from: `addendum/assets/x-{cust,mon,dev,admin}.css` on the rebuilt B-final kit.

### 16.1 Who sees what

| | Scanner | Customer screen | Desk monitor |
| --- | --- | --- | --- |
| Verdict | B card, tint, ring, `SCAN_COPY` | the same card at counter scale; ok in its colour; every heads-up and refusal one slate **Please see the desk** card | a feed row with the verdict shape and word |
| Who | full name, photo per role | **Hi, Maya** (first name, ok and ready, when **Greet by first name** is on) | name, photo per audience |
| Template content | role-filtered panels | only what `display.customer` names (DM §11) | the row's display on expand, per audience |
| Controls | dock | none | filters, **Seen**, row detail; never an action |
| Counts | own today | never | visits today, in now, refused, undone |

### 16.2 Customer screen (`src/web/scan/customer/`)

**Frame.** The scanner's frame without the camera or controls: the glass capsule on top (org mark tile, org name,
station name; chips **Test**, **Reconnecting** after 2 s unhealthy, **Not set up**, **Keep this screen on** when wake
lock is refused), the buddy XL on a plain shelf at the bottom (phone 240 wide, iPad 320), and the card layer between.
Phone: the scanner's 40 px headline. iPad (1180 × 820, landscape or portrait): a split card up to 980 wide, headline
64, the buddy 320.

| State | Screen | Buddy |
| --- | --- | --- |
| **Idle** | the station's welcome (**Hold up your pass**) large above the buddy; how-to pills on the shelf: **Show the code**, plus **Hold near** only when a scanner in the station reads NFC and `nfc.enabled` is on | `wave` once on entering idle, then rest |
| **Reading** (scanner's `reading` beat) | the welcome dims; the pill becomes **Checking…** with a spinner | `rummage` lean-in, eyes into the pocket, until the result or 3 s |
| **Ready** (staff choosing, `showReady`) | a band-less white card: **Hi, Sam** · template name ("Prepaid card"), the customer panel if any; no tint | `hello` glance up |
| **Review** (staff entering an amount, `showDraft`) | the ready card shows **To pay** and the amount large, **Balance after: $30.50** (count: **Adding 2 stamps**); **Cancel** beat returns to ready | holds, eyes on the amount |
| **OK** | tint and ring in the verdict colour (as the scanner); the card rises from the violet pass: band glyph, `CUSTOMER_COPY` headline and sub ("Access granted" · pin **Pool**; "+2 stamps" · "9 of 10"; "Paid $12.00"); body **Hi, Maya** + chips, then the customer panel (stamps grid, balance with the struck previous value) and up to two system lines with icons (**Until 9:00 PM today**, **3 of 5 visits left**) | the scanner's beat for that result (`gate`, `stamp`, `coins`, `fan` on a reward) |
| **Please see the desk** | slate tint and ring; a slate card with a person glyph, the station's refusal line, and only for `outside_hours` **Your plan opens at 4:00 PM.** (or **Sat 8:00 AM**; none when nothing opens this week) or for ended guests **Your guest pass has ended.** No name, no chips | `sorry`: a small bow, eyes up. **Never the head shake** at a customer |
| **Reconnecting** | idle stays; **Reconnecting** chip; results resume on reconnect (only results under 10 s old replay) | still, curious |
| **Not set up** | idle with a quiet **Not set up** chip (no station, or a station with no scanner) | rest |

Holds: ok 4 s, see the desk 6 s, ready until the next event, the scanner's `idle` beat or 60 s; then idle with one
wave. A pass found by lookup at the desk never shows here (SA §18.4). A newer result
interrupts the shown one the way the scanner does (old card tucks 150 ms, new rises); the capsule's second line names
the scanner that scanned when the station has more than one ("Till 2"). Undo of the shown scan returns to idle.
Customer screens are home-screen web apps on iPad: the pairing face suggests Guided Access.

### 16.3 Desk monitor (`src/web/scan/monitor/`)

**Desk and iPad** (1440 × 900, 1180 × 820): capsule (watch name, scope line "Northside Gym · Gym floor, Pool, Studio,
Sauna", **Live** chip, ⋯) over two columns.
- **Rail** (left, 400): counters as tiles: **Visits today** (184 · **22 in the last hour**) or, on an event watch, **In
  now 312 / 500** with "340 checked in · 28 out"; **Refused** and **Undone**. Below, presence: each scanner and screen
  in scope with **Online** / **Offline**; the buddy sits on the presence card.
- **Feed** (right): filters **All scanners** and **All zones** (or **All doors** on an event), segment counts **All 190
  · Granted 183 · Heads-up 1 · Refused 6**; then a table: verdict shape (circle ok, triangle heads-up, octagon
  refused; the shape alone says it) · **Who** (photo or template tile, name, plan or template chip, zone) · **Result**
  (the verdict word, coloured for heads-up and refused) · **Where** (zone, scanner) · **Staff** (name, role) · **Time**
  (clock time, "now", "1 min"). Newest on top; a new row lands at the top and its tint fades over 2 s. Undone rows are
  struck. Footer **Last 15 minutes live · older scans in Scans**. The **Staff** column is desk width only (not on iPad). While a
  row is hovered or the list is scrolled, new rows wait behind a **3 new** pill instead of moving the list.
- **Alerts** (refusals only; heads-up rows never pin): an unseen refusal pins above the feed (red outline, octagon, headline, plan chip, "Maya Okafor · Pool
  gate · Off-peak doesn't include Pool." (the staff sub, `SCAN_COPY`), photo, **Seen**), at most 3, newest first; announced in a polite live region; an
  optional chirp (`screen.sound`).
- **Row detail** (tap): a side sheet with the row's display for the monitor's audience; read only.

**Phone** (390): one column; counters as a strip, filters scroll horizontally, rows compact (shape, photo, name, chip,
zone, time), the buddy on the dock beside presence.

| State | Shows |
| --- | --- |
| Empty | **No scans yet** · **Scans from Front desk, Pool gate and Studio door show here.**; the buddy waves |
| Reconnecting | **Reconnecting** chip; an amber strip **Showing scans up to 6:43 PM.**; the feed keeps what it has; catch-up fills the gap |
| Reset | the feed reloads from the snapshot (last 50) without a flash; **Can't load older scans** if D1 fails |
| Not set up | an archived event or zone: **Not set up** card and the console flags it |

The buddy sits on the rail's seat (216 desk, 192 iPad, 152 on the phone dock). It shakes its head once per new alert
and otherwise rests: green rows never animate it (a busy door would make it jitter). Empty moves the one buddy into the
empty card with one `wave`. Filters are per device and remembered, never change what the hub sends, and never hide an
alert.

The amber row in `m-feed` is the opt-in re-entry wait (**Entered 3 min ago**), the only access heads-up. (Fixed
2026-11-05: it read **Expires tomorrow**, which isn't a reason.)

### 16.4 Roles on the device (`src/web/scan/role/`, the boot role gate)

- **Pairing a screen**: the confirm card reads **Pair as Customer screen** · **Front desk · Northside Gym**, with two
  lines **Shows results to customers** *Never scans. An admin can change it.* and **No names but first names** *No
  reasons, notes or photos.* (monitors: **Pair as Desk monitor** · **Shows scans as they happen**). **Cancel** ·
  **Pair**.
- **Show to customer** (menu, 2.4) → sheet **Which scanner is it facing?** *This phone shows that scanner's results.*;
  groups **{this station}** then **Other scanners** (name, staff or Online); radio; **Cancel** · **Show to customer**.
  The scanner it faces gets a quiet capsule chip (`MonitorSmartphone`) **Customer screen on**.
- **Back to scanning**: press and hold the capsule; a 3 px ring fills around it with a **Keep holding** pill. With
  staff: 1 s opens **Back to scanning?** *Enter a staff PIN.* with the shared keypad (D8) and **Cancel**; wrong PINs
  say tries left; lockout as staff sign-in. Without staff: the ring takes 2 s and switches directly.
- **A screen opening a scan route** (a stale tab, a hand-typed URL): the block card **This device is a screen.** ·
  **Ask an admin to change it.**, the buddy flat.

### 16.5 Station setup (console)

Scanning › **Devices** (`/admin/scanning?tab=devices`); detail in `addendum/ux-work/ux-admin.md`, mocks `ad-*`.

- **Header** **Scanning**; actions **New station** (outline, `MapPinned`) and **Add device** (primary).
- **Grouped by station.** Group header: `MapPinned` tile, name, count line (**2 scanners · 1 customer screen · 1 desk
  monitor**), a feed line (**Front gate, Front till → Counter iPad**), **Settings**, **Add device** (preset to it),
  menu (**Rename**, **Archive station**). Last group **No station** (dashed): scanners with no screen and monitors
  watching more than one place.
- **Columns** (fixed widths so groups align): **Device** (role tile, name, device line) · **Role** pill · **Shows or
  checks** (Scanner: **Checks** + zone chips, or the event, or **Accepts 2 templates**; Customer screen: **Every result
  from {station}**; Desk monitor: **Watches this station · Desk**, **Watches** + zones **· Door**, **Watches
  everything · Desk**) · **Status** · **Today** · **Last seen** · menu or **Pair**.
- A phone switched on the device: device line **Safari on iPhone · switched on the device 6:02 PM** and
  `LockKeyhole` **Staff PIN to switch back** (or **Anyone can switch it back**).
- Role icons everywhere: Scanner `ScanLine`, Till `Store`, Customer screen `MonitorSmartphone` (violet tint), Desk
  monitor `Monitor` (teal tint).
- **Add device** (md): **What is it?** four tiles: **Scanner** *A phone or iPad that scans passes.* · **Customer
  screen** *Faces the customer and shows each result.* · **Desk monitor** *Shows scans as they happen.* · **Till** *A
  point-of-sale system with a token.* Customer screen: **Name**, **Station** (required, **New station** inline), callout
  **Customer screens never show a reason, a staff note or a photo. Refusals read Please see the desk.** Desk monitor:
  **Name**, **Station** (optional), **Watch** (**This station · Stations · Event · Zones · Everything**; chip pickers
  **2 of 8**), **Shows** (**Door** *What a Door scanner sees.* · **Desk** *Also desk-only details.*). Footer
  **Cancel** · **Create and pair**.
- **Pairing a screen**: the existing pairing face with the role pill, **at Front desk · Northside Gym**, **On the
  iPad**, the tip **Turn on Guided Access on the iPad to keep this screen in front.**, **Waiting for the iPad…**.
- **Station settings** (lg): **Name** · **Welcome** (≤ 40; empty = **Hold up your pass**) · **Refusal line**
  (placeholder **Please see the desk**) · switches **Greet by first name**, **Show the desk card**, **Show amounts under
  review**, beside a live idle preview (aria-hidden). Footer **Archive station** (confirm **Archive Front desk?** ·
  **Its devices leave the station. Customer screens show Not set up.**) · **Cancel** · **Save**.
- **Scanner dialog** gains **Station**, **Role** (device kind only: **Scanner** · **Customer screen**) and **Checks**
  (17.2).
- **Phone** (390): one card per station, 60 px rows (role tile, name, **{Role} · {what it shows}**, status dot),
  header action **Add**.

### 16.6 Accessibility

- Customer screens: the band headline and sub are announced once per result ("Access granted, Pool"; never the
  name, which would be read aloud at a counter); idle is not announced;
  verdict colour is never the only signal (glyph, word, slate vs colour); 4.5:1 text on every tint in both themes;
  reduced motion cross-fades the card and shows the beat's end pose; **Keep results until tapped** has no meaning
  here, so holds are fixed and the screen never needs a touch.
- Monitors: the feed is a table with row headers; ordinary rows are not announced (the table is browsable); a new
  alert is announced assertively once ("Refused, Pool gate"); verdict shapes plus words; alert **Seen** is a 44 px
  button; filters are buttons with `aria-pressed`. Rows' red text is `#b91c1c` light and `#f87171` dark.
- Device sheets: the hold has a keyboard and switch-access path (the capsule is a button; Enter and hold or a long
  press; VoiceOver's custom action **Back to scanning**); the console's role change (**Make it a scanner**) is the
  non-hold alternative.
- Every screen at 390, 820 and 1180 (and monitors at 1440), light and dark, axe clean.

### 16.7 Against `addendum/ux.md`

`ux.md` is the layout and size reference for these faces. Where it differs, this file wins:
- **Beats:** stamps added play `stamp` and a balance charge `coins` (BM §8), not `hop`.
- **Empty monitor:** one `wave`, not a rummage (BM M8: no ambient loops).
- **Let in anyway:** shown on all five overridable refusals whenever `letInAgain` isn't **never**; without a Manager
  signed in, tapping opens **Manager PIN** (D9: locked actions stay visible). `a-zone`, `a-guestend`, `a-visits` and
  `a-notyet` were re-rendered with **Let in anyway** · **Done** (2026-11-05).
- **Announcements:** customer screens never speak the name.
- **"In now" for access:** zones have no exits, so access watches show **Visits today**; occupancy needs exit scanners
  (later). Event watches with re-entry keep **In now**.

---

## 17. Access cards

The owner: "Access Card … gym memberships, business access … unlimited access … 24/7 vs timed/guest … zones." Rules
and data: SA §19 (detail `addendum/access.md`). Mockups: scanner results `addendum/shots/a-*`; console
`addendum/access/admin/shots/`; identity and art `addendum/access/sheets/access-card-*.png`; the `gate` beat
`addendum/access/sheets/access-gate-*.png`.

### 17.1 Results on the scanner

| Result | Band | Card | Dock | Buddy |
| --- | --- | --- | --- | --- |
| Granted | green **Access granted**, sub pin **Pool** (or **Gym · until 4:00 PM**) | photo 96, name, meta (template), plan chip (`Infinity` **24/7**, `Clock3` **Off-peak**, `Ticket` **Guest**); Visits panel (**This month 12 visits** · **Last visit 2 days ago**; guests **Visits left 3 of 5** · **Until 9:00 PM**; **Guest of Maya Okafor** for Desk) | last-scan strip **Maya Okafor · Pool · 6:41 PM** with **Undo** | `gate` |
| Again within the gap | the same **Access granted** | the same | strip **Again · 2 min ago** | `gate` |
| Re-entry wait (opt-in) | amber **Entered 2 min ago** · **Next entry in 13 min.** | photo, name, plan chip | **Let in again** · **Done** | `wrist` |
| Not in plan | red **Not in plan** · **Off-peak doesn't include Pool.** (on **Any zone**: **Off-peak opens no zone here.**) | compact row, plan chip, refused note **Ask at the front desk.** | **Let in anyway** · **Done** | `shake` |
| Outside hours | red **Outside hours** · **Off-peak opens 4:00 PM.** | same | **Let in anyway** · **Done** | `shake` |
| Not open yet | red **Not open yet** · **Opens Dec 1.** | same | **Let in anyway** · **Done** | `shake` |
| Guest pass ended | red **Guest pass ended** · **Ended 9:00 PM.** | same, **Guest of** for Desk | **Let in anyway** · **Done** | `shake`, the gold pass greys and droops |
| No visits left | red **No visits left** · **Used 5 of 5.** | same | **Let in anyway** · **Done** | `shake` |
| Suspended | red **Suspended** · **Ask them to see the front desk.** | compact row, **Suspended** chip | **Done** | `shake` |

- **Let in anyway** shows whenever the scanner's `letInAgain` isn't **never**; it always needs a Manager: signed in,
  it acts; otherwise it opens **Manager PIN** (D9). Every overridable refusal shot shows **Let in anyway** · **Done**
  (re-rendered 2026-11-05).
- Customer screens show **Please see the desk** for all of these (16.2), with the one-line sub only for outside hours
  and ended guests.
- Desk `ready` on an access card shows the same card without a band, and the action area says **Opens 8:00 PM** in
  the system line when outside hours.

### 17.2 Zones and plans in the console

Mockups `addendum/access/admin/shots/{zones,zone-new,zone-archive,plans,hours-edit,pass-form,pass-detail,
scanner-zones,stills}-*.png`.

- **Zones tab** (`?tab=zones`): `PageHeader` **Zones**, primary **New zone**. Empty: buddy `wave`, **No zones yet.** ·
  **Zones let a pass open some doors and not others.** · **New zone**. A tree, roots first (building icon), children
  indented with `CornerDownRight`: Name · Key (mono, muted) · Time zone (roots; children muted) · **Checked by** (**2
  scanners** link) · **Plans** (**Off-peak, 24/7 Gold**) · menu (**Edit**, **Add a zone inside**, **Archive**).
  **Show archived (n)**. Phone: indented list, second line "Key · 2 scanners".
- **New zone** (sm): **Name** · **Inside** · **Time zone** (roots only; help **Hours at this site use this clock.**);
  the key previews. **Archive Pool?** · **Its doors stop letting anyone in. 2 scanners check it; 3 plans grant it.**
- **Scanner Checks**: chips with the zone tree in a popover (checkbox per zone, `aria-level`, ≤ 8, **2 of 8**); help
  **Lets in a pass that opens either zone now. Empty: Any zone.**; status line `DoorOpen` **Open now for 24/7,
  Off-peak. Closed for Guest day.** Event scanners: disabled, **Events check in once. Zones don't apply.**
- **Designer › Access** (after Scanning): **Use as an access card** switch for non-blueprint templates; **Plans** list
  (label, type pill, summary, **128 passes**, drag to reorder, **Add plan**); plan inspector **Name**, **Type** (tiles
  **24/7** *Any time.* · **Timed** *Set weekly hours.* · **Guest** *A day or a few, with an optional visit limit.*),
  **Hours** week grid (span chips per day, **Add hours**, **Closed**, **Copy Monday to weekdays**, "10 PM – 2 AM (next
  day)"), **Zones** (**All zones** or picked, each with **Limit hours**; hours outside the plan struck and labelled
  **Outside the plan**), guests **Lasts** (help **Ends at midnight.**) and **Visit limit**; **Rules** (**Count as one
  visit within** 120 min, **Wait between entries** off, **Suspend when** {input} is {values}); an inert **On the
  scanner** strip. Issues: **Off-peak: hours overlap on Monday.**, **Off-peak has no zones.**, **{n} passes use
  Off-peak. Move them first.**, warning **Pool isn't a zone of Northside Gym yet.** with **Create zone**.
- **Pass form**: **Access** group: **Plan** (label and summary per option), **Extra zones** (help **On top of the
  plan's zones, in the plan's hours.**), **Starts** (**Now**), **Valid until** (**No end**; guests **Ends at
  midnight**); **Guest**: **Visit limit**, **Guest of**; **Photo** (help **Shown to staff at the door.**).
- **Pass detail › Access** card: plan, zones as chips, **Open now** / **Opens Sat 8:00 AM**, visits this month, last
  visit (zone · time), **Reset visits** (guests).
- **Org settings**: **Time zone**; changing it says **Hours at sites without their own time zone move to this
  clock.**
- Accessibility: the week grid is a table with a row header per day; spans are buttons ("Monday, 6 AM to 4 PM,
  edit"); typed time entry; overlaps announce in the field error; the tree uses `aria-level`; 44 px targets on touch.

### 17.3 The Access card blueprint

- **Gallery** (`/admin/blueprints`): second after Membership, four columns at 1440 so it sits beside it. Tile per TI §4:
  the drafting-grid stage tinted Cobalt `#1D3ABA` / labels `#CFE0FF`, the real pass still (photo thumbnail art: three
  nested door arches in the foil hues), glyph `Key`, **Access card**, **Door access by plan and zone, with a photo for
  ID checks.**, **Use**.
- **Use blueprint**: **Organization**, **Name**; **Comes with** the three plans (`Infinity` **24/7** · All zones;
  `Clock3` **Off-peak** · Mon–Fri 6 AM–4 PM, 8–11 PM · Sat–Sun 8 AM–8 PM; `Ticket` **Guest day** · All zones, ends at
  midnight); callout **Add zones in Scanning, then pick them per plan.** · **Zones**; **Cancel** · **Continue**.
- **The pass**: generic, Cobalt, header **Plan**, primary **Name**, secondary **Zones** and **Valid until**, auxiliary
  **Member** and **Hours**, QR scan code, the member photo as thumbnail; back: **Message**, **Guest of**, **Hours**,
  **Terms** (**Show this card at the door. It's for you only.**). Stills (with the QR) on
  `addendum/access/sheets/access-card-*.png`.
