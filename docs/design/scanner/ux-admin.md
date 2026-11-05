# Scanner: admin and platform UX

2026-11-04. The admin console side of scanning, plus every place scanning shows up elsewhere in PassBook. The staff
app at `/scan` is designed separately. This document fixes the contracts it must honour: pairing, roles, outcome
words, test mode and admin scanning.

Sources and how they are cited:
- **R §x** is the research report `research/scanning/report.md`. **R crit n** is its critic's correction n.
- **PM §x** is `docs/design/scanner/platform-map.md`. **MA** is `map-access.md` and **MD** is `map-domain.md`.
- **n8b** is the owner's buddy brief `n8b-buddy.md`.
- **UI**, **UX** and **MO** are `docs/design/{ui-consistency,ux-principles,motion-and-expression}.md`. **BG** is the
  brand guide.
- Code paths are relative to `scratchpad/next` unless prefixed `n6:` or `n7:`.

---

## 0. Decisions at a glance

1. **One nav item, Scanning**, at `/admin/scanning`. It has four tabs: **Scanners · Events · Staff · Scans**. It
   replaces the `/admin/scanners` placeholder.
   - Event dashboards and scanner details are detail pages under it.
   - The word "devices" stays reserved for Wallet devices (UX rule 4).
2. **A scanner is one paired phone, tablet or computer.**
   - It belongs to one org and one mode.
   - It accepts either one **event** or a set of **templates**.
   - Its name is its place ("Front door", "Till 2"). That name is what a heads-up shows as *where*: "6:02 PM · Front
     door" (R §5.2).
3. **Pairing:**
   - The pairing code is single-use and lives 10 minutes.
   - It is shown on the buddy's QR sign. That is the same `Scan` sign component the holder add block uses, with the
     buddy aiming at the code.
   - The QR opens `/scan` with the code in the URL fragment, which `/scan` strips at once.
   - **Pair this phone** handles the case where the admin's own phone is the scanner.
4. **Staff are org people with a PIN, not platform users.**
   - Roles form a ladder: **Door ⊂ Desk ⊂ Manager**.
   - Each template action sets the lowest role that may run it.
   - A scanner either asks for a staff PIN or runs as a default role.
   - This adds no org membership or session model. The org-membership gap is MA §10.1.
5. **Events are light objects**: a name, 1 to 20 templates, an optional "only passes where *input* = *value*" rule, a
   scanning window and a re-entry switch.
   - They give check-ins their per-event key, so a season ticket can be checked in at each show.
   - They make "x of y" exact (PM §10.15).
6. **Template scan actions** go in a new **Scanning** section of the designer, with five plain kinds: Check in · Add
   to a number · Take from a number · Set a value · Use up the pass.
   - Each action has a repeat rule, a minimum role, confirm-first and **Notify the holder** (off by default).
7. **NFC is set up on the Apple identity page**, in an **NFC** card that replaces today's bare NFC switch.
   - The card walks through: apply to Apple, upload the certificate, mark it approved, make a reader key, test a reader.
   - **The reader key pair is made in the browser. PassBook stores only the public half** and the private key is
     downloaded once.
   - The designer gets an **NFC** section that is honest about whether NFC is available.
8. **Scans in the pass Sync log** get a **Scans** filter, method icons, and Undo from the row.
   - The pass header meta row gains one line: "Checked in 6:02 PM · Front door", or "Last scan Nov 3".
9. **The live event dashboard** has five parts:
   - a hero "312 of 500 checked in" with a progress bar;
   - check-ins per minute, using the overview's existing `LineChart`;
   - a By scanner table;
   - a heads-up and refusal breakdown;
   - a latest-scans feed, with **Pause updates** for WCAG 2.2.2.
10. **Overview** gains a **Live now** card while an event is open, **Scans** and **Refused** counts, and a **Scans**
    chart.
11. **Test mode:**
    - A scanner made in Test mode is a Test scanner. It accepts only test passes.
    - It can show a sample test pass in the pairing dialog for a rehearsal.
    - It switches to live with **Go live**, without pairing again.
12. **Holder touches are deliberately small**, because a check-in that changes no field costs no publish and no push:
    - Wallet passes change only when an action changes a value.
    - Value changes are **silent by default**, which protects the 3-a-day budget and stays clear of iOS 27 throttling.
    - The portal (signed in only, never `/p`) shows "Checked in Nov 14, 6:02 PM".
13. **Broadcasts can target by scan state**: Checked in / Not checked in at an event, No scan in 30 / 90 days. The
    passes list uses the same contract.
14. **Audit:** configuration and overrides go to `audit_log` as the existing `device` actor (no CHECK rebuild).
    Individual scans go to a `scans` table and to the pass ledger.

---

## 1. Words (one meaning each)

| Say | Means | Never |
| --- | --- | --- |
| Scanner | One paired device that scans for an org | Device, reader (as the whole thing), terminal |
| Reader | External hardware plugged into a scanner: a USB/BT barcode gun or an NFC reader | Scanner |
| Staff | A person who scans, with a name, role and PIN | User, operator, member |
| Door, Desk, Manager | The three staff roles | Admin (that is a platform role) |
| Event | A scanning occasion with a window and templates | Session (sign-in sessions), show |
| Scan | One attempt, with any result | Transaction, tap (unless NFC) |
| Checked in | An OK check-in for the event or day | Redeemed, entered, admitted |
| Heads-up | The amber result: a real pass that needs a person (already in, too soon) | Warning, duplicate |
| Refused | The red result, always with a reason | Invalid, rejected |
| Undo | A compensating scan written later | Reset, revert |
| Use up | A single-use redeem that voids the pass | Burn, consume |
| Pair, Pair again | Connect a device to a scanner | Log in, register |
| Go live | Switch a Test scanner to live | Publish, activate |

- **Collision to fix.** `ENTITY.activity` is labelled `Event` (`src/web/lib/entities.ts`), and the Sync log says
  "Show 4 events".
  - Rename them to **Entry / entries** and "Show 4 entries".
  - "Event" then means only a real-world occasion, which already matches n3's upcoming events.
  - This touches n1 (`sync-tab.tsx`) and h0 (`entities.ts`). Flag it to integration.
- Outcome and reason words live in one file, **`src/shared/copy/scan.ts`**, used by `/scan`, the admin pages and the
  CSV export (§16.2). That is one implementation of the shared concept.

### 1.1 Entity identity (UI "Entity identity", R1)

| Entity | Icon | Art (new) | Verb (entrance, then beat) |
| --- | --- | --- | --- |
| Scanner | `ScanLine` | `scanner`: a handheld phone frame with four reticle corners; the scan line is the accent part | The line sweeps down once (360 ms ease-out), then the corners snap in (160 ms spring). Beat: one more sweep |
| Event | `CalendarCheck` | `stub`: a ticket with a perforated stub; the punched hole is the accent part | The stub tears 4 px along the perforation (300 ms), then the hole pops (.6 → 1, 240 ms bounce). Beat: the hole pops again |
| Staff | `IdCard` | `badge`: a lanyard badge with a photo block and two bars; the clip dot is the accent part | It drops on its lanyard 8 px and swings ±6° once (420 ms spring). Beat: a small swing |
| Scan (rows) | the method icon: `Camera`, `ScanBarcode` (reader), `Nfc`, `Keyboard` (manual), `MonitorSmartphone` (admin console) | Uses `activity` art: scans are ledger entries | |

- Each art stays at or under 40 SVG nodes, with 1.5 px non-scaling strokes and one accent part (MO "Entity art").
- They live in the lazy registry chunk (`ui/art/registry.ts`).
- Budget: about +1.2 to 1.6 kB gzip on an art kit capped at 15 kB, whose headroom has not been measured (PM §8).
  **Measure it before building.** If it is over, raise it in a 0.75 to 2 kB step with a comment, as past raises did.

---

## 2. Information architecture

### 2.1 Nav (`src/web/lib/nav.ts`)

The third group becomes `Messages · Scanning · Test inbox`. n6 adds Test inbox.

```ts
page('Scanning', '/admin/scanning', 'scanner', true, ['scanners', 'staff', 'events', 'check in', 'nfc'])
```

- `orgScoped: true`.
- `ENTITY.scanner`, `ENTITY.event` and `ENTITY.staff` are added to `entities.ts`.
- **Bundle:** `entities.ts` and the nav sit in the entry chunk, which has about 5 B of headroom (PM §8). Three Lucide
  icons add roughly 0.5 to 0.8 kB. **This needs the owner-approved budget raise** (n6 already took +1.5 kB), or the
  entity icons for nav must load lazily. I recommend the raise: lazy nav icons would flash.

### 2.2 Routes

| URL | Page | Notes |
| --- | --- | --- |
| `/admin/scanning` | Scanning, tab `scanners` (default) | `?tab=scanners\|events\|staff\|scans`, replace-history like detail tabs (UI "Tabbed detail pages") |
| `/admin/scanning?tab=scans&scannerId=&staffId=&eventId=&outcome=&range=` | Scans log, filtered | Filters live in the URL so links from dashboards and rows work |
| `/admin/scanning/scanners/$scannerId` | Scanner detail | |
| `/admin/scanning/events/$eventId` | Live event dashboard | Shareable; ops keep it open on a laptop at the door |
| Dialogs | New scanner and pairing, Edit event / New event, Add staff / Edit staff, NFC key, Test a reader | No `new.tsx` pages: every create is a short form |

- Code goes in `src/web/admin/scanning/**` and `src/web/routes/admin/scanning/**`. Delete `admin/scanners/` and
  `routes/admin/scanners/`.
- Update the n8 ownership row in AGENTS.md and next-wave.md to these paths.
- **Command palette** (`lib/actions.ts`): add **New scanner**, **New event** and **Add staff**, each with its entity
  icon.

### 2.3 Page frame

- `PageHeader title="Scanning"`.
- The actions change with the tab, so there is one primary per view:

  | Tab | Header actions |
  | --- | --- |
  | Scanners | **New scanner** (`Plus`, primary) |
  | Events | **New event** (primary) |
  | Staff | **Add staff** (primary) |
  | Scans | **Export CSV** (`Download`, outline) |

- When a tab is truly empty, its header action turns outline and the empty state holds the only primary (UI "Empty").
- Tabs come from the kit `Tabs`. With 4 tabs they stay a scrolling strip at every width; only 5 or more become a
  select below 640 (UI rule).
- In Test mode the n6 band hangs under the bar, and every list shows test records only (§10).

---

## 3. Rights model

### 3.1 Roles

| Role | Can | Default for |
| --- | --- | --- |
| **Door** | Look up a pass, run actions marked *Door staff and up*. Undo their own scans for 10 minutes | Check in |
| **Desk** | Door, plus actions marked *Desk staff and up*. Undo their own scans for 10 minutes | Add, Take, Use up |
| **Manager** | Everything: *Managers only* actions, **Check in again** on a heads-up, undo any scan on that scanner today, and approve an amount over the action's maximum | Set a value |

- Platform admins scanning with their own session act as Manager (actor `user`).
- **Effective right** of a scan, enforced server-side in this order:
  1. the scanner accepts the pass (its event, or its templates; its mode; its org);
  2. the template defines the action;
  3. the acting role is at least the action's minimum role.
