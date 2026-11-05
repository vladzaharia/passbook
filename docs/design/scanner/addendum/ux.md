# Scanner addendum UX: customer screens, desk monitors, roles, Access cards

States, layout and copy for the owner's two additions (multi-screen stations; the Access card). Concepts and wire
contracts: `stations.md` (**ST**) and `access.md` (**AX**). Visual system: `../b-final.md` (**BF**),
unchanged; this file only adds surfaces built from its parts. Motion: `../buddy-motion.md` (**BM**). 2026-11-05.

Precedence: ST wins on stations, roles and the customer audience; AX on zones, plans and access copy; BF on geometry
and tokens. Where this file and they differ on a pixel, this file wins for the new surfaces only.

## Sheets

All light and dark, in `sheets/` (`<name>-light.png`, `<name>-dark.png`). Pages: `pages/*.html`
(`?t=dark`, `?d=ipad`, `?d=desk`). Render: `node gen/run.mjs customer access monitor roles`, then
`node gen/sheets.mjs`.

| Sheet | What |
| --- | --- |
| `ux-customer-phone` | Customer screen on a phone (held by the customer, or facing them): 12 states |
| `ux-customer-ipad` | Customer screen on an iPad across a counter: 10 states |
| `ux-monitor-desk` | Desk monitor at 1440: feed with an alert, filtered, event watch (In now), empty, reconnecting |
| `ux-monitor-ipad` | Desk monitor at 1180 and on a phone |
| `ux-roles` | Pair as a screen, Show to customer, Which scanner is it facing?, the facing chip, Back to scanning? |
| `ux-access-phone` | Access card results on the scanner: 11 states |
| `ux-access-ipad` | The same on iPad (split card) |
| `x-admin` | Console (section 10): Devices grouped by station, Add device per role, pairing a screen, station settings, scanner station/role/Checks, Blueprints with the Access card, phone; AX's Zones, plan editor and Checks picker for reference |
| `../access/sheets/access-{zones,plans,pass,card,gate}` (AX) | Zones tab, plan editor, pass form, the blueprint's identity, the `gate` beat frames |

## 1. One family, four faces

Every face is a lazy chunk of `scan.html` chosen by the device's role (ST §6.1). They share, without variants
(owner: one implementation per shared concept):

