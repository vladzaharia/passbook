# The desk: scanner UX for loyalty, store cards, coupons and gyms

2026-11-04. Staff at a counter on an iPad or iPhone, often with a Bluetooth barcode scanner or an
NFC (Apple VAS) reader. They look someone up, check who they are, then stamp, add points, set a
balance, redeem or check in.

Sources:
- **R**: `research/scanning/report.md`, cited by section. **R-crit** is its critic's corrections
  at the end, which override the body.
- **PM**: `docs/design/scanner/platform-map.md`. **MA** and **MD** are `map-access.md` and
  `map-domain.md`.
- **ME**, **UC** and **UXP**: `next/docs/design/{motion-and-expression,ui-consistency,ux-principles}.md`.
- **BG**: the brand guide. **n8b**: `scratchpad/n8b-buddy.md`.

Paths are relative to `scratchpad/next` unless noted. **[I]** marks our own inference and **[U]**
marks something unverified.

The door (event tickets, continuous check-in) is designed separately. Section 2 fixes everything
both contexts share, so the door spec should take those names and values as they are.

---

## 0. Decisions at a glance

1. **One app, two postures.** The door and the desk run on the same `/scan` shell, reducer,
   verdict component, sounds, buddy beats, lookup and chips (R §2.2 rule 6, R §5.2). The door
   *auto-applies* one action. The desk *opens a member card* and lets staff choose (scanner mode
   `choose`, R §5.8 item 7).
2. **Green means applied, never found.** Opening a card is neutral. Green, amber and red appear
   only when the server answers an action or refuses the pass (R §2.3 "success before the server
   confirms").
3. **Flood, then settle.** A verdict floods the desk's stage the way the door floods its screen.
   After 1.2 s it shrinks to a 64 px band on the card, and the card stays usable. So the two
   contexts look the same at the moment of truth.
4. **Reversible changes undo, irreversible ones confirm.**
   - A fixed `+1 stamp` or a check-in applies on one tap and offers **Undo** for 10 minutes.
   - `set`, `redeem` and amounts above the action's `confirmAbove` add a review step showing the
     value before and after.

   These defaults follow R §5.8 item 8 and match the market (R §1, "What the market tells us").
5. **Our own keypad for amounts.** A connected Bluetooth scanner or VTAP is a hardware keyboard,
   and iOS hides the on-screen keyboard while one is connected (R-crit 2). Amount fields use
   `inputmode="none"` plus an in-app keypad on every device.
6. **One field for lookup.** "Name, email or code":
   - code: an exact match only;
   - name: 3 characters or more;
   - email: only the full address;
   - at most 10 results, with masked emails;
   - no "load more" (R §4 rules 1-7).

   The field also accepts wedge bursts as scans, so a focused search box never swallows a
   barcode.
7. **Desk inputs.** On an iPad the inputs that are always on are the wedge (barcode or NFC) and
   search. The camera is one tap away, not always on: a tablet on a stand points its camera at
   customers and drains its battery. On iPhone the camera is home, as at the door.
8. **Ready action, the desk's express mode.** Staff arm an action from the card or the menu.
   - A fixed action (`+1 stamp`, **Check in**) stays armed; each scan applies it with the door's
     flood.
   - A variable amount (`+120 points`) is one-shot: type the amount, then scan or hold near.
   - The model is PassKit Batch and PassEntry's amount-first flow (R §1).
9. **Identity first.** The name is the card's heading. The photo shows only when the template
   says its thumbnail is a member photo *and* this pass has its own thumbnail override
   (`contracts/passes.ts:190`). The card never shows an email (R §2.3).
10. **Rights are visible, not hidden.**
    - Actions this scanner can't do sit in **More** with a lock and one sentence.
    - A scanner with lookup rights only shows **View only**.
    - Over-max amounts clamp at the maximum.
    - Manager codes (step-up) come next and are specified here so the UI is ready (section 6.25).
11. **Online only in v1** (R §5.6), honestly so. Nothing that changes a value is ever queued.
    - Every apply carries an idempotency key.
    - A request lost mid-flight becomes **Not confirmed**, and the app resolves it on reconnect
      by replaying the same key. That is not a queue.
12. **Buddy beats ship in the scan chunk.** The registry scene budget has **11 bytes of headroom**:
    the lazy scenes measure 8,949 B gzip against 8,960 B, measured today on `next/integration`.
    Desk and door beats live in `src/web/scan/buddy/beats.css` with their own 3 kB gzip budget
    and timing test. Only `count` (end of shift) reuses a registry scene.
13. **Controls are the admin sizes** (owner direction): 14 px body, 36 px controls, 44 px with
    16 px field text on touch.
    - R §5.3 suggests 56 pt targets. We keep 44 px heights and get the extra reach from width:
      buttons fill their row, keypad keys are at least 96 px wide, with 8 px gaps.

---

## 1. Context

| | iPad at a counter | iPhone in hand |
| --- | --- | --- |
| Typical | Coffee shop, retail till, gym front desk; on a stand facing staff | Pop-up, floor staff, small shop |
| Inputs | Bluetooth or USB HID barcode scanner (wedge); VTAP100 NFC reader as a keyboard (R §3.4, §5.8 item 4); search; camera on demand | Camera first; search; a Bluetooth wedge is possible |
| Orientation | Landscape mostly; portrait on some stands | Portrait (landscape works, no special layout) |
| Pace | 5-40 s per customer: talk, look, act | Same |

**What the desk needs that the door doesn't:**
- a lookup without a pass ("I forgot my phone");
- identity checks;
- value changes with amounts;
- single-use redemption;
- reasons to *talk* rather than wave someone through.

So refusals hold until dismissed (section 2.6), and the card stays on screen while staff talk.

**What the platform gives us** (PM §3, §5):
- `publishPass({ source: 'scan', mutate, notify })` makes increments safe under contention:
  `mutate` re-runs on a fresh row, up to 3 attempts.
- Voiding through `status: 'voided'` redeems a single-use coupon.
- `scan_code` (26 base32 characters) and `barcode_hash` are the lookup keys. Both must be
  filtered by org and mode first (PM §5).
- The ledger gives the last scans (`listPassEvents`, MD line 144).
- `PassCard` draws the preview. It needs a hide-barcode prop (PM §10 item 22) and assets from a
  scanner route, never a download token (PM §5).

---

## 2. Shared with the door (one implementation each)

These names, values and files are the contract between the two specs. The door doc must not fork
them.

### 2.1 Components (`src/web/scan/`)

| Component | Door | Desk |
| --- | --- | --- |
| `ScanShell` | Header, mode band, chips, phone bottom bar | Same header; on iPad it adds the left rail |
| `useScanMachine` (one reducer) | `start → aiming → checking → outcome` | Same states, plus the desk states in 2.3 |
| `ScanVerdict` | Full-bleed flood | Flood over the stage, then the band (2.5) |
| `scanSound` | Tones (2.7) | Same tones; adds `undo` and `reward` |
| `useWedge` | Keystroke buffer (R §5.8 item 4) | Same; also inside the search field (6.18) |
| `ReaderChip`, `CounterChip`, `OfflineChip`, `PendingChip` | Header | Header |
| `LookupField`, `LookupResults`, `MatchPicker` | Bottom sheet on the phone | Left rail on iPad landscape; popover on portrait; sheet on the phone |
| `RecentScans` | Drawer, last 3 | Left rail on iPad landscape; drawer elsewhere |
| `CameraPanel` (`camera_blocked`, `camera_unavailable`) | Replaces the preview | Same panel, in the camera overlay |
| `ScanBuddy` (immediate beat API, 2.8) | On the viewfinder frame | On the stage card |
| `LiveAnnouncer` | Two persistent regions (2.9) | Same |
| Copy | `src/shared/copy/scan.ts` | Same file; desk keys in section 7 |

### 2.2 Shared timing constants (R §5.2, unchanged)

`OK_HOLD` 1200 · `NEXT_SCAN_AFTER_OK` 600 · `REFUSED_HOLD` 3000 · `SAME_CODE_ACCEPTED_IGNORE`
5000 · `SAME_CODE_REFUSED_IGNORE` 30000 · `SPINNER_DELAY` 300 · `LOOKUP_TIMEOUT` 5000 ·
`HINT_AFTER` 4000 · `IDLE_PAUSE` 60000 (ms).

**Desk additions** (`src/web/scan/timing.ts`):

| Constant | Value | Why |
| --- | --- | --- |
| `FLOOD_SETTLE` | 280 ms | Flood shrinks to the band (`--wl-dur-indicator`) |
| `CARD_IDLE_CLEAR` | 60000 ms | A member's name doesn't sit on a counter screen. No touch and no open picker: the card fades (200 ms) to idle. Off with **Hold results until tapped** |
| `UNDO_WINDOW` | 600000 ms | R §5.3: 10 minutes, own device |
| `SEARCH_DEBOUNCE` | 250 ms | |
| `SEARCH_MIN` | 3 characters | R §4 rule 3 |
| `RESULTS_CAP` | 10 | R §4 rule 3 |
| `READER_NO_READ_HINT` | 8000 ms | A VTAP fails silently (R-crit 7), so after 8 s with no read, show a tip |
| `UNSURE_RETRY_WINDOW` | 120000 ms | Replay an unconfirmed apply with the same key while the page is open |
| `BEAT_DELAY` | 150 ms | Scandit's 150 ms (R §1 Scandit, R §5.4): colour and sound first, then the buddy |
| `BEAT_MAX` | 700 ms | n8b "Speed" |

### 2.3 States

The shared names come from R §5.2 (`start`, `aiming`, `hint`, `checking`, `ok`, `heads_up`,
`refused`, `network`, `camera_blocked`, `camera_unavailable`, `reader_ready`, `paused`).

The desk adds:
- `idle`: the desk at rest, iPad only; the phone's rest is `aiming`.
- `member`: the card is open with no action yet.
- `picking`: an amount picker is open.
- `reviewing`: the confirm step.
- `applying`.
- `undoing`.
- `lookup`.
- `multi_match`.
- `armed`: a ready action is waiting for a scan.
- `unsure`: an apply with no answer.
- `revoked`.
- `shift_summary`.

`ok`, `heads_up` and `refused` carry the same payload as the door's `ScanOutcome` (R §5.8
item 6).