- Each failure has its own reason (§16.2). The client shows only the buttons the role may press, but the server decides.
- **Manager approval on a shared device.**
  - When a Door or Desk person presses **Check in again** or **Undo** past their window, `/scan` asks for a manager PIN
    in place, as a POS does.
  - It is one 6-digit field, titled **Manager PIN**, with the help line **A manager enters their PIN to approve.**
  - The approving manager is recorded as `approvedBy`.
- Research basis:
  - per-action rights and an override for set and undo (MA §10.3, PM gap 6);
  - staff PIN pattern (R §1 Loyalty iCard; manual-lookup notes, PushPress staff PIN);
  - Force Check-In only on soft failures (event-checkin notes, TicketSpice).

### 3.2 Staff sign-in on a scanner

| Scanner setting | Behaviour on `/scan` | Attribution |
| --- | --- | --- |
| **Staff sign-in: Off** (default) | Anyone holding the device scans as the scanner's **Role without sign-in** (default Door) | Scanner only |
| **Staff sign-in: On** | "Who's scanning?" shows a list of the org's active staff, then a PIN. The scanner locks after **15 minutes** idle, or on **Switch staff** | Scanner and staff |

PIN rules:
- 6 digits, generated, stored hashed.
- 5 wrong tries on a scanner lock that staff member on that scanner for 5 minutes. The lock is audited as
  `staff.pin_locked`.
- A disabled staff member's shift ends at their next scan, which is refused with `staff_disabled`.

### 3.3 Undo (R §5.3, §5.8.10)

| Who | Window |
| --- | --- |
| Door, Desk | Their own scans, 10 minutes |
| Manager on a scanner | Any scan on that scanner, same local day |
| Admin in the console | Any scan of the org. A plain confirm, audited |

- Undo writes a compensating `scan.undone`.
- For Add, Take and Set it republishes with the old value, silently.
- For Use up it unvoids.
- An undone check-in frees the claim, so the pass can be checked in again.

---

## 4. Scanners tab

### 4.1 List

Columns: the kit `DataTable` with `getRowId`, `data-new`, and `LoadMore` paging. Scanners are filtered by the current
mode and the org scope.

| Column | Content | Hidden |
| --- | --- | --- |
| Name | `RowLink` to the detail page (strong; teal and underlined on hover). Second line `text-xs fg-muted`: "Safari on iPhone" from the paired user agent (as `SessionList` does), or **Not paired** | — |
| Status | `StatusPill`: **Online** (success, seen within 2 min) · **Offline** (neutral) · **Not paired** (warning) · **Revoked** (neutral), plus `ModePill compact` | — |
| Accepts | "Saturday gala" (event icon `CalendarCheck` 14 px first) · "3 templates" · "All templates" | below 768 → stacked line |
| Staff | "Sam K." (who is signed in now) · **Sign-in off** · **—** | below `xl` |
| Today | Successful scans since local midnight, right-aligned `tabular-nums`; zero shows muted `0` | below `lg` |
| Last seen | `RelTime` "2 min ago" · **Never** | below `lg` |
| Organization | Only when the scope is All organizations | below `lg` |
| Actions | Ghost `…` menu: **Pair** or **Pair again** (`QrCode`), **Duplicate** (`Copy`), **Revoke** (`Ban`, danger, last) | — |

- **Revoked** rows sit behind "Show revoked (n)" in the footer, the same as API keys (`api-keys-page.tsx`).
- No filters until 10 or more scanners exist. Then: search (`w-64`), **Status: any**, **Accepts: any** (event picker).
- Online and Offline come from a heartbeat. `/scan` pings `POST /api/v1/scan/heartbeat` every 60 s while visible, and
  scans count as a beat too. The list refetches every 30 s while visible, with no visual change unless values change;
  a changed pill does one ring pulse (MO "Status change").

**1440**

```
Scanning                                                     [+ New scanner]
[ Scanners ][ Events ][ Staff ][ Scans ]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Name                 Status      Accepts         Staff        Today  Last seen │
│ Front door           ● Online    ▣ Saturday gala Sam K.         212  now     … │
│ Safari on iPhone                                                             │
│ Side door            ○ Offline   ▣ Saturday gala Sign-in off     88  14 min  … │
│ Till 2               ▲ Not paired 3 templates    —                0  Never  [Pair] │
└──────────────────────────────────────────────────────────────────────────────┘
3 scanners in Northwind                                   Show revoked (1)
```

- A **Not paired** row shows a ghost `sm` **Pair** button in its trailing cell instead of the menu trigger. The menu
  moves to the next cell. This follows the UI rule: one safe action is a ghost button.

**820:** Name, Status, Accepts, actions. Today and Last seen join the second line: "Safari on iPhone · 212 today · now".

**390:** stacked rows (UI Tables below 768).

```
Front door                       ● Online
Saturday gala · 212 today · now
──────────────────────────────────────────
Till 2                       ▲ Not paired
3 templates                        [Pair]
```

### 4.2 Empty states

| State | Art | Title | Line | Action |
| --- | --- | --- | --- | --- |
| No scanners (live) | `scanner`, buddy curious, `inspect` scene (kit default) | **No scanners yet** | **Pair a phone, tablet or computer to check passes.** | **New scanner** (primary) |
| No scanners (Test mode) | same | **No test scanners yet** | **Test scanners accept test passes only.** | **New scanner** |
| Filtered | `scanner` dimmed + lens, `sweep` | **No scanners match** | — | **Clear filters** |

### 4.3 New scanner dialog (`md`, bottom sheet below 640)

Title **New scanner**, plus the Test pill when the admin is in Test mode. The mode is the admin's current mode, as for
passes (next-wave "Mode"). There is no mode field.

| Field | Control | Default | Copy |
| --- | --- | --- | --- |
| Name * | Input, `data-autofocus`, max 40 | — | Placeholder **Front door**. Help **Shown on scans as where they happened.** |
| Organization | Select | the scope's org; required when the scope is All organizations | — |
| Accepts | `SegmentedControl` **An event** / **Templates** | **An event** if the org has an upcoming or live event, else **Templates** | — |
| Event | `EntityPicker kind="event"` (upcoming and live first, then ended within 7 days) | the soonest upcoming event | Empty: **No events yet.** plus the link **New event** (opens that dialog over this one, then returns with it selected) |
| Templates | Checkbox list (the n7 `audience.tsx` pattern), first row **All templates** | none | Error **Pick at least one template.** |
| On scan | Select: **Do the first action at once** / **Show the actions** | first action for an event, or when every accepted template has one action with no confirm; otherwise Show the actions | Help **Staff can still pick another action.** |
| Staff sign-in | Checkbox **Ask staff for their PIN** | off | Help when off: **Anyone with this scanner scans as** + Select **Door** / **Desk** / **Manager** (default Door) |

- Footer: **Cancel** · **Create and pair** (primary).
- On success the dialog turns into the pairing face (§4.4). Escape and the outside click are disabled from then on.
- Server errors map to fields: `name` **A scanner here already has this name.**, `templateIds`, `eventId`
  **This event has ended.**

### 4.4 Pairing face

This face is shared by the New scanner dialog, the **Pair** row action and the detail page's **Pair again**.

```
┌ Pair Front door                                   [Test] ┐
│  ┌──────────────┐   On the scanner                       │
│  │  (buddy M)   │   Open passbook.mobile/scan and         │
│  │ ┌──────────┐ │   scan this code.                       │
│  │ │  QR      │ │                                         │
│  │ └──────────┘ │   Or type   K7QM-4XPD   [Copy]          │
│  └──────────────┘   Expires in 9:42                       │
│                                                          │
│  ◌ Waiting for the scanner…                               │
│                                   [Pair this phone]      │
│                                              [Close]     │
└──────────────────────────────────────────────────────────┘
```

**Component.**
- `portal/add/scan.tsx` `Scan` is reused with `url` = the pairing URL and `label` **Pairing code for Front door**. That
  gives the same sign, `QrTile`, and buddy M with the `nudge` scene aiming its pass at the code.
- n8b says "holds a pass up like a key card". The nudge's lifted, aimed pass is that pose, so no new scene is needed.
- The `wl-ways` column holds:
  - the label **On the scanner** (`Smartphone` icon);
  - **Open passbook.mobile/scan and scan this code.**;
  - **Or type**, then the code;
  - the countdown.
- One implementation of "a QR on the buddy's sign" across holder and admin.

**Code.**
- 8 characters of Crockford base32 (no I, L, O, U), shown as `K7QM-4XPD` in `font-mono text-base tracking-[0.12em]`,
  with a `CopyButton`. Accepted case-insensitive, with or without the dash.
- It has about 40 bits, is single-use, lives 10 min, and is rate-limited per IP (PM §4 rate limits: new `RL_SCAN_PAIR`,
  id 1010).

**QR payload.**
- `https://passbook.mobile/scan#pair=K7QM4XPD`.
- `/scan` reads the fragment once on load, then calls `history.replaceState` to drop it before anything else runs.
- No hash routing (R §5.8.2), and the code never reaches a server log or a Referer (PM §10.27).
- A phone's camera app opens it straight into `/scan`, which pairs with no typing.
- **Contract for the `/scan` designer.**

**Countdown.** `Expires in 9:42` is `text-sm fg-muted tabular-nums` and updates each second. It sits outside the live
region, so screen readers are not flooded. At 0:00 three things happen:
- the QR dims to .35 opacity with a `RotateCw` overlay button **New code**;
- the line reads **Code expired.**;
- the buddy turns flat with one head shake (the `beat` scene, 640 ms; n8b "Bad or expired code: a quick head shake").

**Waiting line** (`role="status"`, polite):
- It shows a pending ring with **Waiting for the scanner…**.
- The dialog polls `GET /api/v1/scanners/{id}/pairing` every 2 s while open and visible.

**Paired.**
- The face crossfades (160 ms) to a sign showing the scanner art in its final pose. The buddy plays **hello** once
  (happy).
- Title **Front door is paired**.
- One line: **Safari on iPhone · Paired just now**.
- Footer: **Done** (primary). Test scanners also get **Show a test pass** (§10.2).
- A `toast.success` is not shown: the dialog is the confirmation, and its buddy is in view.

**Pair this phone** (outline):
- It opens `/scan#pair=K7QM4XPD` in a new tab.
- Use it when the admin is holding the scanner device, for example setting up a door phone while signed in as admin.
- The admin session is untouched. The scanner token is a separate cookie (PM §10.1).

**Pair again** on a paired scanner first confirms:

| Title | Line | Button |
| --- | --- | --- |
| **Pair Front door again?** | **The device using it now signs out at its next scan.** | **Pair again** |

It is not a danger button: the act is reversible by pairing again.

**Close before pairing.** The scanner stays **Not paired**, and the code expires. Nothing else changes.

**Reduced motion.** No nudge and no hello. The buddy is shown seated, then happy. The QR dim is a 150 ms opacity
change.

**390.** Bottom sheet. The sign is full width with the buddy on its top edge. The ways line, code and countdown sit
under it. Buttons stack: **Pair this phone**, then **Close**, both 44 px.

### 4.5 Scanner detail (`/admin/scanning/scanners/$scannerId`)