| Part | Scanner | Customer screen | Desk monitor |
| --- | --- | --- | --- |
| Ground | live camera | `--c-ground` (soft foil glows on `#eef0f6` / `#070910`) | same as customer |
| Capsule (`.b-top`) | place · status · chips · ⋯ | org tile · org · where; no controls (hold to switch back) | org tile · watch name · scope · live chip · ⋯ |
| Result card (`.b-rc`) | BF card | the same card at counter scale (`.cust`) | rows, not cards (one card only in a row's expand) |
| Verdict hues, glyph shapes | BF tokens | same | same at 28 px in rows, 44 in alerts |
| Buddy (`WalletArt`, one per view) | XL on the dock | 240 (phone) / 320 (iPad) on the shelf | 192 / 216 on the rail's seat; 152 on a phone dock |
| Chips | BF chips | ≤ 2, from `display.customer` | the plan or flag chip on each row |

## 2. Customer screen

### 2.1 Layout

| | Phone 390 × 844 | iPad 1180 × 820 |
| --- | --- | --- |
| Capsule | 366 × 52, org tile 36 r 11, org 17/22 600, where 13/16 | 60 tall, r 30, tile 44, org 20/26, where 15/20 |
| Idle line | 44/48 700, centred in the space above the buddy | 88/92 700 |
| Shelf | 112, the how-to pills (44, r 22) on idle; bare on results | 104, pills 56 |
| Buddy | 240 × 180 | 320 × 240 |
| Card | 342, bottom fixed 268 from the screen bottom (the pocket), max 443 | split card, verdict column 420, content right; band-only 720, desk card 820 |
| Band headline | 40/44 650 (scanner size, so "+2 stamps" fits beside the glyph) | 60/64 700 |
| Body | `Hi, {first}` 28/32 600 + chips 34; lines 20/26; one big value 64/68 | 40/44; lines 26/32; value 112 |
| Stamps | 52, 5 a row, spaced between | 64, 5 a row |

No camera, so no scrim over a feed: the tint washes the ground (scrim 12 % light, 30 % dark) and the 10 px ring frames
the screen as on the scanner.

### 2.2 States and copy

| State | Trigger (ST §4.3) | Band | Body | Buddy | Hold |
| --- | --- | --- | --- | --- | --- |
| Idle | no result, or the hold ended | none; the station's `welcome`, default **Hold up your pass** | how-to pills on the shelf: **Show the code**, **Hold near** (NFC only when on) | waves once each time it returns to idle, then still | — |
| Reading | `beat: reading` from the scanner | none; the idle line dims to 55 % | shelf pill **Checking…** with a spinner | `rummage` lean-in | until the answer, max 3 s |
| Access granted | ok, AX grant | green row band **Access granted**, sub the zone with a pin | **Hi, Maya** + plan chip; system lines (AX §1.4): **Until 9:00 PM today**, **3 of 5 visits left** | `gate` | 4 s |
| Checked in | ok `check_in` | **Checked in** (event: **You're in**), sub the event | greet | `hop` | 4 s |
| Stamps added | ok `add` on a count | **+2 stamps**, sub **9 of 10** | greet, the stamp grid (new ones land from 1.5×, 90 ms apart, with the + badge), caption **1 more for Free coffee** | `hop` | 4 s |
| Reward ready | milestone `reward` | **Reward ready**, sub **10 of 10**, foil edge, six sparks | greet, the reward tile **Your reward · Free coffee** | `fan` | 4 s |
| Balance charged | ok `take` on money | **Paid $12.00** | greet, **Balance** label, new balance 64/68 with the old struck | `hop` (coins beat when built, BM §6.1) | 4 s |
| To pay | `review` beat, money (`showDraft`) | none (desk panel style) | **Hi, Sam · Prepaid card**, **To pay** $12.00, **Balance after: $30.50** | still, happy | until Paid or Back |
| Please see the desk | every heads-up and refusal, mode mismatch, not found | slate stacked band, the person squircle, station `refusedLine`, default **Please see the desk** | none | `sorry` (bow, look up). Never the head shake at a customer | 6 s |
| … with a kind sub | `outside_hours`; `guest_expired`, `guest_visits_used` (AX, agreed) | as above + **Your plan opens at 4 PM.** / **Your guest pass has ended.** | none | `sorry` | 6 s |
| Reconnecting | socket unhealthy | idle stays | capsule chip **Reconnecting** (amber, spinner); **Not set up** uses the same chip | still, curious | — |

Rules: the first name only, on ok and ready only, when `greet`; no photo, surname, reason, note, staff name or
another holder, ever. A second scanner's result interrupts the first the BF way (old tucks 150 ms, new rises) and the
capsule's second line names that scanner. Undo returns to idle at once.

Keep results until tapped (scanner menu) does not apply to customer screens; holds are fixed so a queue moves.

## 3. Desk monitor

### 3.1 Layout

| | Desk 1440 × 900 | iPad 1180 × 820 | Phone 390 × 844 |
| --- | --- | --- | --- |
| Gutters | 32 | 24 | 12 |
| Capsule | 60, r 30; watch name 20/26 600, scope 15/20; **Live** chip (green dot) or **Reconnecting** (amber, spinner); ⋯ | same | 52; title and scope ellipsize |
| Rail | 340: counter card (52/56 650 number), two half counters (36/40), the seat (devices online + the buddy 216) | 300, buddy 192 | counters as a strip on top; devices and the buddy (152) on a 122 dock |
| Filters | **All scanners ▾**, **All zones ▾** (or **All doors** on an event) as 44 glass pills; verdict segments **All · Granted · Heads-up · Refused** with live counts | same | 36 pills, the row scrolls |
| Feed | card r 24; header row 13/16 600 muted; rows 64: verdict shape 28 · photo or pass tile 40 + name 17/22 600 + plan chip and zone · result 17/22 500 (red or amber text for those verdicts) · where (zone over scanner) · **Staff** (desk only) · time (6:43 over "now") | no Staff column | shape · who · time; zone moves under the name |
| Footer | **Last 15 minutes live · older scans in Scans** | same | — |

### 3.2 Behaviour

- **New row**: lands at the top with a 12 % verdict tint that fades over 2 s; the list doesn't jump while a row is
  hovered or the list is scrolled (a **3 new** pill appears instead).
- **Alert**: a refusal pins above the feed (max 3, newest first): 2 px red ring, octagon 44, headline 22/28 650 + plan
  chip, **{holder} · {scanner}** and the reason sub, photo 56, time, **Seen**. The buddy shakes its head once per new
  alert; green rows don't animate it (a busy door would make it jitter). Heads-up rows never pin.
- **Undone** rows strike through name and result and stay in place.
- **Counters**: access watches show **Visits today** (with *22 in the last hour*), **Refused**, **Undone**. Access
  has no exits (AX §1.2), so there is no "In now" for zones. An event with re-entry shows **In now 312 / 500** with a
  capacity bar and *340 checked in · 28 out*. Zero shows 0, never a dash.
- **Filters** are per device and remembered; they never change what the hub sends. A filter that hides a new
  refusal still shows its alert.
- **Row expand** (tap): the outcome's `display` for the monitor's audience, as the scanner card without the band.
- **Empty**: one buddy only (the seat's moves to the empty state, rummaging), **No scans yet** ·
  **Scans from {scanners} show here.**
- **Reconnecting**: chip amber; strip **Showing scans up to 6:43 PM.** above the filters; rows at 72 %; no layout
  shift. On reconnect missed rows replay in order (no per-row animation for replays), then the chip turns green.
  After a `reset` the list reloads from the snapshot.
- Wake lock on every visible; refused: chip **Keep this screen on** (ST).

## 4. Pairing and roles

Console (section 10, `x-admin`): **Devices** grouped by station; **Add device** → **Scanner · Customer screen · Desk
monitor · Till**; a monitor's **Watch** (This station · Stations · Event · Zones · Everything) and **Shows** (Door ·
Desk); station settings (welcome, refused line, greet, show ready, show draft). Copy: ST §1-§6.

On the device (`ux-roles`):

| State | Copy | Notes |
| --- | --- | --- |
| Pair confirm | **Pair as Customer screen** · **Front desk · Northside Gym**; rows **Shows results to customers** *Never scans. An admin can change it.* · **No names but first names** *No reasons, notes or photos.*; **Cancel** · **Pair** | the scanner's pair card with role and station |
| Menu | **Show to customer** *Turn this phone into a customer screen.* (highlighted, `MonitorSmartphone`) between Camera and Switch staff | hidden on tills, admin sessions, `customerToggle` off |
| Which scanner is it facing? | title, sub **This phone shows that scanner's results.**; groups **{station}** then **Other scanners**; radio rows (name, staff or **Online**); **Cancel** · **Show to customer** | never itself, a till or a screen |
| Facing scanner | capsule chip **Customer screen on** (teal; icon only on phone, label in VoiceOver; icon + label on iPad) | presence |
| Flipped | the customer idle face | swap without reload |
| Back to scanning? | hold the capsule 1 s (ring fills) → desk-panel card **Back to scanning?** *Enter a staff PIN.*, six dots, keypad; dock **Cancel** | any active staff; signs them in when sign-in is on |
| No staff | hold 2 s; the ring fills, pill **Keep holding** | console marks **Anyone can switch it back** |
| Screen only | **This device is a screen.** · **Ask an admin to change it.** (buddy flat) | `SCREEN_ONLY` |

## 5. Access card on the scanner

Copy is AX §1.3 (`SCAN_REASON_COPY`). Plan chips: **24/7** violet `infinity`, **Timed** teal `clock` (label = plan
name, e.g. **Off-peak**), **Guest** gold `ticket`.

| State | Band | Body | Dock | Buddy |
| --- | --- | --- | --- | --- |
| Granted | green row **Access granted**, sub pin + **Pool** | photo 96 (Desk and up; else the pass tile), holder, **Membership**, plan chip; panel **Visits**: This month · Last visit | strip **{holder} · Pool · 6:41 PM** + Undo | `gate`: the gold pass is the barrier arm, lifts, waves through, rests at +8° (AX §4.6) |
| Again | same | Last visit **Today** | strip **Again · 2 min ago** | `gate` |
| Timed | sub **Gym · until 4:00 PM** (closes within 12 h) | Off-peak chip | | `gate` |
| Guest | sub **Gym · until 9:00 PM** | pass tile, **Guest of Maya Okafor**, Guest chip; Visits: **Visits left 3 of 5** · **Until 9:00 PM** | | `gate` |
| Not in plan | red stack **Not in plan**, **Off-peak doesn't include Pool.** | compact row (neutral tile), holder, plan chip; note **Ask at the front desk.** | strip | shake |
| Outside hours | **Outside hours**, **Off-peak opens 4:00 PM.** | compact row | **Let in anyway** (Manager) · **Done** | shake |
| Guest pass ended | **Guest pass ended**, **Ended 9:00 PM.** | compact row + note | | shake + the gold pass greys and droops |
| No visits left | **No visits left**, **Used 5 of 5.** | | | shake |
| Suspended | **Suspended**, **Ask them to see the front desk.** | chip **Suspended** | (never overridable) | shake |
| Not open yet | **Not open yet**, **Opens Dec 1.** (red on access) | | | shake |
| Re-entry wait (opt-in) | amber **Entered 2 min ago**, **Next entry in 13 min.** | photo row | strip **First in 6:41 PM · Pool gate · Sam K.**; **Let in again** · **Done** | `wrist` |

Never **Already checked in** for access. Let in anyway appears on the five overridable reasons when `letInAgain` isn't
`never`, always through a Manager (signed in or PIN).

## 6. Motion

| Moment | Spec |
| --- | --- |
| Customer result | BF rise (210 + overshoot + settle) from the buddy's pocket; tint 80 linear; beats per BM |
| Customer idle wave | the teal pass up −58°, two motion lines, once per return to idle, 550 ms |
| `sorry` (customer refusal) | BM §6.4 |
| `gate` | AX §4.6; reduced motion: arm at +8° |
| Monitor new row | translateY(−8) → 0 and opacity .4 → 1, 220 `--e-out`; tint fades 2 s linear |
| Monitor alert | scale .98 → 1 with `--spring`, 320; the buddy's shake (BM §6.3) once |
| Reconnecting | chip cross-fade 120; no movement in the list |
| Hold to switch back | ring `stroke-dashoffset` over 1 s (2 s with no staff), linear; release before full undoes in 150 |
| Reduced motion | cross-fades only, as BF |

## 7. Accessibility (WCAG 2.2 AA)

- Verdict = colour + glyph shape + words everywhere (rows too). Red text in rows is `#b91c1c` light (6.5:1 on white)
  and `#f87171` dark (7.2:1 on `#0d111b`); amber text uses the gold chip foreground.
- Customer screens: a live region announces the band headline and sub once per result; idle is not announced.
- Monitor: new rows are announced politely only when a screen reader is on and only alerts (assertive); **Seen** is a
  44 px button; filters are real buttons with `aria-pressed`; counters have text labels.
- Hold to switch back has a non-drag alternative for staff: the console's **Make it a scanner** (2.5.7 is met by a
  single-pointer press, not a drag).
- Touch targets ≥ 44; type ≥ 13 px only for secondary meta; chips that drop their label keep `aria-label`.
- Holds on customer screens are fixed (4 s / 6 s); they don't block anything (2.2.1: the content isn't needed to act).