```
idle ─scan/tap/search pick─▶ checking ─▶ member ─action─▶ (picking ─▶ reviewing?) ─▶ applying ─▶ ok | heads_up | refused | unsure
  ▲                              │                                                         │
  │                              └─▶ refused (pass-level) | multi_match | network          └─ Undo ─▶ undoing ─▶ undone (member)
  └── CARD_IDLE_CLEAR / Done ◀── member
armed ─scan─▶ checking ─▶ applying ─▶ ok … (the door's path)
```

### 2.4 Verdict tokens (`src/web/scan/verdict.css`, shared)

These are built on existing tokens, so both themes follow (UC Tokens). Contrast was measured on
the brand values.

| Role | Wash | Text and icon on the wash | Dark | Light | Means |
| --- | --- | --- | --- | --- | --- |
| `ok` | `--pk-success` | `--pk-success-on` | 10.6:1 | 5.9:1 | Applied |
| `heads_up` | `--pk-warning` | `--pk-warning-on` | 6.8:1 | 7.0:1 | A real pass that needs a person |
| `refused` | `--pk-danger` | `--pk-danger-on` | 5.7:1 | 6.1:1 | The pass is the problem |
| `system` (slate) | `--pk-text-muted` | `--pk-surface-page` | 6.9:1 | 7.3:1 | Our problem: network, camera, unsure |
| `neutral` | `surface-sunken` | `fg` | per UC | per UC | Found, undone, status line |

- `verdict.test.ts` computes the four pairs from the resolved tokens and fails below 4.5:1.
- Buttons on a wash use the `wash` variant: transparent fill, 1 px border and text in the
  role's `-on` colour, 44 px tall. Never the teal primary on a wash.
- The n6 test band is also amber (`mode-band.tsx`). It keeps its flask icon and its own line,
  and sits above the stage, so a heads-up wash never touches it.

### 2.5 Flood and band (desk geometry)

- **Stage** is the region that shows the card: the right pane on iPad landscape, the area under
  the toolbar on portrait, the card sheet on the phone.
- **Band** is a 64 px slot at the top of the card (56 px on phone), reserved at all times, so
  nothing shifts.
  - With no verdict, the slot is the neutral **status line**: `Active · Valid until Dec 31,
    2026`.
- **Flood**: a layer absolutely positioned over the stage.
  - At t0 it scales `scaleY` 0→1 from the top in 120 ms (`--wl-ease-out`).
  - A centred stack sits on it: 48 px icon, headline in the stat type (30/36, 600), one sub
    line.
  - At `OK_HOLD` it settles: the layer scales to the band's height over `FLOOD_SETTLE`
    (`--wl-ease-move`), while the centred stack fades out (120 ms) and the band's own row fades
    in (160 ms).
  - Transform and opacity only. Text is never scaled: the band row is a separate layer.
- **Which verdicts flood:** `ok` and `system` flood, then settle. `heads_up` and `refused` flood,
  then settle **only on Done or the next scan**: they hold (2.6).
- **Reduced motion:** no scale. The band appears with a 150 ms opacity fade, and the stage behind
  the card takes the role's `-subtle` tint at once for `OK_HOLD`, then clears.

### 2.6 Hold rules by posture

| Outcome | Door, and the desk with a ready action | Desk card (`choose`) |
| --- | --- | --- |
| `ok` | Auto after `OK_HOLD`; next scan after `NEXT_SCAN_AFTER_OK` | Settles to the band; the card stays (Undo lives there) |
| `heads_up` | Holds until tapped or a different code | Holds until **Done** or a different code |
| `refused` | Auto after `REFUSED_HOLD` | Holds until **Done** or the next scan: staff explain it face to face |
| `network` | Holds until tapped | Same |

The **Hold results until tapped** setting (R §5.2) applies to both postures and also turns off
`CARD_IDLE_CLEAR`.

### 2.7 Sound (`scan-sound.ts`, Web Audio, unlocked on the Start tap, R §5.4)

| Tone | Shape | Used by |
| --- | --- | --- |
| `ok` | 1.2 kHz sine, 120 ms, 10 ms attack and release | Applied |
| `reward` | `ok`, then 1.6 kHz for 90 ms, 40 ms gap | Reward ready, milestone |
| `heads_up` | Two 660 Hz, 90 ms, 60 ms apart | Already used, cooldown, stale |
| `refused` | Two 220 Hz triangle, 140 ms, 80 ms apart | Refusals |
| `system` | 523 Hz then 392 Hz, 100 ms each | No connection, not confirmed |
| `undo` | 880 Hz, 40 ms, quiet (-12 dB) | Undone |
| `read` | 2 kHz, 25 ms, quiet (-18 dB) | A wedge, NFC or camera read registered, before the answer |

- Sound is on by default and remembered per device (`localStorage` `passbook-scan-sound`). The
  toggle is in the header menu, plus a bottom-bar button on the phone.
- No sound for found or member: only answers make noise.
- No haptics promised on iPhone (R §5.4).

### 2.8 Buddy beats (shared engine, desk use in 5.3)

- **API.** `<ScanBuddy beat={name} beatKey={n} mood={m} />`, in the scan chunk. It wraps `Buddy`
  and adds a sibling `<svg>` of scan props (hidden at rest; ≤16 nodes) in the same viewBox.
  - A new `beatKey` restarts at once: the attribute is removed, styles flush, then it is set
    again. This skips `useScene`'s 700 ms landing wait (PM §8, gap 29).
  - A new beat cuts the old one off cleanly (n8b "Speed").
- **Rules:**
  - one buddy in view (`useRegisterBuddy`);
  - seated on a real edge (ME The buddy);
  - transform and opacity only;
  - each result beat lasts ≤700 ms and starts `BEAT_DELAY` after the verdict;
  - only `rummage` and `rings` loop, and only while pending (ME "No ambient loops");
  - idle gets one blink, then stillness (WCAG 2.2.2);
  - reduced motion swaps the pose at once.
- **Budget.** `src/web/scan/buddy/beats.css` ≤3 kB gzip, plus props ≤16 SVG nodes. The test
  `beats.test.ts` checks the size, that each beat is ≤700 ms (loops excepted) and that each ends
  on the rest pose.
- **Signal.** Colour, icon and words carry the result. The buddy is decorative (`aria-hidden`).

### 2.9 Announcements (`LiveAnnouncer`, shared)

- Two regions mount with the shell and stay in the DOM: `role="status"` (polite) and
  `role="alert"` (assertive). Text is set 50 ms after clearing, so a repeat is announced again.
- `alert` is for refusals and `system` only (R §5.3, WCAG 4.1.3). Everything else uses `status`.
- **Focus never jumps on a scan.** It moves only:
  - into an opened picker (the field marked `data-autofocus`);
  - to **Done** on `heads_up`;
  - to the card heading (`h2`, `tabindex=-1`) when a member is picked from search.
- The camera preview is `aria-hidden` (R §5.8 item 17).

---

## 3. What the desk needs from data

### 3.1 Template `scan` block (extends R §5.8 item 8; validator beside `template/messaging.ts`, PM §3)

```jsonc
"scan": {
  "actions": [
    { "id": "stamp",  "label": "Add stamp",     "kind": "increment", "input": "stamps", "amount": 1,
      "max": 5, "repeat": "cooldown", "cooldownSeconds": 600, "express": true },
    { "id": "points", "label": "Add points",    "kind": "increment", "input": "points",
      "amount": "choose", "presets": [50, 100, 200], "max": 1000, "confirmAbove": 500 },
    { "id": "reward", "label": "Redeem reward", "kind": "redeem", "input": "stamps", "cost": 10,
      "rewardLabel": "Free coffee" },
    { "id": "setbal", "label": "Set balance",   "kind": "set", "input": "points" },
    { "id": "visit",  "label": "Check in",      "kind": "check_in", "repeat": "cooldown", "cooldownSeconds": 3600 }
  ],
  "values":   [{ "input": "stamps", "label": "stamps", "goal": 10 }, { "input": "points", "label": "points" }],
  "identity": { "photo": "thumbnail", "fields": ["tier"] },
  "flags":    [{ "input": "status", "equals": ["Payment due", "Frozen"], "tone": "warning" }]
}
```

| Key | Desk behaviour | Default |
| --- | --- | --- |
| `amount` | A number: a fixed step. `"choose"`: the picker opens | `1` for `increment` |
| `max`, `min` | The picker clamps; the server enforces | `max` 100 for counts, none for `set` |
| `presets` | Chips above the keypad | none |
| `confirm` | Forces the review step | `true` for `set` and `redeem`, else `false` (R §5.8 item 8) |
| `confirmAbove` | Review when amount > n | none |
| `cost`, `rewardLabel` | `redeem` with an `input` burns `cost` per reward; without an `input` it voids a single-use pass | — |
| `repeat`, `cooldownSeconds`, `allowOverride` | Heads-up copy and the server's atomic check (R §5.8 items 8 and 11) | `never` for `check_in` and `redeem`; `cooldown` for `increment` |
| `express` | Can be armed as a ready action | `true` for `check_in` and fixed `increment`; `true` (one-shot) for `choose` increments; `false` for `redeem`; never for `set` |
| `notify` | Passed to `publishPass`. Default `false` so counters never burn n7's 3-per-24 h budget (PM §5 n7) | `false` |
| `values[].goal` | Draws "7 of 10" and the stamp dots | none: shows the number |
| `identity.photo` | Shows a photo only if the pass has a per-pass `thumbnail` override | none |
| `identity.fields` | Up to 2 inputs shown under the name (tier, home club) | `[]` |
| `flags` | Chips on the card (amber or neutral). They never block | `[]` |

The designer section (`section-scan.tsx`, PM §3) edits this. When a `notify: true` action sits
on a field with a `changeMessage`, the designer warns about the push budget. The desk itself
never mentions the budget.

### 3.2 What the endpoints must return (UX contract; the scan module design owns the shape)

- `POST /api/v1/scan/resolve { code | passId, method, clientTs }` returns either
  `{ kind: 'member', card }` or a `ScanOutcome` (`refused`, `heads_up` for an ambiguous code).