Header:
- Breadcrumbs **Scanning › Front door**. The crumb links to `?tab=scanners`.
- Title: the scanner's name.
- Meta row, in order:
  - the status pill and `ModePill`;
  - `RelTime` "Last seen 2 min ago";
  - Accepts: "Saturday gala" as `EntityChip kind="event"`, or "3 templates";
  - `MetaLink` **Scans** (`ScanQrCode` icon), which opens `?tab=scans&scannerId=…`.
- Actions: **Pair again** (outline), or **Pair** (primary) when not paired. A Test scanner adds **Go live** (outline,
  §10.3). **More** holds **Duplicate** (`Copy`) and **Revoke** (`Ban`, danger).

`TwoPane` (aside 20rem from 1280):

| Main | Aside |
| --- | --- |
| **Settings** card. The same fields as the dialog, in a `FormGrid`, saved through `SaveBar` | **Device** card: KeyValue **Device** "Safari on iPhone"; **Paired** "Nov 3, 2026, 9:12 AM"; **Last seen**; **Signed in** "Sam K." or **—**; **Reader** "Keyboard reader seen today" / **None** |
| **Activity** card. Header actions: `Select` **Today** / **7 days** / **30 days**. Body: the overview `LineChart` (one series **Scans**, hourly for Today, daily otherwise, with **Show data**). Under it one row of counts: **Done 412 · Heads-up 9 · Refused 14 · Undone 2**, each a `CountLink` to the Scans tab filtered | **How** card: four rows **Camera 92% · Reader 6% · NFC 0% · Manual 2%** (`ListRow`, method icon, a value with no bars) |
| **Recent scans** card. The last 10 as `ListRow`s (§8.2 row shape). Card header action **All scans ›** | **Danger** card: **Revoke** (danger outline) with one line **Signs the device out. Its scans stay.** |

**Revoke confirm** (`revokeScannerConfirm` in `lib/confirms.ts`). It is plain, not typed, because revoking a lost
phone must stay one click (the same rule as API keys):

| Title | Line | Button |
| --- | --- | --- |
| **Revoke Front door?** | **The device stops scanning at once. Its scans stay. This cannot be undone.** | **Revoke** (danger) |

After revoking:
- `toast.success('Scanner revoked')`;
- the `Ban` verb stamps on the status pill;
- the page stays, with **Revoked** and no actions except **Duplicate**.

**Duplicate:**
- It opens New scanner prefilled with "Front door 2" and the same settings. It does not copy the pairing.
- This is the fast way to add many doors.
- Bulk creation is deliberately not offered: each door is paired on its own anyway.

**820:** the aside stacks under the main column (TwoPane below 1280). Activity and Recent scans keep full width.
**390:** the header actions are one row with More (UI rule 5). The Settings form is one column and the SaveBar is
sticky. The chart is 160 px tall.

---

## 5. Staff tab

### 5.1 List

| Column | Content |
| --- | --- |
| Name | A 24 px initials avatar (`EntityAvatar kind="staff"`) and the name (plain strong text: there is no detail page) |
| Role | A neutral pill: **Door** / **Desk** / **Manager** |
| PIN | "Set Nov 2" (`text-sm fg-muted`), or the warning pill **Locked** while locked anywhere |
| Today | Scans today, as a `CountLink` to `?tab=scans&staffId=…` |
| Last scan | `RelTime` and the scanner name: "2 min ago · Front door" |
| Actions | `…` menu: **Edit** (`Pencil`), **Reset PIN** (`RotateCw`), **Disable** / **Enable**, with destructive items last |

- Disabled staff go behind "Show disabled (n)".
- **Callout**, only when the org has staff but no scanner asks for a PIN. Tone `info`, one line:
  **No scanner asks for a PIN yet, so scans don't name staff.** The action **Scanners** goes to the Scanners tab.
- Staff are org people and have **no mode**. The same list shows in Test mode.
- 820 hides Last scan. 390 uses stacked rows: name and role pill, then "12 today · 2 min ago".

### 5.2 Add staff / Edit staff dialog (`md`)

| Field | Control | Copy |
| --- | --- | --- |
| Name * | Input, max 40 | Placeholder **Sam K.** Help **Shown to other staff on the scanner.** |
| Organization | Select (only with the All organizations scope) | — |
| Role * | `RadioGroup` of three `OptionTile`s | **Door**: *Look up passes and check in.* · **Desk**: *Also add, take and use up.* · **Manager**: *Also set values, check in again and undo any scan.* |

- Footer **Cancel** · **Add** (or **Save**).
- After **Add**, the dialog shows the PIN once, through `SecretReveal`:
  - fields: label **PIN**, value `482 019`, copy label **Copy PIN**;
  - title (with `IdCard` verb-done) **Sam K.'s PIN**;
  - saved label **I saved the PIN**.
- **Reset PIN** confirms:

  | Title | Line | Button |
  | --- | --- | --- |
  | **Reset Sam K.'s PIN?** | **Their old PIN stops working at once.** | **Reset PIN** |

  The reveal follows. PINs are never shown again.
- **Disable** confirms:

  | Title | Line | Button |
  | --- | --- | --- |
  | **Disable Sam K.?** | **They can't sign in to scanners. Their scans stay.** | **Disable** (danger) |

### 5.3 Empty

| Art | Title | Line | Action |
| --- | --- | --- | --- |
| `badge`, `inspect` | **No staff yet** | **Give each person a PIN to see who scanned what.** | **Add staff** |

---

## 6. Events

### 6.1 Events tab list

| Column | Content |
| --- | --- |
| Name | `RowLink` to the dashboard. Second line: the template names, truncated |
| When | "Nov 14, 6:00 PM – 11:00 PM" in the event's time zone, plus `(PT)` when it differs from the browser |
| Status | **Upcoming** (info, `CalendarClock`) · **Live** (success, `Radio`) · **Ended** (neutral, `CalendarCheck2`) · **Archived** (neutral) |
| Checked in | "312 of 500", right-aligned `tabular-nums`; for upcoming events "— of 500" |
| Scanners | "3", as a `CountLink` to the Scanners tab with `?eventId=` |

- Order: Live, then Upcoming (soonest first), then Ended (newest first).
- Archived events go behind "Show archived (n)".
- 820 hides Scanners. 390 uses stacked rows: name and status pill, then "Nov 14, 6:00 PM · 312 of 500".

**Empty:**

| Art | Title | Line | Action |
| --- | --- | --- | --- |
| `stub`, `inspect` | **No events yet** | **Count who's in at the door.** | **New event** |

### 6.2 New event / Edit event dialog (`md`; `lg` from 1024 when the template list is long; bottom sheet below 640)

The title is **New event** (plus the Test pill in Test mode) or **Edit Saturday gala**.

| Field | Control | Default / rule | Copy |
| --- | --- | --- | --- |
| Name * | Input, max 60 | — | Placeholder **Saturday gala** |
| Templates * | Checkbox list, 1 to 20 | none | Error **Pick at least one template.** Rows for templates with no check-in action read **No check-in action** (muted) and are disabled |
| Only passes where | Two fields in one row: Select **Input** (scalar inputs shared by every chosen template) + Input **Value** | empty means all passes of those templates | Help **Leave empty to admit every pass of these templates.** Example placeholder `2026-11-14` |
| Scanning opens * | `DateTimeField` with a zone select | 2 h before the next round hour | — |
| Scanning closes * | `DateTimeField` | opens + 6 h | Error **Must be after it opens.** |
| Re-entry | Checkbox **Allow re-entry** | off | Help **A checked-in pass is admitted again and each entry is counted.** |
| Scanners | Checkbox list of the org's scanners with their current Accepts as meta | none | Help **Moves them to this event.** Shown only on Edit or when scanners exist |

- Footer **Cancel** · **Create** (or **Save**).
- Create replaces history to the dashboard, with a `CreatedCallout` (UI "Create flows") titled **Event created**. Its
  next steps:
  - **Add a scanner**: opens New scanner with this event;
  - **Assign scanners**: present only if the org has scanners;
  - **View passes**: the passes list filtered to this event.

**Rules the server applies:**
- `y` is the number of active, not removed passes of the templates that match the rule, in the event's mode.
- Checked in is the number of distinct passes with an OK check-in claim for the event.
- Outside the window, scanners refuse with `not_open_yet` or `event_ended` (§16.2; R crit 10 "not yet valid").
- A pass outside the rule is refused with `wrong_event`.

### 6.3 Live event dashboard (`/admin/scanning/events/$eventId`)

**Header:**
- Breadcrumbs **Scanning › Saturday gala**. Title: the event name.
- Meta row: the status pill, then "Nov 14, 6:00 PM – 11:00 PM", then the template names, then `ModePill`.
- Actions:
  - **Pause updates** / **Resume updates** (outline, `Pause` / `Play`; hidden when the event is not Live);
  - **Open scanner** (outline, `ExternalLink`), which opens `/scan?event={id}` in a new tab so an admin can scan under
    their own session (§10.4);
  - **More**: **Edit** (`Pencil`), **Assign scanners**, **Export CSV** (`Download`), **Archive** (last).

**Data:**
- `GET /api/v1/scan-events/{id}/live` returns `{ checkedIn, total, entries, ratePerMin, rateSeries[60], peak,
  byScanner[], reasons[], latest[20], updatedAt }`.
- While Live and visible it polls every **5 s**, and stops on **Pause updates** or a hidden tab.
- After a 150 ms delay, a refetch shows the 2 px `LoadingRail` on the hero card only.
- Values change in place, so there is no layout shift.

**1440** (main width about 1150 px, 3-column grid, 24 px gaps):

```
Scanning › Saturday gala
Saturday gala                       [Pause updates] [Open scanner ↗] [More]
● Live · Nov 14, 6:00 PM – 11:00 PM · VIP, General
┌────────────────────────────── (buddy S seated at end) ┐ ┌ Per minute ─────────┐
│ Checked in                                             │ │ 18          last 5 min│
│ 312  of 500                                     62%    │ │ ▁▂▃▅▇▆▅▃▃▂▂▃▅▆▅▃     │
│ ███████████████████████████░░░░░░░░░░░░░░░░             │ │ Peak 41 at 6:24 PM   │
│ 188 not checked in ›   312 checked in ›                │ └──────────────────────┘
└────────────────────────────────────────────────────────┘
┌ By scanner ───────────────────────────────────────────┐ ┌ Heads-up and refused ┐
│ Scanner        Staff     In   Last 10 min  Heads-up Refused Last scan │ Already checked in 12│
│ ● Front door   Sam K.   212   ████ 61       9       3   now        │ Not found          4│
│ ○ Side door    —         88   █ 12          2       1   14 min     │ Not for this event 2│
│ ▲ Till 2       —          0     0           0       0   —  [Pair]  │ Expired            1│
└────────────────────────────────────────────────────────┘ └──────────────────────┘
┌ Latest scans ───────────────────────────────────────────── All scans › ┐
│ ● 6:41 PM  Anna Meyer        Checked in          Front door · Sam K.  ▣  │
│ ▲ 6:41 PM  Leo Park          Already checked in  Side door · first 6:12  │
│ ✕ 6:40 PM  Unknown code      Not found           Front door           │
└────────────────────────────────────────────────────────────────────────┘
```

**Hero card** (spans 2 columns):
- Label **Checked in** (`text-sm fg-muted`).
- The value is `CountUp` `text-3xl font-semibold tabular-nums`, with **of 500** in `text-base fg-muted`. The percentage
  sits at the right in `text-sm`.