## 8. Build notes

| Piece | Where (SA layout) | Reuses |
| --- | --- | --- |
| Customer face | `src/web/scan/customer/` (`customer-face.tsx`, `customer-card.tsx`, `customer.css`) | the result card, band, glyphs, chips, stamps, money rows, `WalletArt`, the rise/tuck runtime |
| Monitor face | `src/web/scan/monitor/` (`monitor-face.tsx`, `feed-row.tsx`, `alert.tsx`, `counters.tsx`, `monitor.css`) | glyph shapes, chips, photos via the audience grant, the capsule |
| Role flip | `src/web/scan/role/` (`show-to-customer.tsx`, `back-to-scanning.tsx`) | the scanner's sheet and PIN keypad |
| Access results | no new view: the display model + `SCAN_REASON_COPY` + `gate` in `beat-map.ts` | |
| Tokens added | `--c-ground`, `--c-glow-a`, `--c-h`, `--c-sub`, `--c-hi`, `--c-val`, `--c-body`, `--c-small` (customer); nothing for the monitor | |
| Mock CSS to port | `assets/x-cust.css`, `x-mon.css`, `x-dev.css`, `x-access.css` | |

## 9. Open items

1. **"In now" for gyms.** Owner asked for "in now"; zones have no exits (AX), so access monitors show visits today
   and the last hour. Real occupancy needs exit scanners (direction `out`), a later wave.