- `POST /api/v1/scan/apply { passId, actionId, amount?, value?, count?, expectedVersion,
  idempotencyKey, clientTs, method }` returns a `ScanOutcome` with `card` (the fresh card).
  - `expectedVersion` matters only for `set`: a mismatch is `heads_up` `stale`, never a silent
    overwrite.
  - Increments re-run on a fresh row (PM §3).
- `POST /api/v1/scan/{scanId}/undo { idempotencyKey }` returns a `ScanOutcome` (R §5.8 item 10).
- `GET /api/v1/scan/lookup?q=` returns `{ results: MemberRow[≤10], capped }` (R §5.8 item 5).

`card` holds:
- `passId`, `version`, `title`, `subtitle`;
- `template { id, name, style }`;
- `status`, which takes one of the values `active | voided | expired | removed | test`;
- `validFrom?`, `validTo?`;
- `photoUrl?`, from the scanner asset route (PM §10 item 22);
- `identityFields[]`;
- `flags[]`;
- `values[] { input, label, value, goal?, format, currency? }`;
- `actions[]`:
  - `{ id, label, kind, allowed, lock: null | 'right' | 'view_only', amount, min, max, presets,
    confirm, confirmAbove, cost, rewardLabel, cooldownRemainingMs, express }`;
- `lastScans[≤3] { scanId, at, actionLabel, delta?, scannerName, undoable }`;
- `bundle? { name, count }`;
- `passView`, for `PassCard` with the barcode hidden.

**Never** an email, a phone number or a download token.

`MemberRow` holds `passId`, `title`, `subtitle`, `templateName`, `status`, `maskedEmail?`,
`photoUrl?` and `lastScanAt?`.

---

## 4. Layouts

All three share the header. The left rail and the toolbar move by width.

### 4.1 Header (`ScanShell`, 56 px, sticky, page surface, `px-safe`, top inset)

```
[◐ Front till · Northwind Coffee]      [Ready: +1 stamp ×] [▣ Reader ready] [Today 42] [⋯]
────────────────────── Test mode · Nothing here reaches holders. ───────────────────────  (n6 band, test scanners only)
```

- **Left:** the org's icon at 24 px, then the scanner name (`text-sm font-semibold`) and the org
  name (`text-xs fg-muted`). The PassBook wordmark is hidden: the desk is the org's place, as on
  `/p` (UC "Org first").
- **Right chips** (`min-h-6 text-xs`, 44 px hit area on touch):
  - **Armed:** `Ready: +1 stamp`, with an × to clear it. In the teal `accent-subtle`, because it
    is a selection.
  - **Reader:** see 6.21.
  - **Counter:** `Today 42` (R §5.5).
  - **Offline:** `Offline` in slate, replacing the counter.
- **⋯ menu:**
  - Hold results until tapped (switch);
  - Sound (switch);
  - Camera (iPad only), which opens the overlay;
  - End shift;
  - Help: Reader tips.

### 4.2 iPad landscape (width ≥1024 and landscape; 1180×820 reference, 1024×768 minimum)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ header 56                                                                                │
├───────────────────────────┬──────────────────────────────────────────────────────────────┤
│ RAIL 360                  │ STAGE (flex, p-6, 72 px seat room above the card)            │
│ [🔍 Name, email or code ] │                                     (buddy M seated, end) ▾  │
│                           │ ┌──────────────────────────────────────────────────────────┐ │
│ Today · 42 scans ·        │ │ BAND 64: Active · Valid until Dec 31, 2026        [Undo] │ │
│ 31 stamps · 4 rewards     │ ├──────────────────────────────────────────────────────────┤ │
│ ───────────────────────── │ │ [photo 96] Anna Meyer            h2 24/32       ┌──────┐ │ │
│ 12:41  Anna Meyer   Undo  │ │            Gold · Coffee card    meta           │ pass │ │ │
│        +1 stamp           │ │            [Active] [Payment due]               │ 200w │ │ │
│ 12:38  Ben Ortiz          │ │                                                 └──────┘ │ │
│        Redeemed 20% off   │ │ 7 of 10 stamps        ●●●●●●●○○○      1,240 points       │ │
│ …                         │ ├──────────────────────────────────────────────────────────┤ │
│                           │ │ [ Add stamp ] [ Add points ] [ Redeem reward ] [ More ▾ ]│ │
│                           │ ├──────────────────────────────────────────────────────────┤ │
│ [📷 Camera]               │ │ Last scans  Today, 12:41 PM · +1 stamp · Front till      │ │
│                           │ └──────────────────────────────────────────────────────────┘ │
└───────────────────────────┴──────────────────────────────────────────────────────────────┘
```

- **Rail:** `surface-raised`, a border on the right. Its contents, top to bottom:
  - the search field (44 px, 16 px text);
  - the session line (`text-xs fg-muted`);
  - `RecentScans` (`ListRow`s), or search results while the field has text;
  - the **Camera** button (outline, `Camera` icon), pinned at the bottom with `pb-safe`.
- **Stage:**
  - `surface-page`, `p-6`, with 72 px of top room for the seated buddy (11/12 of 72, BG "The
    buddy").
  - One `Card` (`CARD_SURFACE`, radius 10), up to 760 px wide and centred.
  - The card's rows, top to bottom:
    1. band, 64;
    2. identity, at least 120;
    3. values, 72;
    4. actions, 44 plus `p-4`;
    5. last scans, up to 3 rows.
  - Rows 4-5 are the **action drawer's** footprint (6.7).
  - The pass preview is `PassCard still` at 200 px wide with the barcode hidden, inside the
    identity row at the right.

### 4.3 iPad portrait (640-1023 wide, or any iPad in portrait; 820×1180 reference)

```
┌──────────────────────────────────────────────┐
│ header 56                                    │
│ [🔍 Name, email or code      ] [📷] [🕘 12]  │  toolbar 60: field flex, Camera, Last scans (count)
├──────────────────────────────────────────────┤
│ STAGE (p-6)                       buddy ▾    │
│ ┌──────────────────────────────────────────┐ │
│ │ BAND 64                                  │ │
│ │ [photo 96] Anna Meyer         ┌───────┐  │ │
│ │ Gold · Coffee card            │ pass  │  │ │
│ │ [Active]                      │ 160w  │  │ │
│ │ 7 of 10 stamps  ●●●●●●●○○○    └───────┘  │ │
│ │ [ Add stamp ] [ Add points ] [ More ▾ ]  │ │
│ │ Last scans …                             │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- Search results open as a popover under the field: same width, `surface-overlay`, at most 10
  rows, `max-h: 60dvh`, internal scroll, 200 ms in.
- **Last scans** (`History` icon plus a count) opens `RecentScans` in a right sheet (`w-96`).
- Actions: two visible, the rest in **More**.

### 4.4 Phone (<640; 390×844 reference)

```
 camera home (shared with the door)            card sheet (after a scan or a pick)
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ header 56                    │              │ ✕                    buddy S │  sheet handle row 44
│ ┌──────────────────────────┐ │              │ BAND 56  Active · until Dec 31│
│ │   viewfinder (buddy on   │ │              │ [photo 64] Anna Meyer  20/28 │
│ │   the frame's top edge)  │ │              │            Gold · [Active]   │
│ │     Point at a pass code │ │              │ [▭ 64 still]  Show pass      │
│ └──────────────────────────┘ │              │ 7 of 10 stamps ●●●●●●●○○○    │
│ [Ready: +1 stamp ×]          │              │ 1,240 points                 │
│ [🔍 Search] [⇆] [🔊]         │  bottom bar  │ Last scans …                 │
└──────────────────────────────┘              │──────────────────────────────│
                                              │ [ Add stamp            ]     │  sticky, primary on top
                                              │ [ Add points ] [ More ▾ ]    │  44 each, pb-safe
                                              └──────────────────────────────┘
```

- The card is a full-height sheet (`role="dialog"`, `aria-modal`, labelled by the name). It
  slides up 260 ms over the paused camera. ✕ or a swipe down closes it and resumes the camera.
- Name: 20/28 semibold (`text-xl`), two lines at most. The identity row stacks below 360 px.
- Pass preview: the compact row (UC Layout: a 64 px still plus `Show pass`, which opens the
  stage in a sheet).
- Actions: a sticky bar with the primary full width on top and the second action plus **More**
  below it (UC "actions stacked with the primary on top").
- The buddy is S (64×48), seated on the sheet's top edge at the end. The viewfinder's buddy hides
  under the sheet's scrim (ME "An open dialog's buddy hides the page's").
- The bottom bar on the camera: **Search** (opens the lookup sheet, full height), **Switch
  camera**, **Sound**. On the camera: torch when `getCapabilities().torch` (R-crit 1).

### 4.5 Breakpoints and reflow

| Width | Layout |
| --- | --- |
| ≥1024 and landscape | Rail plus stage |
| 640-1023, or portrait iPad | Toolbar plus stage |
| <640 | Camera home plus card sheet |
| 200 % zoom on 390 | Card rows stack; identity fields wrap; the pass preview drops to the compact row; actions stack full width; no horizontal scroll (UC Layout) |

Desktop browsers get the iPad landscape layout (a wedge at a laptop till works the same).

---

## 5. Feedback system for the desk

### 5.1 The stack per outcome (order of arrival)

| t (ms from response) | Channel |
| --- | --- |
| 0 | Wash (flood or band), icon, headline and sub; `ok` also starts the value CountUp |
| 0 | Sound |
| 0 | Live region text |
| 150 | Buddy beat (≤700 ms) |
| 200-800 | Pass preview mint (`ok` with a value change) or void settle (`redeem` of a single-use pass): ME Signature 2 and 3 |
| 1200 | Flood settles to the band (`ok`, `system`) |

### 5.2 Icons (Lucide, 48 px in the flood, 20 px in the band, `aria-hidden`)

| Verdict | Icon |
| --- | --- |
| ok | `CircleCheck` |
| ok, reward ready | `Gift` |
| heads_up, already used | `TriangleAlert` |
| heads_up, cooldown | `Clock` |
| heads_up, stale | `RefreshCw` (static) |
| refused | `OctagonX` |
| system, no connection | `CloudOff` |
| system, not confirmed | `CloudAlert` |
| neutral, undone | `Undo2` |
| locked action | `Lock` |
| view only | `Eye` |