- **Progress bar:**
  - an 8 px track in `surface-sunken`, `rounded-full`;
  - an accent fill drawn with `transform: scaleX(p)` from the left (600 ms ease-out on change; none under reduced
    motion);
  - `role="progressbar"` with `aria-valuenow/min/max` and `aria-valuetext="312 of 500 checked in"`;
  - the fill against the track meets the 3:1 non-text contrast in both themes (accent `#2DD4BF` on `#020408`, `#0F766E`
    on `#EBEEF8`).
- Under the bar, two `CountLink`s:
  - **188 not checked in ›** opens the passes list filtered `eventId=…&checkedIn=no`. This is the admin's door list.
  - **312 checked in ›**.
- With re-entry on, a third muted line reads **340 entries**.
- Screen readers: a visually hidden polite live region announces "312 of 500 checked in" at most every 30 s, and only
  when the value changed. Nothing else on the page is a live region.

**Per minute card:**
- **18** is check-ins per minute, averaged over the last 5 minutes. The label beside it reads **last 5 min**.
- Under it is the overview's `LineChart` (`admin/overview/chart.tsx`): one series, 60 one-minute points, with the
  existing crosshair tooltip, **Show data** toggle and accent stroke. That is one chart implementation; no new chart
  type.
- The line under it reads **Peak 41 at 6:24 PM**.
- Single series: no legend, and the title names it (dataviz: one series needs no legend).