2. **Two customers at one screen.** Newest wins with the scanner's name (ST §1.5); a station per till is the fix.
3. **Customer screen at a door** (no counter): the phone layout works on a wall-mounted iPad in portrait; not mocked.

## 10. Admin: stations, screens and the Access card blueprint

Console mocks: `sheets/x-admin-{light,dark}.png` (pages `pages/ad-*.html`, shots `shots/ad-*.png`, generator
`gen/admin.mjs`, CSS `assets/x-admin.css`). 1440 × 900 and 390 × 844, light and dark. Concepts and copy: stations.md
§1, §6; access.md §3.6, §4. Zones, the plan editor, the pass form and the scanner Checks picker are the access
architect's mocks (`access/admin/shots/*`); the sheet shows them last for reference and this section does not restate
them.

### 10.1 Devices tab (`/admin/scanning?tab=devices`, replaces Scanners)

- Tabs: **Devices · Events · Zones · Staff · Scans**. Header **Scanning**; actions **New station** (outline, `MapPinned`)
  and **Add device** (primary).
- The list groups by station. Group header: `MapPinned` tile (accent-subtle), name, count line
  (**2 scanners · 1 customer screen · 1 desk monitor**), a feed line of chips (**Front gate, Front till → Counter
  iPad**, role icons), **Settings**, **Add device** (preset to this station), menu (**Rename**, **Archive station**).
  Last group **No station** (dashed border, `CircleDashed`): scanners that need no screen and monitors that watch more
  than one place.