Method icons in last scans: `ScanLine` (camera), `ScanBarcode` (wedge), `Nfc`, `Keyboard`
(manual or search).

### 5.3 Buddy beats on the desk (props in the scan props layer)

| Beat | Moment | Mood | Motion (ms from start) | Reuse or new |
| --- | --- | --- | --- | --- |
| `blink` | Idle, once at 2.4 s | Neutral | Blink 140 | Existing idle |
| `glance` | Card opens | Neutral | Eyes widen 1.15 (0-100), look toward the name (100-300), back (450-600) | New, eyes only |
| `rummage` | Checking >300 ms | Neutral | Passes dip into the pocket one by one, 900 ms cycle; loops while pending | Riffle pattern |
| `stamp` | `+N stamps` | Happy | Crouch (0-100); the gold pass slams onto the card edge with `--wl-ease-bounce` at 250; a ring puff (2 arcs, scale .6→1.2, fade) 250-450; back up by 600 | New prop: puff |
| `sparkle` | `+N points`, balance up | Happy | Three foil sparks (2×6) drop into the pocket 0-450, 60 ms apart; pocket squash 1.06×.94 at 480; settled 650 | New prop: 3 sparks |
| `punch` | `Redeemed` | Happy | Violet pass rises (0-200); a hole pops on it (scale 0→1, 120 ms at 260); wink 450-600 | New prop: hole |
| `hop` | `Checked in` | Happy | Hop 6 units with the gold pass up like a thumb (0-500), down by 650 | Short cheer |
| `fan` | Reward ready; milestone | Happy | Fan spreads ±24°, hop (0-560); `Celebrate` sparks (ME Signature 9) once per pass per reward | `Celebrate` plus a short count |
| `nod` | `Balance set` | Neutral | Squash 1.04×.96 and blink (0-300) | New, tiny |
| `rewind` | `Undone` | Flat | Top pass pops up 6 units and drops back (0-400) | New |
| `wrist` | Heads-up: already used, cooldown, stale | Curious | Brow up; teal pass taps the pocket's side twice (0-600) | New |
| `droop` | Refused `expired` | Sad | Gold pass greys and droops 18° (0-300 spring) | Existing expired pose |
| `tear` | Refused `voided`, `removed` | Sad | One tear rolls (0-600) | Existing TEAR drop |
| `shrug` | Refused `not_found`, `template_not_allowed` | Sad | Lens up (0-200), shrug, outer passes out (300-650) | Peek and sweep poses |
| `sign` | Refused `test_pass`, `live_pass` | Flat | Holds up a small sign with a drawn flask, no text (BG: no text in art) (0-400) | New prop: sign plus flask, 5 nodes |
| `empty` | Refused `no_balance` | Flat | Pocket jiggles ±2° twice, passes sink 3 units (0-500) | New |
| `tug` | Refused `forbidden`; a locked action tapped | Sad | One tug on the lock (0-600) | Tug pose |
| `plug` | System `network`, `unsure` | Sad | Plug pops out and drops (0-500) | Plug pose |
| `rings` | Armed and waiting for a tap | Neutral | Holds the teal pass out toward the reader's side; two soft rings (scale .6→1.4, fade), 900 ms cycle; loops while armed | New prop: 2 rings |
| `catch` | NFC read | Neutral | The pass snaps into the pocket (0-200); the result beat follows | New |
| `cover` | Camera blocked | Sad | Covers its eyes with the outer passes (0-400), then looks toward **Search** (400-650) | New |
| `sleep` | `paused` | Neutral | Eyes closed (static pose) | Pose |
| `count` | Shift summary | Happy | The existing `count` scene (2.2 s; not a result beat) | Registry |

**Where the buddy sits:**
- On iPad, one buddy, M (96×72), seated `at="end"` on the stage card's top edge. The idle panel
  and the member card share that slot, so a change of state never moves it (the My passes rule,
  ME).
- On the phone, S on the card sheet. While the sheet is closed, it sits on the viewfinder frame.

**Search focus:** while the search field has focus, the buddy's eyes look toward the rail and
follow the caret horizontally (±1.5 px), as on sign-in (ME Signature 8). They come back on blur
or after 1.5 s.

### 5.4 Reduced motion

- No flood scale, CountUp, mint, drawer slide or beat.
- The band fades in (150 ms); the stage tint snaps on and clears after `OK_HOLD`; values show at
  once; the drawer fades (150 ms).
- The buddy swaps to the beat's final pose.
- `rummage` and `rings` become static poses. The loading meaning stays: a `.wl-essential`
  spinner in the band shows during checking.

---

## 6. States

Each state lists:
- **When**: the trigger.
- **Layout**: by device.
- **Copy**: exact strings, with headline and sub.
- **Colour**.
- **Timing**.
- **Stack**: colour, icon, sound, buddy.
- **A11y**: announcement and focus.

Copy keys are in section 7.

### 6.1 Start (`start`)

- **When:** first load of a paired device, or after `paused` on iOS when the audio context is
  suspended.
- **Layout:**
  - iPad: the stage shows the idle card with one primary button.
  - Phone: the door's start screen.
- **Copy:** button **Start scanning**. Nothing else. The scanner name is in the header.
- **Why the tap:** it unlocks the AudioContext and the wake lock, and on the phone it starts the
  camera (R §5.8 item 2). On iPad it doesn't ask for the camera (R §2.3 "Asking for the camera
  on page load").
- **Stack:** neutral. Buddy seated, neutral, with one blink.
- **A11y:** focus on the button. Nothing is announced.

### 6.2 Idle (`idle`, iPad)

- **Layout:** the stage card at its member size (no shift when a member opens), showing:
  - **Headline** (`text-base font-semibold`): **Scan a pass**. With a reader seen this session
    (6.21): **Scan a pass or hold it near the reader**.
  - **Sub** (`text-sm fg-muted`): **Or search by name, email or code.**
  - A ghost button **Search** (`Search` icon) focuses the rail field (on portrait, the toolbar
    field).
- **Colour:** neutral card.
- **Timing:** steady. After `IDLE_PAUSE` with the camera overlay open, the overlay closes.
- **Stack:** buddy neutral, one blink at 2.4 s, then still.
- **A11y:** the card is a `region` labelled "Desk". No announcement.

### 6.3 Checking (`checking`)

- **When:** a wedge burst, a camera decode, an NFC message, a typed code or a picked search row.
- **Layout:**
  - The current card (or idle) dims to .6 under a 2 px loading rail on the card's top edge
    (UC Loading).
  - The band shows **Checking…** with a spinner after `SPINNER_DELAY`.
  - On the phone, the viewfinder freezes and the reticle goes solid (R §2.1).
- **Copy:** **Checking…**
- **Timing:**
  - the `read` tick at once;
  - the spinner, and `rummage` after 300 ms;
  - at `LOOKUP_TIMEOUT`, the `network` state (6.24).
- **A11y:** `status` "Checking." only after 300 ms, so fast answers aren't double-announced.

### 6.4 Member card (`member`)