**By scanner card** (spans 2 columns):
- One row per scanner on the event: status dot (the pill's icon), `RowLink` name, staff signed in now, **In**,
  **Last 10 min**, **Heads-up**, **Refused**, **Last scan**.
- **Last 10 min** has an inline bar: a single-hue accent bar scaled to the busiest scanner. The number is always beside
  it, so the bar is never the only signal.
- A not-paired row shows **Pair** (opens the pairing face).
- Rows link to the scanner detail page.
- Footer link **Assign scanners**.

**Heads-up and refused card:**
- `ListRow`s with the reason label (from `copy/scan.ts`) and its count right-aligned. Each row is a link to
  `?tab=scans&eventId=…&reason=…`.
- The leading icon is the outcome's icon shape: triangle for heads-up, octagon-X for refused. Text stays in `fg`
  tokens, with no red text (dataviz "text wears text tokens").
- Empty: inline **Nothing refused yet.**

**Latest scans card** (full width):
- The newest 20, each a §8.2 row: outcome icon, time, pass title (`RowLink`, or **Unknown code**), the result, then
  "Scanner · Staff", and the method icon with a tooltip.
- New rows get the insert highlight (accent-subtle overlay fading over 1200 ms, MO "Row inserted"), with no movement.
- **Pause updates** freezes this list too.
- The card header action is **All scans ›**.
- Not a live region.

**Before and after the window:**

| State | Hero | Per minute card | Extra |
| --- | --- | --- | --- |
| Upcoming | **Opens Nov 14, 4:00 PM** in place of the count, and **500 passes** | Replaced by **Readiness**: "Scanners: 2 of 3 paired", "Online now: 1", each not-paired scanner with **Pair**, plus **Add a scanner** | Latest scans is hidden |
| Ended | **412 of 500 checked in**, with no live updates | **Arrivals**: the same `LineChart` over the whole window, in 5-minute points; **Peak 41 at 6:24 PM** | **Pause** is hidden. **Archive** is promoted to an outline header button |

**Buddy** (one per view; S seated at the end of the hero card's top edge, which reserves 56 px above the card):

| Moment | Mood / scene | Trigger |
| --- | --- | --- |
| Upcoming | neutral, rest | — |
| Live, page opened | neutral, `count` (it counts its passes) once, 700 ms after landing | mount |
| First check-in of the event | happy, `wave` once | `checkedIn` goes 0 → ≥1 while open |
| Half in | `Celebrate` sparks on the bar's fill end, no buddy scene | crosses 50% |
| Everyone's in (`checkedIn == total`) | happy, `cheer` once, plus `Celebrate` sparks | crosses 100% |
| Ended | neutral | — |

- Each milestone plays **once per event per browser** (`sessionStorage` key `wl-event-milestone:{id}:{name}`), never on
  refetch or revisit. This follows MO "Motion follows data" and "Celebrations: milestones only, from data".
- Under reduced motion: no fall and no scene, only the final pose. Sparks are off.
- The progress bar and the numbers say everything. The buddy is decoration (`aria-hidden`).

**820:**
- The hero card goes full width, then Per minute and Heads-up side by side in 2 columns, then By scanner, then Latest
  scans.
- By scanner hides **Last scan** and **Heads-up**.
- Header actions stay one row: **Pause updates**, **Open scanner**, **More**.

**390:**
- One column: hero, Per minute, By scanner, Heads-up and refused, Latest scans.
- The hero number stays `text-3xl`. The bar is full width.
- By scanner becomes stacked rows: "● Front door · Sam K.", then "212 in · 61 in 10 min · 3 refused".
- Latest scans rows are two lines: the title and the result, then "6:41 PM · Front door".
- Header: **Pause updates** and **More**. **Open scanner** moves into More, because on a phone the admin is likely the
  scanner.

**Assign scanners dialog** (`md`):
- A checkbox list of the org's scanners. Each row: name, status pill, and current Accepts as meta ("Now: Templates").
- Footer **Cancel** · **Assign**.
- Toast **2 scanners now scan Saturday gala**. Audited `scanner.updated` per scanner.

**Archive confirm:**

| Title | Line | Button |
| --- | --- | --- |
| **Archive Saturday gala?** | **Scanners on it stop accepting passes for it. Its scans stay.** | **Archive** |

It is not danger: unarchive exists in the archived list's row menu.

---

## 7. Scans tab (the org's scan log)

**Filter toolbar** (UI "Filters"):
- search **Pass name or ID** (`w-64`);
- **Scanner: any**, **Staff: any**, **Event: any** (all `EntityPicker`s);
- **Result: any** (Done / Heads-up / Refused / Undone), **Reason: any** (shown when Result is Heads-up or Refused);
- **Date: today** (the one date range control; default today, unlike other lists);
- **Clear**.

Below 1280 the first two show inline and the rest go under **Filters (n)**.

| Column | Content | Hidden |
| --- | --- | --- |
| Time | "6:41 PM", or "Nov 13, 6:41 PM" when not today | — |
| Result | Pill: **Done** (success, `CircleCheck`) · **Heads-up** (warning, `TriangleAlert`) · **Refused** (danger, `OctagonX`) · **Undone** (neutral, `Undo2`) | — |
| Pass | `RowLink` to the pass detail (title), or muted **Unknown code** | — |
| What | Detail from `copy/scan.ts`: "Checked in" · "Add stamp · 7 → 8" · "Already checked in · first 6:12 PM" · "Expired" · "Not found" | — |
| Where | Scanner name (link), or **Admin console** | below `lg` |
| Who | Staff name, an admin's name, or **—** | below `xl` |
| How | The method icon with a tooltip: **Camera**, **Reader**, **NFC**, **Manual**, **Admin console** | below `lg` |
| Actions | Ghost **Undo** (`Undo2`, `sm`) when undoable by an admin | — |

- Row click opens a right **sheet** titled with the result and what happened ("Checked in"). It shows a KeyValue:

  | Label | Value |
  | --- | --- |
  | Time | the full date |
  | Pass | the link |
  | Template | the name |
  | Event | the name |
  | Scanner | the name |
  | Staff | the name |
  | Approved by | the manager |
  | How | the method |
  | Amount | the amount |
  | Before → after | the values |
  | Pass version | `v9` |
  | Reason code | `font-mono text-xs` under **Details** |
  | Scan ID | mono |

  Actions: **Undo** and **Open pass**.
- **Undo confirm**, plain, built by `undoScanConfirm(what)`:

  | Title | Line (by kind) | Button |
  | --- | --- | --- |
  | **Undo check-in?** | **The pass can be checked in again.** | **Undo** |
  | **Undo Add stamp?** | **Stamps go back to 7. The pass updates without a notification.** | **Undo** |
  | **Undo Use coupon?** | **The pass is active again on the holder's device.** | **Undo** |

  Toast `toast.success('Scan undone')`. The row stays, and a new **Undone** row inserts above it with the highlight.
- **Never shown:** the raw scanned text, emails or tokens. A refused unknown code stores no code at all (PM §10.32;
  R §4 rule 6).
- **Export CSV** exports the filtered rows. Columns: time ISO, result, reason code, what, pass ID, pass title, template,
  event, scanner, staff, method. Audited `scan.exported`.

**Empty states:**

| State | Art | Title | Action |
| --- | --- | --- | --- |
| Truly empty | `activity` | **No scans yet** | **New scanner** (outline) when the org has none, else none |
| Filtered | lens over `activity` | **No scans match** | **Clear filters** |
| Default "today" with older scans | inline line **No scans today.** with **Show last 7 days** | — | — |

820 and 390: stacked rows. Line 1 is the result pill and the pass title. Line 2 is "6:41 PM · Front door · Sam K.",
then the detail.

---

## 8. Scans on the pass (pass detail)

### 8.1 Sync log (`admin/passes/detail/sync-tab.tsx`, `sync-model.ts`; n1 owns these, and this is an additive touch)

- **Filter:** `FILTERS` becomes **All · Scans · Delivery · Devices · Changes**. Scans sits second because, on a
  scanned pass, it is what staff ask about.
  - Contract: `EVENT_GROUPS` gains `scans` (`contracts/events.ts`).
  - Empty: **No scans yet**.
  - The choice is kept in the URL as `?log=scans` so the header link can deep-link (it is local state today).
- **New ledger kinds** (closed enum, `contracts/events.ts`): `scan.heads_up` and `scan.undone`, beside the existing
  `scan.checked_in`, `scan.redeemed`, `scan.adjusted` and `scan.rejected`. Data keys:
  - `scanId`, `actionId`, `outcome`, `reason`, `method`, `scannerId`, `scannerName`;
  - `staffId`, `staffName` (staff are org people, not holders, so `sanitizeEventData` keeps them);
  - `eventId`, `before`, `after`, `version`, `approvedBy`, `firstAt`.
  - Never a code, an email or a holder name (MD §3.1).
- **Row titles** (`SINGLE_TITLE` and a `scanTitle(e)` that reads `copy/scan.ts`):

  | Kind | Title | Detail line | Tone |
  | --- | --- | --- | --- |
  | `scan.checked_in` | **Checked in** (or **Checked in again** with `approvedBy`) | "Front door · Sam K. · Camera" | success |
  | `scan.adjusted` | the action label, e.g. **Add stamp** | "7 → 8 · Till 2 · Ana R. · v9" | success |
  | `scan.redeemed` | the action label, e.g. **Use coupon** | "Till 2 · Ana R. · v12" | success |
  | `scan.heads_up` | **Already checked in** / **Too soon** | "Side door · first 6:12 PM" / "next in 4 min" | warning |
  | `scan.rejected` | **Refused: Expired** (`Refused: ` + reason label) | "Front door · Camera" | danger |
  | `scan.undone` | **Undone: Checked in** | "by Ana R. (Manager) · Front door" | neutral |

- **Icons:** the dot uses the method icon (`Camera`, `ScanBarcode`, `Nfc`, `Keyboard`, `MonitorSmartphone`) in the
  tone's colours, so camera and NFC rows are told apart without colour.
- **Undo inline:** an undoable scan row shows a ghost `sm` **Undo** at its right edge, with the same confirm as §7.
- **Publishes from scans:**
  - A `pass.updated` whose `source` is `scan` titles as **Updated to v9 by a scan**.
  - The existing `overBudget` fact shows as a neutral `Badge` **Silent: daily limit**, so admins see why no
    notification appeared (n7 budget).

### 8.2 One scan row shape

The same row is used in Recent scans (scanner detail), Latest scans (dashboard) and the Sync log scans filter, through
`ScanRow` in `admin/scanning/scan-row.tsx`. The Sync log keeps its own timeline frame but calls `scanRowText()` for the
title and detail, so the words are identical.

### 8.3 Check-in summary on the pass

- **Header meta row** (`detail-page.tsx`): after "On 2 devices", add one `MetaLink` with the `ScanLine` icon, linking
  `?tab=sync&log=scans`:

  | Pass state | Text |
  | --- | --- |
  | Checked in at one event | **Checked in 6:02 PM · Front door** (date shown when not today: "Checked in Nov 14, 6:02 PM") |
  | Checked in at several | **Checked in at 3 events** |
  | Scanned, no check-in | **Last scan Nov 3** |
  | Never scanned | nothing |

- The DTO gains `scanSummary: { kind: 'checked_in'|'scanned', at, scannerName?, events? } | null` on `PassDetailDto`.
  It is computed from `scan_claims` and `scans`, one indexed query.
- No new tab: pass detail already has 9 tabs and overflows at 1280 (next-wave Wave 1 status).
- **Passes list:**
  - New filters **Event: any** (EntityPicker) and **Check-in: any / Checked in / Not checked in**. Check-in is disabled
    until an event is picked, with the tooltip **Pick an event first.**
  - Plus **Last scan: any / In 30 days / None in 30 days / None in 90 days / Never**.
  - They live in the list's `Filters (n)` overflow (`list-filters.tsx`, workstream i).
  - With an event filter set, the list gains a **Checked in** column showing "6:02 PM" or **—**. That makes the list
    the admin door list (R §4 "Door list").

---

## 9. Overview

Edits to `admin/overview/*`. They show only when the scope's org has a scanner or a live event, which
`data.setup.scanners > 0` tells.

1. **Live now card**, placed after the Kpis and before the charts. It is present only while at least one event in
   scope is Live.
   - `CardHeader` title **Live now**; actions **Scanning ›** (ghost `sm`).
   - Up to 3 rows (`ListRow`):
     - leading `CalendarCheck`;
     - title = event name (link);
     - meta "312 of 500 · 18 / min";
     - trailing: a 96 px progress bar, the same component as the hero, `size="sm"`, 4 px tall.
   - More than 3: footer link **2 more live ›**.
   - Polls every 15 s while visible. No buddy, because the overview has its own cameo slots.
2. **More counts row** (`kpis.tsx` `Secondary`), after **Downloads** in the range part: **Scans 1,204** (link to the
   Scans tab, range-mapped) and **Refused 31** (link with `outcome=refused`).
3. **Charts card:** a fifth chart, **Scans** (series `scans`, OK results only).
   - It spans both columns at `md` and up (`md:col-span-2`), so the grid stays even.
   - The `d1` source still says **Approximate** as today.
   - AE serves charts only; the counters come from D1 (PM §5 Metrics).

Contract (`contracts/metrics.ts`):
- `totals.scans`, `totals.scanRefused`, `series.scans`, `setup.scanners`;
- `live: [{ eventId, name, checkedIn, total, ratePerMin }]`, at most 3.

Both the AE query (`scan.result` added to `EventName`) and the D1 fallback over `scans` (`org_id, mode, at` index)
filter by mode.

---

## 10. Test mode for scanners

Built on n6. `ModePill`, `ModeBand` and the Test tone come from `n6:src/web/ui/layout/mode-*`. Scanners, events and
scans are lists, so they filter by the admin's mode (next-wave "Mode": "every list ... scans and anything new").

### 10.1 Rules

| Scanner | Test pass | Live pass |
| --- | --- | --- |
| Live | Refused: **Test pass** · **Only test scanners accept it.** | Accepted |
| Test | Accepted | Refused: **Live pass** · **Only live scanners accept it.** |

- Scans write `pass_events.mode` and `scans.mode` from the **pass** (next-wave n8).
- Test scans vanish with the test pass at the sandbox purge, through the cascade (MD §6).
- Test scanners and test events are configuration and are not purged.
- A Test scanner on `/scan` shows the n6 amber band, reading **Test scanner**. Contract for the `/scan` designer:
  - The band must not be confused with the amber heads-up.
  - The band is a 20 px strip at the top edge.
  - Heads-up is a full-bleed wash with a triangle icon (R §2.2).

### 10.2 Rehearsal: Show a test pass

- On a Test scanner, the paired face and the detail header's More menu offer **Show a test pass**.
- It calls `POST /api/v1/scanners/{id}/sample-pass`. That creates one test pass of the scanner's first accepted
  template, using the template's sample inputs, with no holder and no email.
- It opens a `md` dialog titled **Test pass**, with a `PassCardStage` still showing the barcode, large enough to scan
  off a laptop screen. The caption reads **Scan it with Front door. It's deleted with other test passes.**
- Buttons: **Another test pass** and **Done**.
- This is Admittee's demo ticket for rehearsal (R §1).

### 10.3 Go live

- A Test scanner's header has **Go live** (outline).

  | Title | Line | Button |
  | --- | --- | --- |
  | **Make Front door live?** | **It starts accepting live passes and stops accepting test ones. Its test scans stay in Test mode.** | **Go live** |

- On success, `toast.action('Front door is live', { label: 'Leave Test mode', onClick: () => setMode('live') })`. The
  scanner then leaves the test list.
- The device keeps its pairing, so a door phone rehearses and then goes live without re-pairing.
- Live → test is offered in More as **Move to Test mode**, with the reverse copy. Both are audited
  `scanner.mode_changed`.
- Events cannot switch mode: a test event counts test passes. Create a live event for the real night.

### 10.4 Admin scanning

- `/scan` with an admin session and no scanner token offers **Scan as {name}**, with an org picker and an event or
  templates picker.
- `/scan?event={id}`, from the dashboard's **Open scanner**, preselects the event. An event ID is not a capability, so
  it may sit in the URL.
- It follows the admin's Test mode through the shared `localStorage` key `passbook-mode` (`n6:src/web/lib/mode.ts`).
  The header is sent by `modeHeaders()`.
- Admin scans have actor `user`, method as scanned, scanner **Admin console**, role Manager.
- The 1 h idle admin session is extended by each scan, because activity counts as use.

---

## 11. Template designer: Scanning and NFC sections

The designer is n5's area (`src/web/admin/templates/designer/**`). These are additive files:
- `section-scan.tsx`, `ops-scan.ts`, `section-nfc.tsx`, `ops-nfc.ts`;
- `Section` gains `'scan' | 'nfc'` in `model.ts`, with labels **Scanning** and **NFC**;
- the outline order becomes … Inputs · Barcode · **Scanning** · **NFC** · Relevance;
- tests go in `designer.test.ts` (pure ops) and `designer-ui.test.tsx`.

It renders at 820 (structure column beside a 20rem card) and 1440 (three columns). On phones it is preview-only, as
today (`layout.tsx`).

### 11.1 Manifest shape (validated by `scanIssues` beside n7's `messaging.ts`; PM §3 "Template actions")

```jsonc
"scan": {
  "actions": [
    { "id": "checkin", "label": "Check in", "kind": "check_in",
      "repeat": "once", "minRole": "door", "confirm": false,
      "record": { "input": "lastVisit" } },               // optional; writes the time silently
    { "id": "stamp", "label": "Add stamp", "kind": "add", "input": "stamps",
      "amount": 1, "askAmount": false, "max": 10,
      "repeat": "wait", "waitMinutes": 5, "minRole": "desk", "confirm": false, "notify": false },
    { "id": "reward", "label": "Redeem reward", "kind": "take", "input": "stamps",
      "amount": 10, "minRole": "desk", "confirm": true, "notify": false },
    { "id": "tier", "label": "Set tier", "kind": "set", "input": "tier",
      "askValue": true, "minRole": "manager", "confirm": true, "notify": false },
    { "id": "use", "label": "Use coupon", "kind": "use_up", "minRole": "desk", "confirm": true }
  ]
}
```

- **Kinds.** `check_in | add | take | set | use_up` replace the research's `increment | set | redeem` (R §5.8.8).
  "Take" is an increment with a balance guard, so "Not enough stamps · Has 7, needs 10" falls out of it (R §5.2
  `no_balance`).
- **Repeat.** `once | daily | wait | always`. `daily` is new (gym desks: **Already checked in today**). Under an event,
  `once` means once per event.
- **No block.** A template with no `scan` block behaves as `[{ id: 'checkin', label: 'Check in', kind: 'check_in',
  repeat: 'once', minRole: 'door' }]`.
- **Limits.** At most 6 actions; labels at most 24 characters and unique; amounts 1–1000; waits 1–1440 minutes.

### 11.2 Scanning section

**Banner** (top of the section, only when needed):

| Condition | Callout | Action |
| --- | --- | --- |
| Barcode off | warning: **Scanners need a barcode or NFC to find these passes.** | **Show a barcode** |
| Barcode message is static text | warning: **Every pass has the same barcode, so scanners can't tell them apart.** | **Use scan code** |
| Barcode bound to an input | info: **Scanners match this barcode by its text. Two passes with the same text can't be told apart.** | **Use scan code** |
| Bound to the scan code | none | — |

**Use scan code** sets the barcode message to `{{pass.scanCode}}` (`SourcePicker` `scanCode`). PM §9 keeps this binding,
and R conclusion 5 recommends an opaque token.

**Actions list:**
- Rows use the `dz-row` pattern from the Inputs section: grip, kind icon, label, summary, chevron. Drag reorders;
  keyboard reorders with the existing grip key handling.
- Collapsed row summary (`text-xs fg-muted`):
  - "Once per event · Door"
  - "+1 stamps · every 5 min · Desk"
  - "−10 stamps · Desk · Confirm"
  - "Staff enter tier · Managers"
  - "Voids the pass · Desk · Confirm"
- The first row carries a neutral `Badge` **First**. Help line under the list: **Scanners set to "Do the first action
  at once" run the first one.**
- With no `scan` block, the list shows the implied **Check in** row with a **Default** badge. Editing it writes the
  block.
- **Add action** (ghost, `Plus`) below the list. Disabled at 6, with the tooltip **Up to 6 actions.**

**Action inspector** (the expanded row). Controls are the designer's own `TextEdit`, `PickEdit` and `SwitchRow`, so
every edit is one undo step:

| Control | Shown for | Options / copy | Default |
| --- | --- | --- | --- |
| Label * | all | Placeholder by kind: **Check in**, **Add stamp**, **Redeem reward**, **Set tier**, **Use coupon**. Help **The button staff press.** | the kind's placeholder |
| Does | all | **Check in** · **Add to a number** · **Take from a number** · **Set a value** · **Use up the pass** | Check in |
| Number | add, take | `PickEdit` of number inputs (`scalarInputs` filtered to `number`/`integer`). None: inline error **Add a number input first.** with the link **Inputs** (selects the section) | first number input |
| Input | set | `PickEdit` of scalar inputs | — |
| Amount | add, take | `NumberField` `w-28`, unit = the input's label ("stamps") | 1 (add), 10 (take) |
| Staff enter the amount | add | `SwitchRow`; when on, **Up to** `NumberField` (max per scan; a Manager can go over, §3.1) | off |
| Value | set | **Staff pick or type it** (`SwitchRow`, default on), else a fixed value field | — |
| Repeat | check in, add | **Once** (help under an event: **Once per event.**) · **Once a day** · **After a wait** (+ minutes `NumberField`) · **Any time** | Once (check in), After a wait 5 min (add) |
| Who can do it | all | **Door staff and up** · **Desk staff and up** · **Managers only** | Door (check in), Desk (add, take, use up), Managers (set) |
| Confirm before applying | all | `SwitchRow`. Help **Staff see the change and press it again.** | on for take, set, use up; off for check in, add |
| Allow check in again | check in | `SwitchRow`. Help **A manager can admit a pass that's already in.** | on |
| Notify the holder | add, take, set | `SwitchRow`. Help **Uses 1 of 3 notifications a day per pass. Past that it updates silently.** (the limit is read from settings) | **off** |
| Record the time on the pass | check in | `SwitchRow`, then a `PickEdit` of date inputs. Help **Updates the pass silently on every check-in.** | off |

- Use up shows one fixed line in place of options: **Voids the pass. Undo brings it back.**
- **On the scanner** preview: a strip under the list shows the actions as staff will see them. It is a row of
  `sm` buttons in the scanner's style: the first is primary, the rest outline. It is not interactive (`inert`), with
  the caption **On the scanner**. This answers "what will staff see?" without leaving the designer.
- **Issues** (n5's issues panel, from the dry-run validator):

  | Code | Severity | Message |
  | --- | --- | --- |
  | `SCAN_INPUT_MISSING` | error | **{Label}: pick a number.** |
  | `SCAN_INPUT_NOT_NUMBER` | error | **{Label}: {input} isn't a number.** |
  | `SCAN_LABEL_DUPLICATE` | error | **Two actions are called {Label}.** |
  | `SCAN_AMOUNT_RANGE` | error | **{Label}: amount must be 1 to 1000.** |
  | `SCAN_WAIT_RANGE` | error | **{Label}: wait must be 1 minute to 24 hours.** |
  | `SCAN_TOO_MANY` | error | **Up to 6 actions.** |
  | `SCAN_CODE_NOT_IN_BARCODE` | warning | **Scanners can't tell passes apart by this barcode.** |
  | `SCAN_NOTIFY_FREE_TEXT` | warning | **{Label} notifies on a text input.** (mirrors `CHANGE_MESSAGE_FREE_TEXT`) |

**Starters** (a2 owns `templates/**`). The defaults are below. Each change bumps the version and causes a stale reissue
of every pass of that starter; that is a real change, published silently (PM §3 Baked).

| Starter | Barcode | Actions |
| --- | --- | --- |
| event ticket | `{{pass.scanCode}}` | Check in |
| coupon | `{{pass.scanCode}}` | Use coupon |
| store card | `{{pass.scanCode}}` | Add stamp (+1, every 5 min), Redeem reward (−10, confirm) |
| generic / poster generic | `{{pass.scanCode}}` | Check in (daily) |
| boarding pass | unchanged | Check in |

The Henry's templates are left alone: their key-tag barcode is a fixed workflow (catalog §15 line 670).

### 11.3 NFC section

| Identity state (the template's org identity, else the platform default) | Section shows |
| --- | --- |
| Not NFC-ready | `SwitchRow` **Hold near reader (NFC)**, disabled. Help **Needs an Apple identity with NFC. {Identity label} has none.** Link **Set up NFC** to that identity's page (§12) |
| NFC-ready | The switch is enabled. When on: KeyValue **Message** "Scan code of the pass" (fixed; R §5.7 "default and recommended"); `SwitchRow` **Ask for Face ID first** with help **Turns off sharing of the pass.** (writes `requiresAuthentication` and forces `sharingProhibited`, R §3.1); a muted line **The barcode stays as a fallback.** |

- The build omits `nfc` silently when the pass's identity is not NFC-ready (R §5.7 Build).
- The designer issue `NFC_IDENTITY` (info) reads **NFC is off for passes signed by {identity}.**
- Activating a version that turns NFC on uses the existing "Update N passes" flow. Its confirm adds: **Only passes
  signed by {NFC identity} get NFC.** Passes keep their identity forever (PM §6).

---

## 12. NFC setup (Apple identity page)

Workstream n2 (`admin/identities/**`).
- The **NFC** switch leaves `SettingsCard` (`identity-cards.tsx:140`) and the upload dialog.
- A new **NFC** card sits under **Push** (`nfc-card.tsx`).
- The state comes from `IdentitySchema`: `nfcEnabled`, plus `nfcKey: { fingerprint, createdAt, passCount,
  previous?: { fingerprint, passesLeft } } | null`.

### 12.1 States

**A. Environment identity** (`source = 'env'`, the platform's `pass.im.plrs.wallet`). The card body reads:

> **NFC needs a pass type ID that Apple approved for NFC. Upload it as its own identity.**

It has one outline action, **Upload identity**.
- `readEnvIdentity` hard-codes NFC off (PM §6). NFC therefore always arrives as a new DB identity, and only new passes
  on that identity get it.

**B. Not approved** (DB identity). Pill **Not approved** (neutral). The kit `Checklist` titled **Turn on NFC**:

| Step | Body | Action |
| --- | --- | --- |
| 1. Apply to Apple | **Apple reviews NFC requests, usually in 2 to 8 weeks.** KeyValue rows with `CopyButton`: **Team ID** `48H7CLBV8Y`, **Pass type ID** `pass.…`. Reader to name: **Dot Origin VTAP100** | **Open Apple's form** (`ArrowUpRight`, external) |
| 2. Upload the NFC certificate | **When Apple approves, upload the new certificate here.** | **Rotate certificate** (opens the existing `RotateIdentityDialog`) |
| 3. Mark as approved | **Apple's certificate doesn't say NFC in a way PassBook can check.** | **Mark as approved** |

Mark as approved confirms:

| Title | Line | Button |
| --- | --- | --- |
| **Mark {label} as NFC approved?** | **Templates with NFC on add it to passes signed by this identity. Wallet ignores it if Apple didn't approve.** | **Mark as approved** |

Audited `identity.nfc_approved`. **Not approved** comes back with **Mark as not approved** in the card's `…` menu.

**C. Approved, no reader key.**
- Pill **Approved** (info).
- Body: **Make a reader key. Readers decrypt passes with it.**
- Primary **Make reader key**.

**D. Ready.** Pill **Ready** (success). KeyValue:
- **Reader key** `a3f1 9c02` (mono, the first 4 bytes of the SHA-256 of the public key, which is what the reader sees,
  R §5.7);
- **Made** "Nov 4, 2026";
- **Passes with NFC** "1,204" (`CountLink`);
- **Templates with NFC** "2".

Actions:
- **Test a reader** (outline);
- the `…` menu: **Rotate key** (`RotateCw`) and **Mark as not approved**.

During a rotation, a second block reads:
- **Old key** `77be 0d41`;
- **1,180 of 1,204 passes updated**, as a 4 px progress bar;
- **Retire old key** (outline), enabled when the remaining count reaches 0, or earlier with a warning confirm.

### 12.2 Make reader key dialog (`md`)

1. **Face 1.**
   - Title **Make reader key**.
   - Body: **Each reader needs the private key. PassBook keeps only the public half, so download it now and keep it
     with your reader setup.**
   - Footer **Cancel** · **Make key**.
2. **Make key** runs in the browser:
   - WebCrypto generates an ECDH P-256 key pair (`crypto.subtle.generateKey`, `extractable: true`).
   - The SPKI public key goes to `POST /api/v1/identities/{id}/vas-keys { publicKey }`.
   - The private key never leaves the browser except as the user's download.
   - This settles the storage gap: no `vas_keys` private columns and no KEK rotation gap (PM §6, MD §13.3).
3. **Face 2** (`SecretReveal`-style; Done waits for the checkbox):
   - Title **Download the reader key** (with the `KeyRound` turn verb).
   - Rows:
     - **For VTAP readers**: **Download** gives `config.txt` and `private1.pem` (two downloads from one click);
     - **Key file (PEM)**: **Download** gives `passbook-reader-{fingerprint}.pem`.
   - Checkbox **I saved the key file** gates **Done**.
   - Muted line: **Lost it? Rotate the key and set up readers again.**
4. Audited `vas_key.created` with the fingerprint.

The VTAP `config.txt` lines (`VAS1MerchantID=<pass type ID>`, `VAS1KeySlot=1`) and the key slot naming are **[U]**.
Verify them against `VTAP_Configuration_Guide.pdf` (R §6 sources) before building. Until verified, the VTAP row is
labelled **For VTAP readers (check the VTAP guide)**.

### 12.3 Rotate key

The confirm is guarded by blast radius: it reaches many holder devices, so it shows the count and a danger button.

| Title | Line | Button |
| --- | --- | --- |
| **Rotate the reader key for 1,204 passes?** | **New passes get the new key now. Existing passes update silently over the next day. Keep the old key on readers until they're done.** | **Rotate** (danger) |

- The new key is made in the browser (§12.2).
- Passes on the identity reissue through the stale-reissue path with `notify: false`.
- Audited `vas_key.rotated`.

### 12.4 Test a reader dialog (`md`)

```
┌ Test a reader ─────────────────────────────────┐
│ ┌──────────────────────────────── (buddy M) ┐ │
│ │      ((( )))                               │ │
│ │   Hold a pass near the reader.             │ │
│ └────────────────────────────────────────────┘ │
│ ◌ Listening…                                   │
│                                      [Close]   │
└────────────────────────────────────────────────┘
```

**Panel:**
- A focusable panel (`tabIndex=0`, `role="group"`, `aria-label="Reader input"`), auto-focused. It captures keystrokes
  with the wedge rules from R §5.8.4: reset on a gap over 80 ms; accept on Enter or Tab at 4+ characters with a mean gap
  under 50 ms.
- The keystroke buffer logic is the same module `/scan` uses (`src/web/scan/wedge.ts`). Import it, don't copy it.

**Focus lost:** the panel dims to .6 and reads **Click here to listen** (R crit 10 "focus lost").

**Buddy:** M seated on the panel's top edge. A new **catch** scene, shared with `/scan`'s NFC prompt (n8b "NFC tap
prompt"):
- while listening, it holds its pocket out with two soft rings;
- the rings are a pending indicator and so may loop while listening (MO "Only things that carry pending state loop");
- on a read it catches the pass (happy).

**Results** replace the status line. They are `role="status"`, and the buddy's mood follows:

| Result | Line | Detail |
| --- | --- | --- |
| Pass found | **Read a pass.** (success icon) | `PassCard` still (64 px) and "Anna Meyer · Northwind membership" as a link |
| No pass | **The reader works. No pass here has this code.** | The buddy peeks and shrugs (`peek`) |
| Nothing in 20 s | **Nothing read yet.** | **Check the reader is plugged in and set to keyboard mode. If the phone showed a tap but nothing came, the reader's key doesn't match.** (R crit 7: VTAP fails silently) |

- `POST /api/v1/identities/{id}/nfc/test { message }` resolves across the identity's orgs. Only platform admins reach
  it. The message is never logged.
- Reduced motion: no rings and no scene; neutral, then happy or sad.

---

## 13. Holder-facing touches: what and why

**Constraints:**
- n7 allows 3 notifying updates per pass per rolling 24 h, and every source counts, scans included (PM §5).
- iOS 27 penalises issuers that push without change (next-wave n7).
- Each publish is one R2 put and about 6 D1 writes (PM §5).
- A check-in that changes no field costs **zero** publishes and one insert (MD §5).

| Touch | Decision | Why |
| --- | --- | --- |
| "Checked in 18:02" on the Wallet pass | **Off by default.** Opt-in per action (**Record the time on the pass**), always silent | A door of 500 would become 500 publishes and pushes in 30 minutes, on the single D1 writer, for a fact the holder already knows: they are standing there. Silent keeps the budget whole |
| Stamp or points value on the pass | **Always updates** (it is a field), **silent by default** | The number is the product. A lock-screen "Stamp added" costs 1 of 3 daily slots, which an org's broadcasts need more. The holder sees the new count in Wallet at once either way. Opt-in **Notify the holder**, with the over-budget fallback |
| Use up (coupon) | Voids the pass and publishes **silently** | Wallet shows it greyed. The holder is at the till |
| Portal pass detail (signed in) | **Yes.** A meta item in the portal header (`pass-header.tsx` `Meta`): **Checked in Nov 14, 6:02 PM**, or **Last scan Nov 3**. No scanner or staff names | Zero pushes: it is read from the ledger at page load (MD §9 seam a) |
| `/p` public page | **No** | It is a bearer link, often forwarded, and scan times reveal where someone was |
| Email | **Never** | No email per scan |
| Holder buddy moment | **None** | The holder sees nothing in real time. The portal line is not an event |

- The portal line needs `MyPassSchema` (`contracts/me.ts`) to gain `lastScan: { kind: 'checked_in'|'scanned', at } |
  null`. Owner: workstream j (portal), additive.
- **The scan result to staff never mentions push.** `PublishResult.silenced` is shown only in the Sync log (§8.1).

---

## 14. Broadcasts: targeting by scan state

This touches n7's `admin/messages/audience.tsx`, `composer-state.ts`, `shared/contracts/broadcasts.ts` and the
server's target query.

**Contract.** One contract shared by broadcasts and the passes list. `ScanTargetSchema` is defined in
`contracts/scan.ts` and imported by `broadcasts.ts`:

```ts
export const ScanTargetSchema = z.union([
  z.object({ eventId: IdSchema, checkedIn: z.boolean() }),
  z.object({ noScanDays: z.union([z.literal(30), z.literal(90)]) }),
]);
// BroadcastTargetSchema gains: scan: ScanTargetSchema.optional()
```

The server uses one SQL builder, `scanTargetWhere()` in `modules/scan/repo-target.ts`, for both the passes list and
`broadcasts/repo.ts`.

**Audience UI.** A `FormField` **Scans** (Select) after **Holder**:

| Option | Shown when |
| --- | --- |
| **Any** (default) | always |
| **Not checked in · Saturday gala** | for each live or upcoming event, and events ended within 7 days, whose templates overlap the chosen ones (up to 10, soonest first) |
| **Checked in · Saturday gala** | same |
| **No scan in 30 days** | always |
| **No scan in 90 days** | always |

- Help line under the select, only when an option other than Any is picked: **Checked when it sends.**
- That matters for scheduled broadcasts. Example: "Doors close at 8" scheduled for 7:30 PM to **Not checked in**.
- The live count line already updates (`useAudienceCount`).
- Choosing an event option with no overlapping templates is impossible, because the options are filtered.
- Broadcast detail: the target summary adds "Not checked in at Saturday gala".
- A `message` broadcast to not-checked-in holders is the case worth showing in the Messages empty state's examples
  (n7's copy, optional).

---

## 15. Audit

- `audit_log.actor_type` keeps its CHECK. Scanner-originated entries use the existing **`device`** actor:
  - `actor_id` = the scanner ID;
  - `detail.staffId` and `detail.staffName` when a staff member acted;
  - `approvedBy` for overrides.
- This avoids rebuilding a foundation table (PM §2, MA §6).
- `lib/audit labels` renders a `device` actor whose ID is a scanner as **Scanner: Front door**, linking to the scanner.
- The Audit page's Actor filter gains **Scanners**.

| Code | Label | Actor | Target |
| --- | --- | --- | --- |
| `scanner.created` | Scanner created | user | scanner |
| `scanner.updated` | Scanner changed | user | scanner |
| `scanner.pairing_started` | Pairing code made | user | scanner |
| `scanner.paired` | Scanner paired | device | scanner |
| `scanner.pair_refused` | Pairing refused (5+ wrong codes from one network in an hour; one row per hour) | system | — |
| `scanner.revoked` | Scanner revoked | user | scanner |
| `scanner.mode_changed` | Scanner went live / moved to Test mode | user | scanner |
| `staff.created` / `staff.updated` / `staff.disabled` / `staff.enabled` | Staff added / changed / disabled / enabled | user | staff |
| `staff.pin_reset` | PIN reset | user | staff |
| `staff.pin_locked` | PIN locked after 5 tries | device | staff |
| `scan_event.created` / `.updated` / `.archived` | Event created / changed / archived | user | event |
| `scan.override` | Checked in again | device (staff, approvedBy) | pass |
| `scan.undone` | Scan undone | device or user | pass |
| `scan.exported` | Scans exported | user | org |
| `identity.nfc_approved` / `identity.nfc_unapproved` | NFC approved / NFC approval removed | user | identity |
| `vas_key.created` / `.rotated` / `.retired` | Reader key made / rotated / retired | user | identity |

Individual scans are not audit rows. They are `scans` rows and `scan.*` ledger events (PM §3 "Audit").

---

## 16. Copy deck

### 16.1 Status pills (`src/web/lib/status.ts`, additive)

| Key | Label | Tone | Icon |
| --- | --- | --- | --- |
| `online` | Online | success | `Wifi` |
| `offline` | Offline | neutral | `WifiOff` |
| `not_paired` | Not paired | warning | `QrCode` |
| `revoked` | Revoked | neutral | `Ban` (exists) |
| `upcoming` | Upcoming | info | `CalendarClock` |
| `live` | Live | success | `Radio` |
| `ended` | Ended | neutral | `CalendarCheck2` |
| `archived` | Archived | neutral | `Archive` |
| `scan_done` | Done | success | `CircleCheck` |
| `scan_heads_up` | Heads-up | warning | `TriangleAlert` |
| `scan_refused` | Refused | danger | `OctagonX` |
| `scan_undone` | Undone | neutral | `Undo2` |
| `nfc_not_approved` | Not approved | neutral | `Nfc` |
| `nfc_approved` | Approved | info | `Nfc` |
| `nfc_ready` | Ready | success | `Nfc` |
| `role_door` / `role_desk` / `role_manager` | Door / Desk / Manager | neutral | `DoorOpen` / `Store` / `ShieldCheck` |
| `pin_locked` | Locked | warning | `Lock` |

### 16.2 Outcome words (`src/shared/copy/scan.ts`; shared with `/scan`)

These extend R §5.2's refusal table. Admin surfaces use **Detail** as the single line. `/scan` uses **Headline** and
**Sub**.

| Code | Kind | Headline | Sub | Admin detail |
| --- | --- | --- | --- | --- |
| `checked_in` | ok | Checked in | {display title} | Checked in |
| `adjusted` | ok | {+N unit} (e.g. +1 stamp) | 7 of 10 stamps | {Action} · 7 → 8 |
| `used_up` | ok | Redeemed | {display title} | {Action} |
| `set` | ok | {Input} set | Gold | {Action} · Silver → Gold |
| `already` | heads_up | Already checked in | Today 6:02 PM · Front door | Already checked in · first 6:02 PM |
| `already_today` | heads_up | Already checked in today | 9:14 AM · Desk | Already checked in today |
| `too_soon` | heads_up | Scanned 2 min ago | Next {action} in 4 min | Too soon · next in 4 min |
| `already_used` | heads_up | Already redeemed | Nov 3, 2:10 PM · Till 2 | Already redeemed |
| `not_found` | refused | Not found | This code isn't a pass here. | Not found |
| `ambiguous` | refused | More than one match | Look it up by name instead. | More than one match |
| `voided` | refused | Voided | Voided {date}. | Voided |
| `removed` | refused | Removed | {Org} removed this pass. | Removed |
| `expired` | refused | Expired | Ended {date}. | Expired |
| `not_open_yet` | refused | Not open yet | Opens {time}. | Not open yet |
| `event_ended` | refused | Event ended | Closed {time}. | Event ended |
| `wrong_event` | refused | Not for this event | It's for {other event or template}. | Not for this event |
| `template_not_allowed` | refused | Not for this scanner | {Template} passes can't be scanned here. | Not for this scanner |
| `no_balance` | refused | Not enough {unit} | Has {n}, needs {m}. | Not enough {unit} |
| `role_too_low` | refused | Needs a {role} | Ask a {role} to do this. | Needs a {role} |
| `test_pass` | refused | Test pass | Only test scanners accept it. | Test pass |
| `live_pass` | refused | Live pass | Only live scanners accept it. | Live pass |
| `org_inactive` | refused | Scanning paused | {Org} is suspended. | Org suspended |
| `staff_disabled` | refused | Signed out | Ask an admin to turn your access back on. | Staff disabled |
| `scanner_revoked` | refused | Scanner revoked | Ask an admin to pair this device again. | Scanner revoked |
| `server` | refused | Something went wrong | Scan again. Ref {requestId}. | Server error |

A `network` result is never stored. It is `/scan`-only (R §5.2).

### 16.3 Toasts

| Act | Toast |
| --- | --- |
| Scanner settings saved | `Saved` (SaveBar) |
| Revoke | `Scanner revoked` |
| Duplicate | (opens the dialog; no toast) |
| Staff added | (the PIN reveal is the confirmation) |
| PIN reset | (the reveal) |
| Staff disabled | `Sam K. disabled` |
| Event created | (`CreatedCallout`) |
| Event saved | `Saved` |
| Assign scanners | `2 scanners now scan Saturday gala` |
| Archive | `Event archived`, with `toast.undo` (unarchive) |
| Undo scan | `Scan undone` |
| Go live | `Front door is live` + **Leave Test mode** |
| NFC approved | `NFC approved` |
| Key made | (the dialog) |
| Rotate | `Rotation started` |
| Errors | `toast.error(error, 'Could not {pair \| revoke \| save \| undo \| assign \| archive \| rotate}')` |

### 16.4 Error sentences (server problem codes → `lib/errors` map)

| Code | Sentence |
| --- | --- |
| `SCANNER_NAME_TAKEN` | A scanner here already has this name. |
| `PAIRING_EXPIRED` | That code expired. Make a new one. |
| `EVENT_ENDED` | This event has ended. Pick another. |
| `EVENT_WINDOW` | Scanning must close after it opens. |
| `TEMPLATE_NO_CHECK_IN` | {Template} has no check-in action. |
| `SCAN_NOT_UNDOABLE` | This scan can't be undone any more. |
| `VAS_KEY_EXISTS` | This identity already has a reader key. Rotate it instead. |
| `NFC_NOT_APPROVED` | Mark the identity as NFC approved first. |

---

## 17. Buddy moments (admin and platform side)

At most one buddy is in view (`useRegisterBuddy`). A dialog's buddy hides the page's under the scrim. Every buddy sits
on a real bordered surface.

| Where | Size, seat | Mood → scene | Notes |
| --- | --- | --- | --- |
| Scanners / Events / Staff empty | kit `EmptyState` | curious → `inspect` with the new entity art | Existing scene |
| Scans and lists filtered empty | kit | curious → `sweep` | Existing |
| Pairing face, waiting | M on the QR sign (`Scan` component) | neutral → `nudge` (aims its pass at the code like a key card) | Existing scene; n8b pairing |
| Pairing, code expired | same | flat → `beat` (head shake) | Existing click beat, run once |
| Paired | same sign | happy → `hello` (run once on the event) | `hello` is click-only today; allow `run="once"` |
| Test a reader, listening / read / nothing | M on the input panel | neutral → **`catch`** (new, shared with `/scan`) / happy / flat → `peek` | One new scene |
| Event dashboard | S on the hero card's top edge, at end | neutral → `count` on open; happy → `wave` at the first check-in; happy → `cheer` + sparks at everyone in | Once per milestone per browser |
| Scanner detail, staff, NFC card, overview | none | — | Dense surfaces; success toasts wear the face |

- **New scene budget:** only `catch` (about 0.6 kB raw CSS). The `/scan` designer may add more for the staff app. The
  shared registry stays within 8.75 kB gzip, or a raise is requested with a comment (PM §8).
- **The beat API:** `/scan` needs an immediate-start, ≤700 ms beat (PM §8). Admin scenes keep the standard 700 ms
  start, because nothing here is time-critical.

---

## 18. Accessibility and motion checklist

- **Targets.** Controls are 36 px on fine pointers and 44 px on coarse ones. Field text is 16 px on coarse pointers.
  Body text is 14 px (UI "Control heights").
- **Dashboard.**
  - **Pause updates** satisfies 2.2.2 for auto-updating content.
  - One throttled polite region (30 s).
  - The progress bar has `aria-valuetext`.
  - Charts keep **Show data**.
- **Never colour alone.**
  - Results carry an icon shape and a word: check, triangle, octagon-X, undo.
  - Methods carry icons with tooltips.
  - Status dots in By scanner use the pill icon, not a bare circle.
- **Countdown.** Outside the live region. At expiry the status line announces **Code expired.** once.
- **Focus.**
  - Dialogs focus the first field, or for the reader test, the panel.
  - The pairing face focuses its title on the switch to paired, so screen readers hear "Front door is paired".
  - The Undo confirm returns focus to the row's Undo, or to the row when that is gone.
- **Motion.**
  - Transform and opacity only: progress `scaleX`, insert highlight opacity, CountUp text.
  - No layout shift. Skeletons have the final shape: hero 9.5rem, chart 8.25rem, table rows `SkeletonRows`.
  - Reduced motion: no scaleX tween, no scenes, static poses; pending rings keep spinning (`.wl-essential`).
- **Themes.** Both themes from tokens. No hex in components. Tested in light and dark at 1440, 820 and 390 (memory:
  visual-check viewports).
- **Reflow at 200%** on 390: the dashboard grid is already one column; KeyValues stack; the pairing code wraps under
  the QR.

---

## 19. Data the screens need

These are recommendations for the architecture designer; they are the minimum the UI above assumes.

**Migration `0014_scan.sql`.** It must depend on no 0013, 0015 or 0016 objects, and must rebuild no referenced table
(PM §2).
- `scanners (id, org_id, mode, name, accepts 'event'|'templates', event_id NULL, all_templates INT, on_scan
  'first'|'choose', staff_sign_in INT, default_role, token_hash UNIQUE NULL, paired_at, paired_ua, last_seen_at,
  current_staff_id NULL, created_by, created_at, revoked_at)`, UNIQUE `(org_id, mode, name)` where not revoked.
- `scanner_templates (scanner_id, template_id)` PK.
- `scanner_pairings (code_hash PK, scanner_id, expires_at, used_at)`.
- `scan_staff (id, org_id, name, role, pin_hash, pin_set_at, disabled_at, created_at)`.
- `scanning_events (id, org_id, mode, name, match_input NULL, match_value NULL, opens_at, closes_at, time_zone,
  reentry INT, created_at, archived_at)` and `scanning_event_templates`.
- `scans`:
  - columns `(id, org_id, mode, pass_id NULL REFERENCES passes ON DELETE CASCADE, scanner_id NULL, actor_type, actor_id,
    staff_id NULL, approved_by NULL, event_id NULL, action_id, kind, outcome, reason, method, amount, before_val,
    after_val, version, client_ts, at, idempotency_key, undone_at, undoes_scan_id)`;
  - UNIQUE `(scanner_id, idempotency_key)`;
  - indexes `(org_id, mode, at)`, `(scanner_id, at)`, `(staff_id, at)`, `(event_id, at)`, `(pass_id, at)`.
- `scan_claims (claim_key, pass_id, scan_id, at)` PK `(claim_key, pass_id)`. `claim_key` is `event:{id}`,
  `once:{actionId}` or `day:{actionId}:{yyyy-mm-dd}`. It is the race-free first-scan-wins rule (PM §10.12): two gates
  give one winner and one heads-up.
- `vas_keys (id, identity_id REFERENCES signing_identities ON DELETE CASCADE, public_key, fingerprint, created_at,
  retired_at)`, with no private key columns (§12.2).
- **Retention:** `retention.scansDays`, default **396** (13 months, so check-in proof spans a yearly event), minimum
  30. A daily purge sits under `CRON_QUERY_BUDGET`. Ledger `scan.*` rows keep the 90-day ledger rule.

**Admin endpoints** (all `requireAdmin`, org-scoped, list endpoints mode-filtered, tenant-isolation and mode tests per
route):

| Method | Path | For |
| --- | --- | --- |
| GET, POST | `/api/v1/scanners` | §4.1, §4.3 |
| GET, PATCH | `/api/v1/scanners/{id}` | §4.5 |
| POST | `/api/v1/scanners/{id}/pairing` → `{ code, url, expiresAt }` | §4.4 |
| GET | `/api/v1/scanners/{id}/pairing` → `{ state: 'waiting'\|'paired'\|'expired', device? }` | poll |
| POST | `/api/v1/scanners/{id}/revoke`, `/mode { mode }`, `/sample-pass` | §4.5, §10 |
| GET | `/api/v1/scanners/{id}/stats?range=` | Activity, How |
| GET, POST | `/api/v1/scan-staff`; PATCH `/{id}`; POST `/{id}/pin` → `{ pin }` | §5 |
| GET, POST | `/api/v1/scan-events`; GET, PATCH `/{id}`; POST `/{id}/assign { scannerIds }` | §6 |
| GET | `/api/v1/scan-events/{id}/live` | §6.3 |
| GET | `/api/v1/scans?…` (cursor), `/api/v1/scans/{id}`, `/api/v1/scans.csv?…`; POST `/api/v1/scans/{id}/undo` | §7, §8 |
| POST | `/api/v1/identities/{id}/nfc { approved }`, `/vas-keys { publicKey }`, `/vas-keys/rotate { publicKey }`, `/vas-keys/{keyId}/retire`, `/nfc/test { message }` | §12 |

The scan, lookup and heartbeat endpoints for `/scan` itself belong to the `/scan` design. Their outcome contract is
§16.2.

---

## 20. Files and ownership touches

| Area | Files | Owner | Change |
| --- | --- | --- | --- |
| Scanning pages | `src/web/admin/scanning/**`, `src/web/routes/admin/scanning/**` | n8 | new; delete the `admin/scanners` placeholders |
| Nav, entities, status, actions, confirms | `lib/{nav,entities,status,actions,confirms}.ts` | h0 / foundation | additive; **entry-chunk budget raise** |
| New art | `ui/art/{scanner,stub,badge}.tsx`, `scenes/catch.css`, `registry.ts`, `index.ts` | h0 | additive; budget check |
| Shared copy | `src/shared/copy/scan.ts` | n8 | new; used by `/scan` |
| Sync log | `admin/passes/detail/{sync-tab,sync-model,detail-page}.tsx` | n1 / i | additive; the "entries" rename |
| Events contract | `contracts/events.ts` (`scans` group, `scan.heads_up`, `scan.undone`) | n1 | additive |
| Passes list filters | `admin/passes/list-filters.tsx`, `list-columns.tsx`, `contracts/passes.ts` | i | additive |
| Designer | `designer/{section-scan,ops-scan,section-nfc,ops-nfc}.*`, `model.ts`, `outline.tsx` | n5 | additive |
| Manifest | `passkit/types.ts`, `passkit/template/scan.ts` (validator), `manifest.ts` | a2 | additive |
| Starters | `templates/starter-*` | a2 | §11.2 |
| Identities | `admin/identities/{nfc-card,nfc-key-dialog,reader-test-dialog}.tsx`, `identity-cards.tsx` (remove the switch) | n2 | additive |
| Overview | `admin/overview/{kpis,charts-card,live-card}.tsx`, `contracts/metrics.ts`, `modules/metrics/*` | h / g | additive |
| Broadcasts | `admin/messages/{audience,composer-state}.tsx`, `contracts/broadcasts.ts`, `modules/broadcasts/repo.ts` | n7 | additive |
| Portal | `portal/pass-header.tsx`, `contracts/me.ts` | j | additive |
| Audit labels | `admin/audit/labels.ts` | g | additive |
| Migration | `migrations/0014_scan.sql` | n8 (reserved) | new |
| Rate limits | `wrangler.jsonc`, `platform/env.ts`: `RL_SCAN_PAIR` (1010, 10/60 s per IP), `RL_SCAN` (1011, per scanner), `RL_SCAN_ORG` (1012) | foundation via integration | additive |

---

## 21. Open questions for the owner

Only these need the owner. Everything else above is decided.

1. **Entry bundle budget.** The Scanning nav entry plus 3 entity icons need about +0.5 to 0.8 kB on an initial chunk
   with about 5 B of headroom. Approve the raise?
2. **Apple NFC application.** Apply as a platform with a new pass type ID (for example `pass.im.plrs.wallet.nfc`)
   naming the VTAP100, and buy one VTAP100 (GBP 139) to verify:
   - Safari wedge input;
   - the `config.txt` format (§12.2 [U]).

   The UI ships honest "Not approved" states either way.
3. **Counter ownership on connection-bound passes.** The design marks scan-changed inputs `manual`, so a source sync
   never undoes a stamp (PM §3, map gap 18). Confirm the scanner should win over the source system.
4. **Proof retention.** Scans are kept 13 months (`retention.scansDays` 396). Say if venues need longer, or if privacy
   wants shorter.

Not asked, but flagged:
- the "Event" / "entries" rename touches n1 and h0;
- POS / API key scanning (a `scans:write` scope acting as Desk) is deferred to after v1;
- offline queueing is `/scan`'s call. The admin side already reads `client_ts` and shows late-synced scans in place by
  time.