- Columns, fixed widths so groups align: **Device** (role tile 36, name, device line) · **Role** pill · **Shows or
  checks** · **Status** (Online, Offline, Not paired; as SD 10.2) · **Today** · **Last seen** · menu (or **Pair**).
- Shows or checks, per role: Scanner **Checks** + zone chips (or the event, or **Accepts 2 templates**); Customer screen
  **Every result from {station}**; Desk monitor **Watches this station · Desk**, **Watches** + zone chips **· Door**,
  **Watches everything · Desk**; Till **Accepts 2 templates**.
- A phone switched on the device: device line **Safari on iPhone · switched on the device 6:02 PM** and
  `LockKeyhole` **Staff PIN to switch back** (or **Anyone can switch it back** when the org has no active staff).
- Role icons, one per role everywhere (console, pairing card, presence): Scanner `ScanLine`, Till `Store`, Customer
  screen `MonitorSmartphone` (violet tint), Desk monitor `Monitor` (teal tint).
- Phone (390): one card per station, a 60 px row per device: role tile, name, **{Role} · {what it shows or checks}**,
  online dot (green, grey offline, amber not paired), chevron to the detail. Header action **Add**.

### 10.2 Add device (`md`, 640)

- **What is it?** four option tiles, 2 × 2: **Scanner** *A phone or iPad that scans passes.* · **Customer screen**
  *Faces the customer and shows each result.* · **Desk monitor** *Shows scans as they happen.* · **Till** *A
  point-of-sale system with a token.*