- **When:** `resolve` returns a member. This is the desk's main surface.
- **Hierarchy, top to bottom:**
  1. **Band**, neutral status line: `{Status} · Valid until {date}`, or `{Status}` with no end
     date. For a coupon: `Active · Use by {date}`.
  2. **Identity:**
     - the photo (96 px, radius 10, `object-cover`), or nothing when the template has no photo
       role (6.5);
     - the name (`h2`, 24/32 semibold, two lines then an ellipsis);
     - meta: `{identity field values} · {template name}` (`text-sm fg-muted`), for example
       `Gold · Coffee card`;
     - pills: the status (UC Status pills: `Active` success, `Voided`, `Expired` and `Removed`
       neutral, `Test` warning), then flags (`Payment due` warning);
     - with a bundle: `In Family pack (3)` (`text-xs fg-muted`, `Ticket` icon).
  3. **Pass preview:** `PassCard still`, barcode hidden, so staff can't scan the staff screen
     (MD line 253).
  4. **Values:**
     - per value, `CountUp` in the stat type: **7 of 10 stamps**, **1,240 points**, **$24.50**
       (the currency from the input; `balance` uses the field's number style);
     - with a `goal` ≤20, a dot row: filled dots at 12 px in teal, empty ones as 12 px outline
       dots in `border-strong`, wrapping at 10;
     - with a goal above 20, a 6 px progress bar instead.
  5. **Actions:** the template's allowed actions in manifest order. The first is primary (teal);
     the next two are outline; the rest go in **More**. Locked actions always go in **More**
     (6.25). A disabled action carries a reason line under the row (`text-xs fg-muted`): for
     example **Not enough stamps to redeem.** when stamps < `cost`.
  6. **Last scans:** up to 3 rows `{Today, 12:41 PM} · {+1 stamp} · {Front till}` with a method
     icon, plus **Undo** (ghost `sm`) when `undoable`. Empty: **No scans yet.**
- **Done:**
  - iPad: an `X` icon button in the band's trailing slot (label "Close") returns to idle.
  - Phone: ✕ at the top of the sheet.
- **Copy:** dynamic values plus the strings above.
- **Colour:** neutral. No wash.
- **Timing:**
  - the card enters with an 8 px rise and fade (200 ms);
  - the next member replaces it with a crossfade (160 ms, the version-crossfade rule);
  - `CARD_IDLE_CLEAR` returns to idle after 60 s untouched.
- **Stack:** no sound; the buddy does `glance`.
- **A11y:**
  - `status`: "{Name}. {Template}. {7 of 10 stamps}." Flags are appended: "Payment due."
  - Focus stays put, except after a search pick (heading).
- **Same code again while open:** ignored. A chip **Already open** floats over the band for 1.2 s
  (opacity), the door's "Scanned just now" (R §2.1).

### 6.5 Identity check

- **Photo** (template `identity.photo` set, override present):
  - On iPad the photo is 96 px. Tapping it opens a 320 px preview in a popover, for a closer
    look. On the phone, 64 px, and a tap opens it full width.
  - Alt text: "Photo of {name}".
- **No photo on file** (`identity.photo` set, no override): an initials avatar (`EntityAvatar`
  style) and a warning flag chip **No photo**. Nothing blocks, but the chip is the cue to check
  ID.
- **No photo role** (coupons, plain store cards): no avatar. The name or offer leads.
- **After a check-in** (`ok` on a gym card): the flood shows the photo at 160 px *above* the
  headline, so identity is the first thing seen. This is the MemberSplash pattern (R §4). The
  band keeps **Undo** if the face doesn't match.
- **A11y:** the photo popover is a dialog with a close button. The flag chip text is in the card
  announcement.

### 6.6 Quick action: fixed increment or check-in, no confirm

- **When:** an action with a numeric `amount`, `confirm: false`, not above `confirmAbove`.
- **Flow:** tap **Add stamp**. The button shows busy (`Button busy`, the verb icon) and the state
  becomes `applying`. Then `ok`.
- No picker, because **Undo** is the safety net (decision 4).

### 6.7 Amount picker: stamps (stepper)

- **When:** an `increment` with `amount: "choose"` on a count with a `goal`, or the **Redeem
  reward** count (6.10).
- **Layout:**
  - iPad: the **action drawer** rises inside the card over rows 4-6, anchored to the card's
    bottom, 260 ms slide (`--wl-ease-out`). The identity and values rows stay visible, so staff
    keep looking at who they're stamping.
  - Phone: a bottom sheet.
- **Contents, top to bottom:**
  1. Title (`OVERLAY_TITLE`): **Add stamps**.
  2. Readout (stat type, `aria-hidden`): **7 → 9** with **of 10 stamps**
     (`text-sm fg-muted`). Dots preview: the new dots in teal at 50 %, filling when committed.
  3. When the new value reaches the goal, a pill **Reward ready** (`Gift`, accent).
  4. Stepper: `−` and `+` icon buttons (44×96) around the value (`text-3xl tabular-nums`,
     `role="spinbutton"`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, label "Stamps to
     add"). Arrow keys and digits work.
  5. Presets, if any: chips **+1 +2 +3** (44 px).
  6. Hint (`text-xs fg-muted`): **Up to 5 per scan.** when `max` is set. `+` disables at `max`.
  7. Footer: **Add 2 stamps** (primary, full width on the phone) and **Cancel** (ghost).
- **Commit label rule:** the verb plus the amount and unit. The singular is **Add 1 stamp**.
- **Timing:** opens in 260 ms; the readout updates at once (no CountUp while editing); Cancel
  closes in 200 ms.
- **A11y:**
  - focus to the stepper;
  - `status` "Picker open. 7 stamps now.";
  - each change is announced by the spinbutton itself;
  - Esc cancels; Enter commits.

### 6.8 Amount picker: points (keypad)

- **When:** an `increment` with `amount: "choose"` on a number without a `goal`.
- **Layout:** the same drawer or sheet.
  1. Title: **Add points**.
  2. Readout: **1,240 → 1,360** with **points**.
  3. Field: `<input inputmode="none" autocomplete="off">` showing the typed amount (16 px on
     touch, `text-3xl` display above it). Hardware digits type into it; the iOS keyboard never
     opens (decision 5).
  4. Presets: **+50 +100 +200** chips. A tap adds to the field.
  5. **Keypad:** 3×4 grid, `1 2 3 / 4 5 6 / 7 8 9 / 00 0 ⌫`. Keys are 44 px tall minimum and
     fill the drawer's width (at least 96 px each), with 8 px gaps. `⌫` is `Delete` with the
     label "Delete"; a long press clears.
  6. Hint: **Up to 1,000 per scan.** When over it, the hint turns `danger` and the commit
     disables.
  7. Footer: **Add 120 points** (primary). When the amount is 0 the button reads **Enter an
     amount**, disabled. **Cancel**.
- **Confirm:** if the amount is above `confirmAbove`, the commit reads **Review** and goes to
  6.11.
- **A11y:**
  - the field is labelled "Points to add", with `aria-describedby` on the hint;
  - keys are buttons with digit labels;
  - the readout is in the field's description: "Balance after: 1,360."

### 6.9 Set balance

- **When:** a `set` action (confirm is always on).
- **Picker:** as 6.8, with these differences:
  - title **Set balance**;
  - the field starts empty, with placeholder `1,240` (the current value; UC: examples are
    placeholders);
  - the readout is **1,240 → 500** with **points · −740**;
  - presets are not allowed.
- **Commit:** **Review**, then 6.11.
- **Stale guard:** `expectedVersion` from the card. If another till changed the pass,
  `heads_up` `stale` (6.16).

### 6.10 Redeem a reward (burns a cost)

- **When:** a `redeem` with an `input` and a `cost`.
- **Single reward available:** skip the picker and go straight to 6.11.
- **Several available** (`floor(value / cost) > 1`):
  - stepper picker, title **Redeem reward**;
  - readout **2 × Free coffee** with **20 → 0 stamps**;
  - commit **Review**.
- **None available:** the action is disabled with the line **Not enough stamps to redeem.** The
  server also refuses (`no_balance`) if the value changed meanwhile.

### 6.11 Review (`reviewing`): the confirm step

- **Layout:** the drawer or sheet's content swaps to the review face (fade and 8 px rise, 200 ms;
  ME "Wizard step"):
  - the name and photo (40 px) at the top, so it's the right person (identity again, as R §5.3
    puts it);
  - the question (`OVERLAY_TITLE`);
  - the before and after (stat type);
  - one consequence line;
  - footer: **{Verb}** (primary) and **Back** (outline).
- **Copy:**

  | Action | Question | Before → after | Line | Commit |
  | --- | --- | --- | --- | --- |
  | Set | **Set to 500 points?** | 1,240 → 500 | **Replaces the current balance.** | **Set balance** |
  | Redeem reward | **Redeem 1 Free coffee?** | 10 → 0 stamps | **Uses 10 stamps.** | **Redeem** |
  | Redeem coupon (single use) | **Redeem 20% off?** | Active → Redeemed | **It can be used once.** | **Redeem** |
  | Large increment | **Add 800 points?** | 1,240 → 2,040 | **More than usual for one scan.** | **Add 800 points** |

- **Colour:** neutral. The commit is teal primary, not danger: these are routine and undoable for
  10 minutes. Danger is kept for blast radius (UXP rule 3).
- **A11y:** focus to the question heading; Enter commits; Esc goes back.

### 6.12 Applying (`applying`)

- The commit button shows busy with the verb icon, keeping its width (UC Buttons).
- The drawer stays.
- Inputs ignore new scans for this pass. A different pass follows 6.27.
- After `SPINNER_DELAY`, the band shows the spinner and **Saving…**.
- At `LOOKUP_TIMEOUT` with no answer: `unsure` (6.24).

### 6.13 Applied (`ok`)

- **Layout:** the drawer closes (200 ms) as the flood starts (2.5). The headline and sub are on
  the flood, then on the band with **Undo** (wash button) at the end. Values count up (600 ms),
  new dots fill with a bounce (300 ms, 60 ms apart), and the pass preview mints.
- **Copy:**

  | Action | Headline | Sub |
  | --- | --- | --- |
  | Fixed or chosen stamps | **+2 stamps** (**+1 stamp**) | **9 of 10 stamps** |
  | Points | **+120 points** | **1,360 points** |
  | Store balance up or down | **+$5.00** / **−$5.00** | **$29.50 balance** |
  | Check-in | **Checked in** | **{Name}** |
  | Set | **Balance set** | **500 points** |
  | Redeem reward | **Redeemed** | **Free coffee · 0 of 10 stamps** |
  | Redeem coupon | **Redeemed** | **{Offer title}** |
  | Goal reached | headline as above, plus the pill **Reward ready** | **10 of 10 stamps** |

- **Colour:** `ok` wash; `Gift` replaces `CircleCheck` when the goal is reached.
- **Timing:** flood 1200 ms, settle 280 ms. The band stays with **Undo** until the card closes. A
  new scan is accepted after `NEXT_SCAN_AFTER_OK`.
- **Stack:**

  | Action | Sound | Beat |
  | --- | --- | --- |
  | Stamps | `ok` | `stamp` |
  | Points, balance | `ok` | `sparkle` |
  | Check-in | `ok` | `hop` |
  | Set | `ok` | `nod` |
  | Redeem (both kinds) | `ok` | `punch` |
  | Goal reached | `reward` | `fan`, with `Celebrate` once per pass per reward |

- **Milestone:** the device's 100th successful action of the day plays `fan` once, with a
  `Celebrate` on the counter chip, with no extra copy (BG: no celebratory copy).
- **A11y:**
  - `status`: "{Headline}. {Name}. {Sub}. Undo available." For example: "Plus 2 stamps. Anna
    Meyer. 9 of 10 stamps. Undo available."
  - Focus returns to the action button that opened the picker. Its row re-renders with the same
    ids, so focus survives.

### 6.14 Undo (`undoing`, then undone)

- **Where:**
  - **Undo** on the band, after an `ok`;
  - **Undo** on a last-scans row while `undoable`: own device, within `UNDO_WINDOW`, and the
    scanner still has that action's right.
- No confirm: undo is itself the safety net. The server writes `scan.undone` and republishes
  (R §5.8 item 10).
- **Undone:**
  - The band turns neutral, with the `Undo2` icon and **{Action label} undone**: **Add stamp
    undone**, **Redeem undone**. The sub is the new value: **7 of 10 stamps**.
  - No flood. Values count down. The pass preview mints (its content changed). A redeemed coupon
    un-voids: the glow returns over 480 ms.
  - Sound `undo`; buddy `rewind`.
  - `status` "Add stamp undone. 7 of 10 stamps."
- **Can't undo:** `heads_up` (amber band, no flood):
  - window passed: **Can't undo** · **Too late to undo here. An admin can fix it.**
  - the pass changed since, for a `set` or a single-use redeem only: **Can't undo** · **The pass
    changed since. An admin can fix it.**
  - Increments always undo safely (a compensating `−n`).
- The row's **Undo** disappears when the window ends; it is checked at render and every 30 s.

### 6.15 Single-use coupon

- **Card:**
  - the offer leads: the template `display_title` (**20% off**) as the `h2`, with meta
    `{Template} · Code ends 4F2K`, the last 4 of the code in mono `xs`;
  - no photo;
  - the band reads **Active · Use by Dec 31, 2026**;
  - one action, **Redeem**, primary.
- **Flow:** **Redeem**, then review (6.11, coupon row), then `ok` **Redeemed** with **Undo** for
  10 minutes. The server voids the pass by CAS (PM §3); the pass preview settles voided (ME
  Signature 3).
- **Armed redeem:** only if the template sets `express: true` on it. Then each scan of an active
  coupon redeems with the door's flood and **Undo**, and no review.
- **Already redeemed** (another till, or earlier): `heads_up` (6.16) with **Undo that redeem**
  only when it was this device within the window. Otherwise just **Done**.
- **Expired, not yet valid:** `refused` (6.17); the card stays under the band.

### 6.16 Heads-up (`heads_up`): a real pass that needs a person

- **Layout:** the flood, then it holds (2.6).
- **Actions:** on the flood, wash buttons; after **Done** they move into the band.
- **Focus:** moves to **Done**.
- **Copy:**

  | Reason | Icon | Headline | Sub | Buttons |
  | --- | --- | --- | --- | --- |
  | `already_checked_in` | `TriangleAlert` | **Already checked in** | **Today, 9:02 AM · Desk iPad** | **Check in again** (if `allowOverride`), **Done** |
  | `already_redeemed` | `TriangleAlert` | **Already redeemed** | **Today, 12:41 PM · Front till** | **Undo that redeem** (own device, in window), **Done** |
  | `cooldown` | `Clock` | **Stamped 2 min ago** (verb from the action: Checked in, Added points) | **Next one in 8 min** | **Done** |
  | `stale` (set) | `RefreshCw` | **Balance changed** | **Now 1,300. Check it and set again.** | **Review** (reopens 6.9 with the new value), **Done** |
  | `ambiguous`, armed only | `TriangleAlert` | **More than one match** | **2 passes share this code.** | **Pick one** (opens 6.19), **Done** |

  Times use "Today, 12:41 PM", "Yesterday, 6:02 PM", else the one formatter (UC Tables: `Oct 30,
  2026, 12:41 PM`). The cooldown headline uses relative minutes, rounded up.

- **Stack:** `heads_up` wash; `heads_up` sound; buddy `wrist`.
- **A11y:** `status` "{Headline}. {Sub}." For example: "Already redeemed. Today, 12:41 PM, Front
  till."
- **Cooldown on the card:** before anyone taps, an action in cooldown shows its remaining time
  under the action row: **Next stamp in 8 min**. The button stays enabled, so a tap gives the
  heads-up explicitly and nothing is hidden.

### 6.17 Refusals (`refused`)

- **Layout:**
  - With a card (the pass is known and in this org): the flood, then it holds on the band. The
    card stays readable underneath, so staff can say *why* (expired membership, with name and
    photo).
  - All actions disable. The band's trailing slot holds **Done**.
  - Without a card (`not_found`, `template_not_allowed`): the flood fills the stage's idle card;
    **Done** returns to idle.
- **Order:** the reason comes first on red, the holder first on green, so the two differ without
  colour (R §5.3).
- **Copy** (R §5.2 table plus desk reasons):

  | Code | Headline | Sub |
  | --- | --- | --- |
  | `not_found` (also another org) | **Not found** | **This code isn't a pass here.** |
  | `voided` | **Voided** | **Voided {Oct 30, 2026}.** |
  | `expired` | **Expired** | **Ended {Oct 31, 2026}.** |
  | `not_yet_valid` | **Not valid yet** | **Starts {Nov 10, 2026}.** |
  | `removed` | **Removed** | **This pass was removed by {Org}.** |
  | `test_pass` | **Test pass** | **Only test scanners accept it.** |
  | `live_pass` (new; symmetric for test scanners, n6) | **Live pass** | **This is a test scanner.** |
  | `template_not_allowed` | **Not for this scanner** | **{Template} passes can't be scanned here.** |
  | `no_balance` | **Not enough {stamps}** | **Has {7}, needs {10}.** |
  | `forbidden` | **Not allowed** | **This scanner can't do that.** |
  | `org_inactive` (new; PM §10 item 11) | **Scanning is paused** | **Ask an admin to resume {Org}.** |
  | `server` | **Something went wrong** | **Try again. Ref {requestId}.** |

  `scanner_revoked` is its own screen (6.25).

- **Stack:**
  - `refused` wash and sound;
  - buddy by reason: `shrug` (not found, not for this scanner), `tear` (voided, removed),
    `droop` (expired, not valid yet), `sign` (test or live), `empty` (no balance), `tug`
    (forbidden), `plug` (server);
  - when the refusal answers a tapped action (`no_balance`, `forbidden`), that button shakes once
    (240 ms; ME Failure).
- **Timing:** holds on the desk. With a ready action, `REFUSED_HOLD`, then back to armed. The same
  code is ignored for `SAME_CODE_REFUSED_IGNORE`; a re-scan shows **Already refused** for 1.2 s.
- **A11y:** `alert` "{Headline}. {Sub}." Focus doesn't move, because the alert reads itself and
  nothing needs a decision. **Done** is the first button in tab order after the band.

### 6.18 Lookup search (`lookup`)

**Field** (`LookupField`):
- The rail on landscape, the toolbar on portrait, a full-height sheet on the phone, with the
  field at the top and `data-autofocus`.
- `type="search"`, `enterkeyhint="search"`, `autocapitalize="off"`, `autocorrect="off"`,
  `spellcheck="false"`, 44 px, 16 px text.
- Placeholder **Name, email or code**; label "Look up a member" (visually hidden; the field is a
  search toolbar per UC Filters). A clear button (×) shows when there's text.

**Interpretation, client side, before calling `lookup`:**
1. **Wedge burst** (mean key gap <50 ms, ≥4 characters, ended by Enter or Tab): it's a scan.
   Clear the field and `resolve` with `method: 'wedge'` (or `'nfc'` for a reader configured as
   VAS). This keeps a Bluetooth scanner working when the field has focus.
2. **Looks like a code:**
   - 26 base32 characters (`scan_code`), or contains no spaces and has digits with length ≥6;
   - on Enter only: `resolve` with `method: 'manual'` (exact match on `scan_code` or
     `barcode_hash`, R §4 rule 2);
   - no live results for codes, so there's no enumeration by typing.
3. **Contains `@`:** wait for a full address (`strictEmail`), then search on Enter or after
   debounce. Exact match only.
4. **Otherwise a name:** live search after `SEARCH_DEBOUNCE` once ≥`SEARCH_MIN` characters.
   Prefix on `display_title` and `display_subtitle` within the scanner's org, mode and allowed
   templates (PM §5).

**States** (the list area under the field):

| State | Shows |
| --- | --- |
| Empty field | `RecentScans` (rail) or nothing (sheet) |
| 1-2 characters | **Type 3 or more letters.** (`text-xs fg-muted`, no request) |
| Partial email | **Type the full email.** |
| Code typed, not submitted | **Press Enter to look up this code.** |
| Searching | After 150 ms, 3 skeleton rows of final height (UC Loading); a refetch dims rows to .6 with a rail |
| Results | `ListRow`s (below) |
| Capped (10) | Footer **Showing 10. Type more to narrow.** |
| No match | Inline empty: lens art S, **No matches**, line **Check the spelling, or scan the pass.** The buddy doesn't move here; the stage buddy owns the view |
| Rate limited (429) | Inline: the hourglass (S), **Too many lookups**, **Try again in {40} s.** A countdown is in the text; the field stays enabled and requests wait |
| Offline | **Lookup needs a connection.** The field is disabled; its placeholder stays |

**Result row** (`ListRow`, 56 px with meta):
- leading: the photo (24 px avatar) or initials;
- title: the name (`fg-strong`), with the status pill (`shrink-0`);
- meta (`text-xs fg-muted`): `{Template} · a•••@g•••.com · Last visit Oct 30`;
- the masking follows R §4 rule 4, done server side (the full email never reaches the device);
- trailing: `ChevronRight`.
- A tap, or Enter on a focused row, runs `resolve` with `passId` and `method: 'manual'`.

**Keyboard:** ↓ from the field moves into the results, ↑ and ↓ move between rows, and Esc clears
then blurs. `/` focuses the field when no field has focus and no wedge burst is in progress.

**After a pick:**
- the card opens;
- the field clears and the rail returns to Last scans (privacy: the result list leaves the
  screen);
- focus goes to the card `h2`.

**A11y:**
- the result count is announced politely: "4 results." or "No matches.";
- the list is `role="listbox"` with the field as `combobox` (`aria-controls`,
  `aria-activedescendant`);
- the hint lines are the field's `aria-describedby`.

**Audit:** `scan.lookup` with the method and result count, never the query (R §4 rule 6).

### 6.19 Multi-match picker (`multi_match`)

- **From search:** the result list *is* the picker (6.18).
- **From a code that matches more than one pass:** `barcode_hash` duplicates such as two cards
  bound to `CARD-0001` (MD line 109).
  - On the desk (choose), open the picker at once. Not a refusal: the passes are genuine and in
    this org.
  - Armed, it is the amber heads-up in 6.16 with **Pick one**.
- **Layout:**
  - iPad: a `md` dialog (512) over the stage.
  - Phone: a bottom sheet.
  - Title **Pick a member**; description **2 passes share this code.**
  - Rows as in 6.18, plus the photo at 40 px, because a photo picks faster than a name.
  - Footer **Cancel**.
- **Cap:** 10 rows. If there are more, the server returns `capped`, and the footer reads
  **Showing 10. Look them up by name instead.**
- **Stack:** sound `heads_up` (the picker is a human decision); buddy `wrist`, hidden under the
  dialog scrim per ME.
- **A11y:** the dialog focuses the first row; `status` "2 matches. Pick a member."

### 6.20 Manual code entry

This is the same field as search (decision 6; R §5.8 item 5 "one field"). It is reached:
- from the rail field or the toolbar;
- from the phone's **Search**;
- from the camera-blocked panel (6.23);
- from the no-read tip (6.21).