- Scanner: the SD 10.2 fields, plus **Station** (optional) and **Checks** (zones).
- Customer screen: **Name** (help **Shown in the console and on the pairing screen.**), **Station** (required; help
  **Shows every result from Front desk's scanners.**; link **New station** creates one inline by name). Info callout:
  **Customer screens never show a reason, a staff note or a photo. Refusals read Please see the desk.**
- Desk monitor: **Name**, **Station** (optional; help **Optional. A monitor in a station shows on its device list.**),
  **Watch** segmented **This station · Stations · Event · Zones · Everything**; Stations and Zones open a chip picker
  (**2 of 8**; help for zones **Every scan in these zones, at any door that checks them.**); Event a select.
  **Shows**: **Door** *What a Door scanner sees.* · **Desk** *Also desk-only details.* (never Manager).
- Footer **Cancel** · **Create and pair** (`QrCode`); Till: **Create** and the token reveal as SD 10.2.

### 10.3 Pairing a screen

The existing pairing face (`pairing-face.tsx`). Above it the role pill and **at Front desk · Northside Gym**; the
instruction says **On the iPad** for display kinds; tip row `Lightbulb` **Turn on Guided Access on the iPad to keep
this screen in front.**; status **Waiting for the iPad…**. On the device the confirm card reads **Pair as Customer
screen · Front desk · Northside Gym** (stations.md §6.1).

### 10.4 Station settings (`lg`, 760)

Fields left, the customer screen's idle face right (220 × 400, live from the fields: org capsule, the welcome line,
the buddy waving).
- **Name** (help **Shown on the customer screen under the organization.**)
- **Welcome** (help **The idle line. Up to 40 characters. Empty: Hold up your pass.**)
- **Refusal line** (placeholder **Please see the desk**; help **Every refusal and heads-up on the customer screen.**)
- Switches: **Greet by first name** *"Hi, Maya" on results.* · **Show the desk card** *While staff choose an action:
  "Hi, Sam · Balance $42.50".* · **Show amounts under review** *"To pay $12.00" before staff confirm.*
- Footer **Archive station** (danger, ghost; confirm **Archive Front desk?** · **Its devices leave the station.
  Customer screens show Not set up.**) · **Cancel** · **Save**.

### 10.5 Device dialog for a scanner (station, role, zones)

**Name** · **Station** (help **Its results show on Pool's customer screen.**) · **Role** (kind `device` only):
**Scanner** *Scans passes.* · **Customer screen** *Shows Pool's results to the customer.* · **Checks**: chips with
the zone tree in a popover (checkbox per zone, indent 20 per level, `aria-level`, ≤ 8, **2 of 8**); help **Lets in a
pass that opens either zone now. Empty: Any zone.** Under it a status line `DoorOpen` **Open now for 24/7, Off-peak.
Closed for Guest day (Sauna: members only).** (access.md 3.6, "Open now for"). Event scanners disable Checks with
**Events check in once. Zones don't apply.**

### 10.6 Blueprints with the Access card

- Gallery order (access.md §4): **Membership, Access, Poster, Balance, Stamp, Coupon, Event, Boarding**; four columns at
  1440, so the Access card sits beside Membership.
- Tile as TI §4: drafting-grid stage tinted from `pass.json` (Cobalt `#1D3ABA`, label `#CFE0FF`), the real pass still
  (photo thumbnail: three foil door arches on the blueprint), glyph `Key` 36 r 8, **Access card**, **Door access by
  plan and zone, with a photo for ID checks.**, **Use**. No "New" badge.
- **Use blueprint** dialog: the glyph in the title; **Organization**, **Name**; a **Comes with** list of the three plans
  (`Infinity` **24/7** · All zones; `Clock3` **Off-peak** · Mon–Fri 6 AM–4 PM, 8–11 PM · Sat–Sun 8 AM–8 PM; `Ticket`
  **Guest day** · All zones, ends at midnight); callout **Add zones in Scanning, then pick them per plan.** · **Zones**.
  **Cancel** · **Continue** (to the designer, TI §6.2).
- Phone: one column, Access card second.

### 10.7 Accessibility

Role pills and option tiles carry text with the icon (no colour-only meaning). The zone tree is a listbox with
`aria-level`; chips have a remove button labelled **Remove Pool**. Switches are labelled by their title; the preview is
`aria-hidden`. All targets 44 on touch; contrast from the kit's tokens in both themes.