- The code is matched case-insensitively. Spaces and dashes are stripped before matching
  `scan_code`; `barcode_hash` takes the exact typed value after trimming (PM §5 "normalise both
  sides").
- **Copy** (no match): `refused` `not_found` (6.17), the same as a camera read. Typed codes that
  miss count double toward the device rate limit (R §4 rule 5); past it, the 429 state.
- **Event:** `method: 'manual'`.

### 6.21 NFC: reader chip, prompt, read

The path is a VTAP or another VAS reader typing into the page as a keyboard (R §3.3, §5.1 "Next").
Until Apple approves the NFC certificate, the chip and prompts only appear for scanners whose
admin set **Has an NFC reader**. Barcode wedges get the same chip as **Scanner ready**.

**Chip states** (header, `ReaderChip`):

| State | Chip | When |
| --- | --- | --- |
| Unknown | `Reader` (neutral, `Nfc` icon) | Configured, no read yet this session |
| Ready | `Reader ready` (success dot) | A read arrived and the page has focus |
| Paused | `Tap to resume reader` (warning) | `blur` or `visibilitychange` hidden: keystrokes would go elsewhere. A tap anywhere refocuses `document.body` |
| Off | none | Not configured and never seen |

**Armed prompt** (`armed`, with a reader configured):
- The idle card's headline becomes **Ready: +120 points**, with the sub **Scan the pass, or ask
  them to hold their iPhone near the reader.**
- Staff-facing copy may say "hold … near"; never "tap" or "NFC" (HIG, R §2.1).
- Button **Cancel** (outline) disarms.
- Buddy `rings`, facing the rail side.

**Read:**
- the `read` tick, `catch`, then `checking` and the result;
- the event carries `method: 'nfc'`;
- the last-scans row shows the `Nfc` icon.

**No read after `READER_NO_READ_HINT`** while armed (VTAP fails silently, R-crit 7), a line
under the prompt:
- **Not reading? Show the barcode, or search by name.**
- **Search** is a ghost button.

**Pass needs Face ID** (`requiresAuthentication`, R §3.1): the reader types nothing on the first
tap. The ⋯ → **Help: Reader tips** sheet lists three lines:
1. **Hold the top of the iPhone near the reader.**
2. **If asked, unlock with Face ID, then hold it near again.**
3. **Still nothing? Scan the barcode instead.**

The sheet is static: no detection is possible.

**A11y:** the chip is a button with a full label ("Reader ready"). Arming announces `status`
"Ready. Plus 120 points. Waiting for a scan."

### 6.22 Ready action (`armed`): the desk's express mode

- **Arm** an action in one of two ways:
  - **More** → **Repeat on every scan** on a card, shown for actions with `express`;
  - for a `choose` amount, the picker's secondary button **Use on next scan** next to the
    commit.
- **Chip:** `Ready: +1 stamp ×` in the header.
  - Fixed actions stay armed until × or **End shift**.
  - Chosen amounts disarm after one apply.
- **On scan:** if the pass's template has that action and it is allowed, it applies at once:
  - the door's flood, then the card under the band with **Undo**;
  - `ok` holds `OK_HOLD`; the card stays, and the next scan replaces it.
- **Otherwise** the card opens as usual, with the line **Ready action doesn't apply to this
  pass.** in the band (`text-xs`).
- **Never armable:** `set` (decision 4). Redeem only with an explicit `express: true`.

### 6.23 Camera at the desk

- **iPad:** **Camera** in the rail (landscape), the toolbar (portrait) or the ⋯ menu.
  - It opens a `lg` dialog (768, or full screen under 768 high) with the shared viewfinder, rear
    camera, `Switch camera`, and the torch when supported.
  - The first decode closes it (120 ms after the read tick: Scandit's 150 ms, R §1) and continues
    in the stage.
  - The buddy for that moment sits on the viewfinder frame; the stage buddy hides under the scrim
    (ME).
  - Auto-closes after `IDLE_PAUSE` with nothing read.
- **Phone:** the camera is home (4.4). After a card closes, the camera resumes (one long-lived
  stream, R §5.8 item 2).
- **Blocked** (`camera_blocked`; R §2.1, §5.2): a panel replaces the preview.
  - **Camera blocked** · **Allow it in Settings › Apps › Safari › Camera.**
  - Buttons: **Search** (primary, opens 6.18; the desk's "Enter code") and **Try again**.
  - Buddy `cover`. `alert` once.
- **Unavailable:** **Camera unavailable** · **Close other apps using it, then try again.** Same
  buttons.
- **Hint** after `HINT_AFTER`: **Move back a little** (shared).

### 6.24 Offline, network, not confirmed

- **Offline** (`useOnline()` false):
  - header `Offline` chip (slate, `CloudOff`), replacing the counter;
  - search disabled (6.18);
  - an open card stays, but every action is disabled, labelled **Waiting for connection** (UC
    Offline, busy look off);
  - the rail's Undo buttons are disabled too;
  - a wedge, camera or NFC read while offline gives `network` immediately, without calling.
  - No full-screen takeover: the app stays put (UXP rule 5).
- **No connection** (`network`: a request fails before sending, or the resolve times out):
  - **No connection** · **Nothing was saved. Scan again.** (R §5.2)
  - slate flood, then the band; sound `system`; buddy `plug`; `alert`; **Done**.
- **Not confirmed** (`unsure`: an *apply* or *undo* was sent and no answer came within
  `LOOKUP_TIMEOUT`):
  - slate band with `CloudAlert`: **Not confirmed** · **Checking again when you're back
    online.**
  - The client retries the same `idempotencyKey` on `online` and every 10 s, until
    `UNSURE_RETRY_WINDOW` (R §5.6: "retried once on reconnect while the page is open"; the
    server dedupes on the key, so a retry never double-applies).
  - Then it becomes the real outcome (`ok` with its flood, or a refusal).
  - After the window: **Still not confirmed** · **Check Last scans before trying again.** The
    action buttons stay disabled for this pass until the card reopens, so a second tap can't
    double-apply under a new key.
  - Sound `system`; buddy `plug`; `alert` "Not confirmed. Checking again when you're back
    online."
- **Never queued:** stamps, points, set and redeem (R §5.6, R §5.8 item 18). The armed state
  survives going offline; scans just answer `network`.

### 6.25 Rights: what staff without the right see

The rights are per scanner, set by an admin (MA 10.6):
- `lookup`;
- `check_in`;
- `increment`;
- `redeem`;
- `set`.

Each comes with the action's `max`. The server enforces them on every call; the card's `actions[].
lock` mirrors them for display.

| Situation | What staff see | Copy |
| --- | --- | --- |
| Action not allowed on this scanner | Not in the row. In **More**, after the allowed items, with a `Lock` icon and meta | Item **Set balance**, meta **Not on this scanner** |
| Locked item tapped | A small sheet (dialog `sm` on iPad, bottom sheet on phone), buddy `tug` on the stage. No danger styling: nothing went wrong | Title **Set balance is off here**; line **Ask an admin to allow it on Front till.**; button **OK** |
| View-only scanner (only `lookup`) | The action row is replaced by one line with the `Eye` icon | **View only. This scanner can't change passes.** |
| Amount above `max` | The stepper's `+` disables; the keypad hint turns danger; commit disabled | **Up to 5 per scan.** |
| Right removed mid-shift | The tap returns `refused` `forbidden` (6.17); the card refreshes and the action moves into **More**, locked | **Not allowed** · **This scanner can't do that.** |
| Undo of a scan this scanner may no longer do | No **Undo** on that row | (none) |
| Scanner revoked | A full stage panel, no header chips; every input stops | **Scanner revoked** · **Ask an admin to pair this device again.** Button **Pair again** (opens pairing) |
| Org suspended | `refused` `org_inactive` on any call; header chip **Paused** (warning) | 6.17 |

- Locked items stay visible because staff then know to ask, instead of thinking the feature is
  missing (PassKit "Not authorized", R §1).
- They sit in **More**, not the row, so the row holds only what works.

**Next (UI specified now, built later): manager code.** The org creates manager codes in
`/admin/scanners` (6 digits, hashed, audited).
- Then a locked item, or an amount over `max`, offers **Use manager code** instead of **OK**.
- Sheet:
  - title **Manager code**;
  - line **To set the balance.** (the action's verb phrase);
  - a 6-digit field (the sign-in code style, `inputmode="none"` plus the keypad, grouped
    `123 456`);
  - **Continue**.
- Wrong code: **Wrong code. 4 tries left.** After 5 tries: **Too many tries. Try again in 5
  min.** (hourglass).
- One code unlocks one action; the event records the manager.
- Until this ships, the sheets above say **OK** only.

### 6.26 Test mode (n6)

- A test scanner shows the n6 band under the header: **Test mode · Nothing here reaches
  holders.** (`mode-band.tsx`)
- A live pass on a test scanner refuses `live_pass`; a test pass on a live scanner refuses
  `test_pass` (6.17). Buddy `sign`.
- Everything else is identical, so staff can rehearse (the Admittee demo ticket, R §1).

### 6.27 Interruptions and edge cases

| Case | Behaviour | Copy |
| --- | --- | --- |
| Same pass scanned while its card is open | Ignored | Chip **Already open** (1.2 s) |
| Same pass within `SAME_CODE_ACCEPTED_IGNORE` after an `ok` | Ignored | Chip **Scanned just now** (shared) |
| Different pass scanned with no picker open | The new card replaces the old one (crossfade); any band with Undo moves to Last scans | (none) |
| Different pass scanned while a picker or review is open | Held. A strip at the top of the drawer, with the `heads_up` sound | **Another pass was scanned.** Buttons **Switch** (discards the amount) and **Keep editing** |
| Scanned during `applying` | Queued in memory (one slot, last wins), handled after the answer | (none) |
| `CARD_IDLE_CLEAR` with **Undo** still possible | The card fades to idle; Undo stays on the Last scans row | (none) |
| Page hidden or backgrounded | `paused`; the camera stops; the reader chip shows paused; buddy `sleep` | **Tap to scan** |
| Holder's pass changed elsewhere while the card is open (another till) | The next apply returns the fresh card; values count to the new number. `set` gets `stale` (6.16) | (none) |
| Pass in a bundle | Meta line on the card; no group actions at the desk | **In Family pack (3)** |

### 6.28 End of shift (`shift_summary`)

- **Open:** ⋯ → **End shift**, on a sheet.
- **Contents:**
  - title **Today on Front till**;
  - stat tiles (`CountUp`): **42 scans**, **31 stamps**, **2,340 points**, **4 rewards**,
    **3 redeemed**, **1 undone** (only the non-zero ones);
  - the buddy plays `count` on the sheet's top edge (the stage buddy hides under the scrim).
- **Buttons:** **Close** and **Clear screen**. **Clear screen** disarms, clears Last scans from
  view (the server keeps them) and returns to `start`.
- **A11y:** `status` "Today: 42 scans, 31 stamps, 4 rewards."

---

## 7. Copy (`src/shared/copy/scan.ts`, desk keys; the shared keys from R §5.2 are unchanged)

```ts
export const DESK_COPY = {
  idle: { title: 'Scan a pass', titleReader: 'Scan a pass or hold it near the reader', sub: 'Or search by name, email or code.', search: 'Search' },
  start: 'Start scanning',
  checking: 'Checking…', saving: 'Saving…',
  status: { valid: '{status} · Valid until {date}', useBy: '{status} · Use by {date}' },
  noScans: 'No scans yet.', lastScans: 'Last scans', alreadyOpen: 'Already open', scannedJustNow: 'Scanned just now',
  noPhoto: 'No photo', inBundle: 'In {name} ({count})', codeEnds: 'Code ends {last4}',
  notEnough: 'Not enough {unit} to redeem.', nextIn: 'Next {noun} in {min} min', viewOnly: 'View only. This scanner can\'t change passes.',
  readyNotApplicable: 'Ready action doesn\'t apply to this pass.',
  picker: {
    addTitle: 'Add {unit}', setTitle: 'Set balance', redeemTitle: 'Redeem reward',
    commitAdd: 'Add {n} {unit}', commitEmpty: 'Enter an amount', review: 'Review', cancel: 'Cancel', back: 'Back',
    max: 'Up to {max} per scan.', rewardReady: 'Reward ready', useOnNext: 'Use on next scan',
    otherScan: 'Another pass was scanned.', switch: 'Switch', keepEditing: 'Keep editing',
  },
  review: {
    set: ['Set to {n} {unit}?', 'Replaces the current balance.', 'Set balance'],
    reward: ['Redeem {count} {reward}?', 'Uses {cost} {unit}.', 'Redeem'],
    coupon: ['Redeem {offer}?', 'It can be used once.', 'Redeem'],
    large: ['Add {n} {unit}?', 'More than usual for one scan.', 'Add {n} {unit}'],
  },
  ok: { add: '+{n} {unit}', checkedIn: 'Checked in', set: 'Balance set', redeemed: 'Redeemed', of: '{v} of {goal} {unit}' },
  undo: 'Undo', undone: '{label} undone', cantUndo: 'Can\'t undo', tooLate: 'Too late to undo here. An admin can fix it.',
  changedSince: 'The pass changed since. An admin can fix it.',
  headsUp: {
    alreadyCheckedIn: 'Already checked in', alreadyRedeemed: 'Already redeemed', cooldown: '{verb} {min} min ago',
    cooldownSub: 'Next one in {min} min', stale: 'Balance changed', staleSub: 'Now {n}. Check it and set again.',
    checkInAgain: 'Check in again', undoThatRedeem: 'Undo that redeem', pickOne: 'Pick one', done: 'Done',
  },
  refused: { liveTitle: 'Live pass', liveSub: 'This is a test scanner.', orgTitle: 'Scanning is paused', orgSub: 'Ask an admin to resume {org}.' },
  lookup: {
    placeholder: 'Name, email or code', label: 'Look up a member', short: 'Type 3 or more letters.', email: 'Type the full email.',
    codeEnter: 'Press Enter to look up this code.', none: 'No matches', noneSub: 'Check the spelling, or scan the pass.',
    capped: 'Showing 10. Type more to narrow.', rate: 'Too many lookups', rateSub: 'Try again in {s} s.', offline: 'Lookup needs a connection.',
    lastVisit: 'Last visit {date}',
  },
  pick: { title: 'Pick a member', shared: '{n} passes share this code.', capped: 'Showing 10. Look them up by name instead.' },
  reader: {
    unknown: 'Reader', ready: 'Reader ready', paused: 'Tap to resume reader', scanner: 'Scanner ready',
    armed: 'Ready: {action}', armedSub: 'Scan the pass, or ask them to hold their iPhone near the reader.',
    noRead: 'Not reading? Show the barcode, or search by name.',
    tips: ['Hold the top of the iPhone near the reader.', 'If asked, unlock with Face ID, then hold it near again.', 'Still nothing? Scan the barcode instead.'],
  },
  offline: 'Offline', waiting: 'Waiting for connection',
  unsure: 'Not confirmed', unsureSub: 'Checking again when you\'re back online.', stillUnsure: 'Still not confirmed', stillUnsureSub: 'Check Last scans before trying again.',
  rights: { notHere: 'Not on this scanner', offTitle: '{action} is off here', offSub: 'Ask an admin to allow it on {scanner}.', ok: 'OK' },
  revoked: ['Scanner revoked', 'Ask an admin to pair this device again.', 'Pair again'],
  shift: { menu: 'End shift', title: 'Today on {scanner}', clear: 'Clear screen', close: 'Close' },
  menu: { hold: 'Hold results until tapped', sound: 'Sound', camera: 'Camera', tips: 'Help: Reader tips', repeat: 'Repeat on every scan' },
} as const;
```

Units come from `values[].label` and are pluralised with `Intl.PluralRules` (`stamp`/`stamps`).
Never write "1 stamps".

---

## 8. Accessibility checklist (WCAG 2.2 AA)

- **1.4.1 Use of colour:** every verdict has a distinct icon, a headline verb and a different
  order: reason first on red, holder first on green (5.2, 6.17).
- **1.4.3 and 1.4.11:** wash pairs ≥5.7:1 in both themes (2.4). Dots and the progress bar use
  `border-strong` for empty states (≥3:1 against raised). A test enforces the wash pairs.
- **1.4.10 Reflow** at 320 CSS px and 200 % zoom: 4.5.
- **2.1.1 Keyboard:** every action, picker, keypad, list and sheet works with a keyboard
  (iPad Magic Keyboard, desktop). The wedge listener ignores slow human typing (mean gap
  ≥50 ms).
- **2.2.1 Timing adjustable:** `CARD_IDLE_CLEAR`, `OK_HOLD` and `REFUSED_HOLD` all turn off with
  **Hold results until tapped**. The undo window is shown, not hidden.
- **2.2.2 Pause, stop, hide:** only pending loops (`rummage`, `rings`, spinners) move after 5 s.
- **2.3.1 Flashes:** the flood is one 120 ms scale, never repeated within 1 s; no strobing.
- **2.4.3 Focus order and 2.4.11 Focus not obscured:** the sticky action bar on the phone
  reserves its height (`scroll-padding-bottom`). Focus goes into pickers and back to the opener.
- **2.5.8 Target size:** 44 px minimum everywhere on touch; chips get a 44 px hit area
  (`TOUCH_HIT`).
- **3.3.1 Error identification:** amount errors are text under the field (`aria-describedby`),
  not colour alone.
- **4.1.3 Status messages:** `LiveAnnouncer`; `alert` only for refusals and system (2.9).
- **VoiceOver order on a card:** band, heading, meta, pills, values (dots as `role="img"` with
  "7 of 10 stamps"), actions, last scans. The pass preview is `aria-hidden` (it repeats the
  heading and values; staff can't use its barcode).
- **Reduced motion:** 5.4.
- **Language:** `lang="en"`; numbers are formatted with the device locale's grouping and
  currency.

---

## 9. Build notes

- **Files** (n8 ownership, PM §2):
  - `src/web/scan/desk/{desk-layout,member-card,action-drawer,stepper,keypad,review,recent-rail,
    shift-summary}.tsx`;
  - `src/web/scan/{verdict,scan-sound,timing,live-announcer,use-wedge,use-scan-machine}.ts(x)`,
    shared with the door;
  - `src/web/scan/buddy/{scan-buddy.tsx,beats.css,props.tsx}`;
  - `src/shared/copy/scan.ts`.
- **Each file under 300 lines.** The reducer splits into `machine-door.ts` and `machine-desk.ts`
  over a shared core.
- **Kit reuse:** `Card`, `ListRow`, `StatusPill`, `Button busy`, `IconButton`, `CountUp`,
  `Dialog` and the bottom sheet, `Skeleton`, `EmptyState inline`, `Celebrate`, `EntityAvatar`.
- **New kit-level asks** (to the owners named in AGENTS.md):
  - `PassCard hideBarcode` (b);
  - a `Button variant="wash"` (h0), or keep it local in `scan/` if h0 declines.
- **Bundle:** everything here loads in the `/scan` route chunk. The initial bundle has about 5 B
  of headroom (PM §8). The only entry-chunk change is the route-tree line. `zxing-wasm` loads on
  the camera's first open, never on the desk's idle.
- **Tests:**
  - reducer transitions per state (6.x) with an injected decoder and fetch;
  - `verdict.test.ts` (contrast);
  - `beats.test.ts` (size, ≤700 ms, rest pose);
  - wedge detection inside the search field;
  - picker clamp and `max`;
  - stale `set`;
  - unsure replay with the same key;
  - the rights matrix (locked and view-only);
  - live-region text per state;
  - e2e at 1180×820, 820×1180 and 390×844, in light and dark, with reduced motion (the owner's
    viewport rule).

---

## 10. Open questions for the owner

1. **Counters on connection-bound passes** (PM §10, owner calls). If a POS connection owns
   `points`, the desk can either still change it, marking the input `manual` so the next sync
   skips it, or hide those actions. I would hide value actions on connection-owned inputs unless
   the template action sets `overrideSource: true`. Confirm?
2. **Manager codes** (6.25) are specified but deferred. Ship them with the desk (more backend:
   hashed codes, attempt limits, audit), or after?
