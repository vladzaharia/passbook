# The door: check-in UX

How staff check in event tickets at `/scan`. Two devices:

- **Handheld**: an iPhone in one hand, pointed at the guest's phone.
- **Stand**: an iPad in landscape on a stand facing the queue, with a Bluetooth barcode reader or an NFC (VAS) reader that types into the page.

The desk (loyalty, coupons, stamps, points) is designed separately. It shares the shell, the verdict component, lookup, pairing and sound described here; section 12 lists those shared parts.

Sources:

- **R §x**: `research/scanning/report.md`, by section. **R-crit n** is the critic's correction n at the end of the report.
- **PM §x**: `docs/design/scanner/platform-map.md`.
- **MA §x**: `map-access.md` (not shipped).
- Design docs: `next/docs/design/{motion-and-expression,ux-principles,ui-consistency}.md` and the brand guide.

**[U]** marks an assumption to verify on a device.

---

## 0. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Four verdict colours, one meaning each.** Green: in. Amber: genuine pass, a person decides. Red: no entry. Slate: our problem (network, camera, server). | Matches hardware LEDs and Admittee (R §2.2.1). Staff learn three words: green is in, amber is talk, red is no. |
| D2 | **Green and amber are light fills with dark text; red and slate are dark fills with white text.** The colours are the same in both themes. | Red and green look alike to deuteranopes, but light against dark still separates them (luminance 0.41 against 0.11). A green at one door matches the green at the next whatever each device's theme. |
| D3 | **Wrong day, not open yet and event ended are amber, not red.** Wrong event, voided, expired, removed, not found and test/live mismatches are red. | They are genuine tickets for this org, so staff can decide (TicketSpice orange plus Force check-in, R §1). Red never has an override. |
| D4 | **The door auto-acts.** One scan, one check-in, no confirm step. The confirm step exists only in manual lookup. | Speed (Luma Express, PassKit Batch, R §1). |
| D5 | **"Event" is a first-class pick on the device.** Events come from a new manifest block, `scan.event` (which inputs name the event and its start and end). The starter event ticket declares `eventName`, `startsAt` and `endsAt`. | The starter event ticket puts one event in each pass's inputs (`templates/starter-event-ticket/wallet.template.json`). Without an event key, nothing can tell wrong event from wrong day, and no x of y is possible. |
| D6 | **Shift** is this device's run from Start scanning to End shift. **Event** is what is on. Counters show both: "312 of 500 in" for the event and "You: 128" for the shift. | The task asks for a session counter and an end of shift. These are two different numbers. |
| D7 | **Pairing works by scanning a QR link with the stock Camera, or by typing an 8-digit code.** The link opens `/scan?pair=…`, a confirm page with one Pair button. It never consumes on GET. | Passcreator config QR (R §1). Same reasoning as the magic-link confirm page (`ui-consistency.md`, link flows). A query string keeps `isPublicPath('/scan')` exact (PM §4). |
| D8 | **Check-in never changes the pass.** No publish, no push, no R2 write. | Avoids burning n7's 3-a-day push budget (PM §5, n7) and 500 publishes per show. iOS 27 penalizes pushes that change nothing. |
| D9 | **Re-entry is opt-in per scanner**, as an explicit In / Out switch. A second scan never checks a guest out. | Humanitix's scan-again-to-check-out is an anti-pattern (R §2.3). |
| D10 | **"Let in again" on amber is on by default**, recorded as an override with the device and staff name. An admin can turn it off per scanner. | Admittee: "talk to the person rather than turning them away". Answers R §5.8's open question; the decision is made at the door anyway. |
| D11 | **Offline check-in ships, opt-in per scanner, default off, check-in only.** The device downloads a code roster at shift start. It holds hashes and status only, no names. Only scans made offline are queued and replayed with an idempotency key. | Venue connectivity is the most common real failure. The Ticketmaster model (R §5.6). The hash-only roster keeps PII off the device. Values are never queued. |
| D12 | **Controls stay on the kit scale** (44 px on touch, 14 px text, 16 px field text). Hit areas grow to the bottom bar's full 64 px height, and a tap anywhere dismisses a verdict. | The owner's size rule plus gloves. 64 px effective targets with no new control size. |
| D13 | **The verdict headline uses the stat size** (`text-3xl`, 30/36, 600). Icons are 56 px on the phone and 96 px on the stand. | It stays inside the type scale (`ui-consistency.md`, Typography). The icon shape carries the glance. |
| D14 | **One buddy, seated.** In aiming it sits on the viewfinder card's top edge. During a verdict it sits on the result card. The viewfinder buddy hides under the verdict, the way a dialog hides the page's buddy. Beats start 150 ms after the colour, last 600 ms or less, and are cut off by the next scan. | n8b-buddy.md; `motion-and-expression.md` (an open dialog hides the page's buddy). |
| D15 | **The "Test" sign becomes a flask.** The buddy holds the n6 `FlaskConical` glyph instead of a sign with words. | Entity art carries no text (`motion-and-expression.md`, Entity art). The flask is n6's test glyph. |
| D16 | **On a stand, the front camera is the default and its preview is mirrored.** Copy speaks to the guest. | The guest presents the code to the screen's camera. The back camera faces the wall. |
| D17 | **The scanner reuses shared parts.** Test scanners use n6's `ModeBand`. The shell's `OfflineBanner` shows offline. Pairing uses the sign-in `CodeField` (generalized to a length). Rows use `ListRow`, and sheets use `Sheet`. | One implementation per shared concept. |

---

## 1. Speed is the design driver

| Condition | Rule |
| --- | --- |
| **One hand** | Everything a shift needs sits in the bottom third: Look up, Torch, Switch camera, Undo on the last scan. The top bar holds rare controls only: sound, menu and the event switch. Nothing needs a swipe; every gesture has a button (HIG). |
| **Gloves** | The kit's 44 px controls sit in a 64 px bar whose hit areas fill the bar's height, with no dead gaps between them. A tap anywhere dismisses a verdict. No long-press. Nothing smaller than 44 px is ever the only way to do something. |
| **Glare and sun** | The verdict is a full-bleed fill, not a toast or banner (R §2.2.2). Light against dark polarity carries the result without hue (D2). Icon shapes differ: circle, triangle, octagon, cloud. Headlines are 30 px semibold. The camera hint pill sits on a 60 % black scrim. |
| **Noise** | Four distinct tones (section 7), on by default and remembered per device. The `audioSession` is set to playback, so the ringer switch doesn't mute them [U]. The colour never depends on hearing the sound. |
| **Throughput** | No trigger: the camera reads on its own. A green holds for 1.2 s, and a new code replaces it after 0.6 s. The same code is ignored for 5 s. No confirm on scan. The next guest never waits for animation. |
| **Arm's length** | The phone gets turned toward the guest. The headline and icon are readable from 60 cm on the phone and from 1.5 m on the stand (96 px icon). |

---

## 2. Devices, layouts and the shell

### 2.1 Layout modes

| Mode | Default on | Camera | Copy speaks to | Idle |
| --- | --- | --- | --- | --- |
| **Handheld** | iPhone, any width under 1024 | Back (main lens, R §5.8.3) | Staff: "Point at the code" | Pauses decoding after 60 s; tap to resume |
| **Stand** | iPad, width 1024 or more | Front, mirrored (D16); none if the scanner is reader-only | Guest: "Hold your code up to the camera" | Never pauses; decoding drops to 4/s after 60 s idle |

The mode is set in the menu (**Layout: Handheld / Stand**) and remembered per device (`localStorage` `passbook-scan-layout`).

Breakpoints follow `ui-consistency.md`:

- **Under 640:** the phone layout.
- **640 to 1023** (portrait tablet): the phone layout with the viewfinder capped at 480 px, and 5 recent rows under it instead of 1.
- **1024 and up:** two panes. A desktop with a webcam or a USB reader gets the iPad landscape layout.

### 2.2 Shell

`/scan` renders in `BareLayout` (`AppShell width="full" holder`, PM §3). The shell provides:

- safe areas;
- `OfflineBanner` (D17);
- n6's `ModeBand` in the band slot when the scanner's mode is `test`. The band needs a `mode` prop, because the scanner's mode comes from the device, not from `localStorage`.

Never hash routing, and one long-lived camera stream (R §5.8.2). Every scanner screen is `/scan`; state lives in a reducer, not in the URL.

### 2.3 Phone, portrait (390 × 844)

```
┌──────────────────────────────────────┐ safe top
│ Main stage · Fri ▾   312/500   🔈  ⋯ │ top bar 56 (page surface, border-b)
├──────────────────────────────────────┤ [Test mode band 20, test scanners only]
│ ● Ready                      ╭buddy╮ │ status line 44: buddy S seated on the card edge at end
│╭────────────────────────────────────╮│
││░░░░░░░░░░░░ live camera ░░░░░░░░░░░││ viewfinder card: 16 px side gutters, r 18,
││░░░░░ ┏━━━              ━━━┓ ░░░░░░░││ 1 px border-strong, flex-1 (min 300, max 440)
││░░░░░ ┃                    ┃ ░░░░░░░││ reticle 240 × 240, centred; mask outside at 40 % black
││░░░░░ ┃                    ┃ ░░░░░░░││
││░░░░░ ┗━━━              ━━━┛ ░░░░░░░││
││       ( Point at the code )        ││ hint pill, bottom 16, scrim 60 % black, white 14/500
│╰────────────────────────────────────╯│
│ ✓  Anna Meyer                        │ last-scan row 56 (ListRow): outcome icon,
│    Checked in · 7:41 PM        Undo  │ title, meta, trailing Undo (ghost sm)
├──────────────────────────────────────┤
│ [ 🔍 Look up            ] [🔦]  [⟲] │ bottom bar 64 + safe-area bottom
└──────────────────────────────────────┘
```

- **Top bar** (56 px, the page surface, as in `ui-consistency.md`, Layout):
  - Event switch: a ghost button with the event name, truncated, and `ChevronDown`. It opens the shift sheet (section 10).
  - Counter pill: `312/500`, tabular, width reserved for `0000/0000`, so it never shifts.
  - Sound: an icon button, `Volume2` / `VolumeX`.
  - Menu: `MoreHorizontal`.
- **Status line** (44 px; it is also the buddy's 11/12 reserve above the card edge):
  - a dot and a word on the left: **Ready**, **Checking…**, **Paused**;
  - the reader chip, when present (section 8);
  - the buddy S seated at the end of the card's top edge (`at="end"`).
- **Viewfinder card:**
  - `rounded-xl`, 1 px `border-strong` border, `bg-black` behind the video;
  - the video is `object-fit: cover` and `aria-hidden`;
  - the reticle is four L-corners, 32 px legs, a 4 px white stroke with a 1 px 40 % black outline for contrast on bright scenes.
- **Last-scan row:** one `ListRow` at a fixed 56 px from the first frame. Before any scan it reads "No scans yet" in muted text. A tap on the row body opens Recent (section 9).
- **Bottom bar:** three controls, 44 px visual height:
  - **Look up**: an outline button with `Search`, `flex-1`;
  - **Torch**: an icon button, shown only when the camera supports it (section 7);
  - **Switch camera**: an icon button.

  Their hit areas run the full 64 px bar height (`TOUCH_HIT` extended). The bar pads with `pb-safe`.

### 2.4 iPad, landscape (1180 × 820)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Front door · Main stage · Fri ▾        312 of 500 in    ◉ Reader    🔈   ⋯   │ top bar 56
├───────────────────────────────────────────────┬──────────────────────────────┤
│ ● Ready                               ╭buddy╮ │ [🔍 Name, email or code    ] │ lookup field, always on
│╭─────────────────────────────────────────────╮│                              │
││░░░░░░░░░░░░░░ front camera, mirrored ░░░░░░░││ Recent                       │ card, ListRows
││░░░░░░░░░░░ ┏━━━                ━━━┓ ░░░░░░░░││ ✓ Anna Meyer   7:41  Undo    │ last 8
││░░░░░░░░░░░ ┃                      ┃ ░░░░░░░░││ ▲ Ben Okafor   7:40          │
││░░░░░░░░░░░ ┗━━━                ━━━┛ ░░░░░░░░││ ✕ (not found)  7:39          │
││      ( Hold your code up to the camera ↑ )  ││ …                            │
│╰─────────────────────────────────────────────╯│                              │
│  Or hold your iPhone near the reader  (Nfc)   │ You: 128 · since 6:02 PM     │
│                         [🔦] [⟲] [Camera off] │              [ End shift ]   │
└───────────────────────────────────────────────┴──────────────────────────────┘
```

- **Grid:**
  - left pane `7fr` (the stage), right pane `5fr` (the side panel), 24 px gap;
  - `--wl-gutter` 1.5 rem plus safe areas.
- **Stage:**
  - the viewfinder card, or the reader stage when the camera is off (section 8.2);
  - buddy M (96 × 72) seated on its top edge at the end;
  - reticle 320 px;
  - the NFC line under it only when the scanner has an NFC reader.
- **Side panel:**
  - **Lookup field**: 44 px tall, 16 px text. While it has text, its results replace Recent in place;
  - **Recent card**: 8 `ListRow`s with Undo;
  - **Shift footer**: "You: 128 · since 6:02 PM" and an **End shift** outline button.
- **Top bar:**
  - scanner name, event switch;
  - counter as text, "312 of 500 in" (`text-sm`, tabular);
  - reader chip, sound, menu.

### 2.5 Verdict overlay (both layouts)

The verdict is one `ScanOutcome` component (R §5.2). It is fixed, covers the whole viewport including the safe areas, and sits above the shell and the band. The verdict wash goes edge to edge; the test band stays visible on top.

Phone:

```
┌──────────────────────────────────────┐ wash: verdict colour, full bleed
│                                      │ pt: safe-area + 24
│  ◯✓                                  │ icon 56 (Lucide, 2.5 stroke, on-colour)
│  Checked in                          │ headline text-3xl 600 (30/36), on-colour
│  Anna Meyer                ╭buddy S╮ │ sub text-base 600 (green: the holder; others: the reason)
│╭────────────────────────────────────╮│ result card: surface-raised, rounded-xl, p-4
││ ▭▭ still │ General · Row F, seat 12 ││ pass still 64 px tall (barcode hidden) + subtitle
││          │ Main stage · Fri 7:00 PM ││ event line (only when the shift spans events)
││──────────────────────────────────  ││ card footer (amber only): 44 px buttons, stacked,
││ [            Done             ]    ││ primary on top (kit bottom-sheet rule)
││ [        Let in again         ]    ││
│╰────────────────────────────────────╯│
│▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔│ hold rail: 2 px, on-colour at 40 %, scaleX 1 → 0
└──────────────────────────────────────┘
```

On iPad: a centred column, at most 560 px wide.

- Icon 96 px.
- The result card puts a 180 px wide `PassCard` still (`still`, barcode hidden by a new optional prop, PM §10.22) on the left and the text on the right.
- Actions sit side by side, primary at the right.

**Order changes by kind**, so outcomes differ without colour (R §5.3):

| Kind | Sub line | Card |
| --- | --- | --- |
| ok | holder title (who) | still, subtitle, event line |
| heads_up | when and where | still, title, subtitle, meta "7:41 PM · by Sam" |
| refused | the reason line | one compact row, `title · subtitle`, no still; shown only when the pass was found |
| system | what to do | none |

**Seat.** On the phone, the buddy S sits on the result card's top edge at the end. The sub line keeps 72 px clear on its right, so text wraps before it. On iPad the buddy is M.

---

## 3. The verdict system

### 3.1 Colour tokens

These are new tokens in `src/web/styles/scan.css`, imported by the scan chunk only. They are theme-invariant (D2): the same values in light and dark.

| Token | Fill | `-on` text and icon | Contrast | Luminance |
| --- | --- | --- | --- | --- |
| `--wl-scan-ok` | `#22c55e` | `#04170b` | 8.1:1 | 0.41 |
| `--wl-scan-heads-up` | `#facc15` | `#1f1600` | 11.7:1 | 0.64 |
| `--wl-scan-refused` | `#b91c1c` | `#ffffff` | 6.5:1 | 0.11 |
| `--wl-scan-system` | `#334155` | `#ffffff` | 10.4:1 | 0.05 |

- The result card on the wash is `surface-raised` in the current theme. It carries a 1 px `rgb(0 0 0 / .12)` edge on light fills and `--wl-edge` on dark ones, so it reads on every wash.
- Card text uses the theme's tokens.
- Buttons never sit on the bare wash:
  - on amber and on confirm-type results, the actions sit in the result card's footer (a hairline above, `p-4`), so the kit's teal primary and outline keep their contrast in both themes;
  - system verdicts have no card, so their single action sits in a card-less footer strip on `surface-raised` (`rounded-xl`, `p-3`) at the bottom of the wash.
- These are signals, not status pills. `success`, `warning` and `danger` keep their meanings elsewhere. The verdict tokens are never used outside `/scan`. That is a narrow exception to "no hex in components", made in a token file, not in a component.

### 3.2 Icons (Lucide)

| Kind | Icon | Shape cue |
| --- | --- | --- |
| ok | `CircleCheckBig` | circle |
| heads_up: already, wrong day, not checked in | `TriangleAlert` | triangle |
| heads_up: timing (not open yet, ended, too soon) | `Clock` | clock face |
| refused | `OctagonX` | octagon |
| system: network | `CloudOff` | cloud |
| system: server error | `Unplug` | plug; matches the error art (`ui-consistency.md`, Empty, loading, error) |
| system: rate limit | `Hourglass` | matches the rate-limit art |
| system: scanner removed | `Lock` | matches forbidden |

### 3.3 Timing

All values live in one `SCAN_TIMING` constant (`src/web/scan/timing.ts`), covered by a test.

| Constant | Value | Source |
| --- | --- | --- |
| `OK_HOLD` | 1200 ms | R §5.2 |
| `NEXT_SCAN_AFTER_VERDICT` | 600 ms. Decoding resumes after this for every kind; a *different* code replaces the verdict, and so does the same code on system kinds | R §5.2 |
| `REFUSED_HOLD` | 3000 ms | R §5.2, Admittee |
| `HEADS_UP_HOLD` | until a tap or a different code | R §2.2.5, HIG |
| `SYSTEM_HOLD` | until a tap or any scan | |
| `SAME_CODE_ACCEPTED_IGNORE` | 5000 ms, shows the "Scanned just now" chip | R §5.2 |
| `SAME_CODE_REFUSED_IGNORE` | 30000 ms, shows the "Same code" chip | Admittee |
| `DETECT_TICK_AFTER` | 300 ms. If no answer by then: a soft tick, the spinner, the rummage | R §2.1 |
| `LOOKUP_TIMEOUT` | 5000 ms, then the system verdict | R §5.2 |
| `HINT_AFTER` | 4000 ms without a decode, only within 20 s of a scan or of Start | R §2.1 (needs-help) |
| `IDLE_PAUSE` | 60 s on handheld; never on stand | R §5.2 |
| `STREAM_RELEASE` | 5 min paused releases the camera | R web-feasibility §3 |
| `BUDDY_DELAY` / `BUDDY_MAX` | 150 ms / 600 ms | Scandit's 150 ms (R §2.1); n8b caps beats at 700 ms |
| `UNDO_WINDOW` | 10 min, this device's scans | R §5.3 |
| `COUNTER_POLL` | 10 s while visible; every scan response also carries the counter | Ticket Tailor's 7 s (R §1) |

**Keep results until tapped** is a device setting, off by default (HIG; WCAG 2.2.1). With it on:

- ok and refused also hold until tapped;
- the hold rail is hidden;
- a different code still replaces the verdict.

### 3.4 Entry and exit motion

Transform and opacity only, with tokens from `motion.css`.

| t | What |
| --- | --- |
| T0 (response) | The wash goes opacity 0 → 1 in 80 ms (`--wl-dur-press`). Icon, headline and sub are in the same frame, with no stagger. The tone starts at T0. |
| T0 to 300 | The icon scales .8 → 1 on `--wl-ease-bounce` (300 ms). |
| T0 to 200 | The result card rises 8 px with opacity (`--wl-dur-enter`). |
| T0 + 150 to 750 | The buddy beat (section 6). |
| Hold | A 2 px hold rail along the bottom edge runs `scaleX(1 → 0)`, linear, for the hold time (ok and refused only). |
| Exit | The wash fades out in 120 ms (`--wl-dur-exit`) and the frozen video resumes. |
| Replace | A new verdict swaps content at once (no exit). The buddy beat restarts through its `replay` counter. |
| Reduced motion | The wash and content fade in 120 ms. No scale, rise, rail or beat. The buddy swaps to the state's static pose. |

The overlay never animates layout. Nothing pulses or flashes: a verdict is one transition, and at most one per 600 ms (no strobing; HIG).

### 3.5 Announcements

Two live regions are mounted once with the shell and are always present:

- `#scan-status`: `role="status"`, `aria-live="polite"`;
- `#scan-alert`: `role="alert"`.

| Kind | Region | Focus |
| --- | --- | --- |
| ok, queued | status | stays put |
| heads_up | status | moves to the first action (**Done**), so VoiceOver lands on a decision (R §5.3) |
| refused | alert | stays put |
| system | alert | moves to the first action |

Each announcement is one sentence: headline, then sub, then holder (exact text per state below). The camera preview is `aria-hidden`. The viewfinder card is a `region` labelled "Camera", holding a visually hidden status ("Ready to scan", "Paused").

---

## 4. Getting in

### 4.1 Who can scan

| Principal | How | Scope | Lifetime |
| --- | --- | --- | --- |
| **Paired scanner device** (the normal case) | Pairing QR link or 8-digit code | One org, one mode. Allowed templates, optional pinned event, door window, re-entry, override and offline settings (section 13) | 180 days, revocable, `last_seen_at` (PM §10.1, MA §10.2) |
| **Platform admin** | Their own session on `/scan` | Picks an org; mode comes from the n6 switch | Their session (1 h idle, kept alive by scanning; 12 h absolute, MA §10.8). For rehearsal and setup, not shifts |
| Holders, `user` sessions, API keys | No door access. Keys reach the scan API for POS at the desk only | | |

**Staff name.** Optional per scanner ("Ask for a name"). It is a free-text label stored on the device for the shift, sent with each scan as `operator`. It is not a principal (MA §10.4). It shows in "by Sam" on duplicates.

### 4.2 Pair: unpaired device

**Layout.** The hosted card from sign-in: a `max-w-sm` card, centred, with the wordmark band above. One implementation (`ui-consistency.md`, Sign-in pages).

- **Phone:** full width minus the gutters.
- **iPad:** centred, 384 px.
- The buddy M sits on the card's top edge at the right (L at 1024 and up, as on sign-in).

| Part | Content |
| --- | --- |
| h1 | **Pair this device** |
| Field | Label **Pairing code**. `CodeField` with `length={8}`, grouped `1234 5678`, `inputmode="numeric"`, `autocomplete="one-time-code"`, 16 px under coarse pointers |
| Primary | **Pair** (full width) |
| Secondary | **Scan pairing code** (outline, `ScanLine` icon). Opens the camera for the admin's QR. This tap is also the camera gesture |
| Admin only | An "or" divider, then **Scan as admin** (outline). Shown when a signed-in admin session exists |
| Footer | Lock icon. **Admins make codes in Scanners.** |

The admin's QR encodes `https://passbook.mobile/scan?pair=<code>`. Reading it in-page, or opening it from the stock Camera, both lead to 4.3.

**Errors.** A callout at the top of the card body, one sentence each, as on sign-in:

| Case | Callout | Buddy |
| --- | --- | --- |
| Wrong code | **That code didn't work. Check it and try again.** | Slip: the pocket shakes once (240 ms) and the face goes flat (the existing sign-in behaviour) |
| Expired or used | **Code expired. Ask an admin for a new one.** | Sad; the gold pass droops 18° (existing) |
| Rate limited | **Too many tries. Wait a minute and try again.** | Sad, the hourglass (existing) |
| Offline | **No connection. Pair when you're back online.** | Sad |

**Buddy.** Neutral; holds the teal pass up like a key card (new pose, `pair`; section 6). Reduced motion: the static pose.

**Announcement.** The errors use the callout's `role="alert"`; field errors use `aria-describedby`.

**Timing.** None. Pairing is a form.

### 4.3 Pair: confirm from a link

`/scan?pair=1234…`: the page reads the code, replaces the URL with `/scan` at once (`history.replaceState`) and asks the server for the scanner's name. It doesn't consume the code yet. The link can be previewed or prefetched, so GET never pairs.

| Part | Content |
| --- | --- |
| h1 | **Pair this device?** |
| Lede | **As Front door for Northwind Live.** |
| Primary | **Pair** |
| Secondary | **Cancel** (outline). Goes to 4.2 |

**Paired.**

- The card flips (640 ms spring, the sign-in card flip) to the Start screen's first frame. The buddy plays **hello**, the wave (existing).
- One toast-free callout on Start: **Paired as Front door.** (success tone, dismissible).
- Sound: the ok tone, now that the Pair tap has unlocked audio.
- Announcement (status): "Paired as Front door."

### 4.4 Scan as admin

A bottom sheet on the phone, a `md` dialog on the iPad.

- Title: **Scan as admin**.
- Field: **Organization**, an `EntityPicker kind="org"`, prefilled from the last choice.
- Mode: read from the n6 switch and shown as a `ModePill`. To change it: **Switch to Test** or **Switch to Live**, a ghost button.
- Primary: **Continue**.

The scanner name shows as **You (admin)**. Admin shifts can't enable offline. They can use every action, override included.

### 4.5 Scanner removed, org suspended, session ended

These are full-screen blocking panels (the system wash, slate), not verdicts, because nothing can be scanned. Each releases the camera and the wake lock.

| State | Icon | Headline | Sub | Action | Buddy |
| --- | --- | --- | --- | --- | --- |
| Scanner removed (401 `scanner_revoked`) | `Lock` | **Scanner removed** | **Ask an admin for a new code.** | **Pair again** (primary) | Sad, tugs the lock (`tug`, existing, full length because nothing waits) |
| Org suspended | `Lock` | **Organization suspended** | **Scanning is off until an admin restores it.** | **Try again** | Sad, `tug` |
| Admin session ended | `LogOut` | **Signed out** | **Sign in again to keep scanning.** | **Sign in** (goes to `/login?next=/scan`) | Sad |

Announcement (alert): headline plus sub. Focus moves to the action.

### 4.6 Test and live

- **A test scanner** shows n6's `ModeBand` ("Test mode · Nothing here reaches holders.") on every scanner screen, the verdict overlay included. The band is out of the layout flow, so nothing shifts.
- **A live scanner** shows nothing extra.
- **Mismatches** are refusals (section 5.3), never silent.
- A test scanner writes its scans with the pass's mode (PM §5, n6). Its counters count test passes only.

---

## 5. Start, aiming and outcomes

### 5.1 Start (once per shift)

**Layout.**

- **Phone:** the page under the top bar, then a sticky bottom bar holding **Start scanning**.
- **iPad:** a centred `max-w-lg` card.

The top bar shows the scanner name and the menu only. No counter yet.

| Part | Content |
| --- | --- |
| h1 | The scanner's name (**Front door**); meta row: the org name, plus `ModePill` on test |
| **Event** | Radio rows (`OptionTile`, one per event): title = event name; meta = **Fri, Jun 1 · 7:00 PM · Main hall**; trailing = **312 of 500 in** (tabular). Groups: **Now** (window includes now), **Later today**, then **Coming up** (next 7 days, collapsed). When more than one event is in Now, an extra first row **All of today's events** |
| **Direction** | `SegmentedControl` **In** / **Out**; only when re-entry is on (D9). Default In |
| **Your name** | Only when the scanner asks for it. Input 44 px, 16 px text. Help: **Shows on scans you make.** Kept for the shift |
| Primary | **Start scanning** (`Camera` icon), full width, 44 px |

Rules:

- **A pinned event**, or only one event in Now, is preselected. The list collapses to one line with **Change**. A step with one choice is skipped (`ux-principles.md`, Forms).
- **Templates without `scan.event`** list as **{Template name} · Any day** rows. There is no event check for those passes (D5).
- **No events:** an `EmptyState` (inline) with the `passes` art. Title **No events today**, line **Ask an admin to check this scanner.**, and **Look up** (outline) still available.
- **Start scanning** does three things in one gesture:
  - `getUserMedia` (720p, the remembered `deviceId`, else main back or front by layout);
  - `AudioContext.resume()` and `navigator.audioSession.type = 'playback'`;
  - `navigator.wakeLock.request('screen')`.

  It also loads the decoder chunk if it isn't loaded yet; prefetch it while Start is on screen (R §5.8.1). In the same tap, offline scanners fetch the roster (section 11).
- **Reader-only scanner with the camera off:** **Start scanning** keeps the same label and skips the camera.

**Buddy.** M, seated on the Start card's top edge at the end. Neutral; one idle beat at 2.4 s. After pairing it plays **hello** instead.

**Announcement.** Focus goes to h1 on arrival, as on any route.

### 5.2 Aiming, hint, detected, looking up, paused

| State | Phone | iPad | Copy | Buddy | Sound | Announcement |
| --- | --- | --- | --- | --- | --- | --- |
| **Starting camera** | Viewfinder card on black with the reticle drawn. After 300 ms a `Spinner` in the status line | Same in the stage | Status **Starting camera…** | Seated, eyes on the centre | none | status: "Starting camera." |
| **Aiming** | Live video, reticle corners at 70 % white. Hint pill **Point at the code** | Hint **Hold your code up to the camera** with `ArrowUp` toward the front camera. Reader-only: the reader stage (8.2) | Status **Ready** | Eyes on the centre; one idle beat (glance down, blink) 2.4 s after aiming starts, then still (WCAG 2.2.2) | none | status, once at Start: "Ready to scan." |
| **Hint** (4 s with no decode, within 20 s of activity) | Hint pill swaps (120 ms fade) to **Move back a little**; at 8 s **Tilt to cut the glare**; at 12 s **Won't scan? Tap Look up.**, and the Look up button's icon nudges 2 px once | Same pill; stand copy **Move your phone back a little** / **Tilt your phone to cut the glare** | | Leans toward the centre 3° once per hint (the hint's beat) | none | none (hints are visual coaching; the static instruction already exists) |
| **Detected** (decode at D0) | Decoding stops. `video.pause()` freezes the frame. Reticle corners go 100 % white and press to .96 (80 ms). The code's polygon from the decoder draws as a 2 px white outline, fading in over 80 ms | Same | Status **Checking…** | Eyes widen and lock onto the box (pose swap, 80 ms) | none yet | none |
| **Looking up** (no answer by D0 + 300 ms) | `Spinner` beside **Checking…**; a 2 px loading rail runs along the viewfinder card's top edge (the kit `LoadingRail`, essential loop) | Same | **Checking…** | Rummages in its pocket (loops while pending: a loading indicator, so exempt) | Soft detect tick at 300 ms | status: "Checking." (only after 300 ms) |
| **Timeout** (D0 + 5 s) | The system verdict "No answer" (5.4) | | | | | |
| **Paused** (handheld, 60 s idle, or back from background) | Video dimmed to 30 % (opacity on an overlay), decoding stopped, reticle hidden, a centred 44 px outline button **Tap to scan**. The whole card is the target | Stand never idles. Back from background shows the same panel | Status **Paused** | Asleep: eyes shut, slow slump (static pose; nothing loops) | none | status: "Paused. Tap to scan." |

Notes:

- **Backgrounding** (`visibilitychange` hidden) stops decoding and releases the wake lock. On return, the Paused panel shows, because a wake lock needs a gesture (R web-feasibility §6). After 5 min paused, the stream is released, and the tap re-acquires it.
- **Same code, accepted, within 5 s:** no new request and no sound. A chip **Scanned just now** (`surface-overlay`, `CircleCheckBig` 14 px) shows over the reticle for 1.5 s. Announcement (status): "Scanned just now."
- **Same code, refused, within 30 s:** no request and no sound. A chip **Same code · {headline}** (for example **Same code · Not found**) for 1.5 s. Announcement (status): the chip text.
- **A different code** always goes through.
- **Any idempotency failure** (timeout or network) keeps the code's `idempotencyKey` for 60 s. Re-scanning that code replays the same key, so the server returns the original outcome instead of "Already checked in" (R §5.6).

### 5.3 Outcomes

Each row is one `ScanOutcome` (`kind`, `reason`). Rows give the headline, sub, card, actions and buddy. Phone and iPad layouts follow 2.5. Tones are defined in section 7.

#### ok (green, `CircleCheckBig`, ok tone, hold 1.2 s, then auto-resume)

| Reason | Headline | Sub | Card | Buddy beat | Announcement (status) |
| --- | --- | --- | --- | --- | --- |
| `checked_in` | **Checked in** | holder title (**Anna Meyer**) | still · subtitle (**General · Row F, seat 12**) · event line if All events · group chip (section 9.3) | `cheer-quick`: hop, the gold pass up like a thumb, then tucked into the pocket | "Checked in. Anna Meyer. General, row F, seat 12." |
| `checked_in` after a check-out (re-entry) | **Checked in** | holder | + meta **Back in. Out since 8:12 PM.** | `cheer-quick` | "Checked in. Anna Meyer. Back in." |
| `checked_in` with override | **Checked in** | holder | + meta **Let in again.** | `cheer-quick` | "Checked in. Anna Meyer. Let in again." |
| `checked_out` (Out direction) | **Checked out** | holder | still · subtitle | `tuck` short: the pass dips into the pocket and pops back | "Checked out. Anna Meyer." |
| `queued` (offline, roster says valid) | **Checked in** | **Saved offline** (with `CloudUpload` 16 px) | no still or name (the roster has none, D11); only **Syncs when you're back online.** | `cheer-quick`, then the pass tucks beside a small clock | "Checked in. Saved offline." |

Milestones (from data, once): the device whose check-in returns an event count that is a multiple of 100, and the one that brings x to y.

- The same green verdict, plus a 6-spark `Celebrate` burst from the icon (640 ms, foil sparks; `motion-and-expression.md`, Celebrations).
- The buddy plays `cheer-fan`: the passes fan out wide.
- No extra words.
- It never extends the hold.

#### heads_up (amber, holds until **Done**, a tap anywhere, or a different code; heads-up tone)

| Reason | Icon | Headline | Sub | Card meta | Actions | Buddy beat | Announcement (status, then focus to Done) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `already_in` | `TriangleAlert` | **Already checked in** | **12 min ago · Front door** (or **Today 7:41 PM · Side door** after 60 min) | **7:41 PM · by Sam** (when there's an operator) · still · title · subtitle | **Done** (primary), **Let in again** (outline, when allowed) | `wrist-tap`: brow up, taps its wrist with the teal pass | "Already checked in. 12 minutes ago at Front door. Anna Meyer." |
| `already_out` (Out) | `TriangleAlert` | **Already checked out** | **8:12 PM · Side door** | still · title | **Done** | `wrist-tap` | "Already checked out at 8:12 PM. Anna Meyer." |
| `not_in` (Out, never checked in) | `TriangleAlert` | **Not checked in** | **Check them in instead?** | still · title | **Check in** (primary), **Done** | head tilt | "Not checked in. Anna Meyer." |
| `wrong_day` | `TriangleAlert` | **Wrong day** | **For Sat, Jun 2.** | still · title · event line **Main stage · Sat 7:00 PM** | **Done**, **Let in anyway** (when override is allowed) | `wrist-tap` | "Wrong day. For Saturday, June 2. Anna Meyer." |
| `not_open` (before the door window) | `Clock` | **Not open yet** | **Doors open 6:00 PM.** | still · title | **Done**, **Let in anyway** | `wrist-tap` | "Not open yet. Doors open 6 PM." |
| `event_ended` (after the window) | `Clock` | **Event ended** | **Ended 11:00 PM.** | still · title | **Done**, **Let in anyway** | gold pass droops (the `expired` pose) | "Event ended at 11 PM." |
| `cooldown` (template `repeat: cooldown`, for example a festival pass, once a day) | `Clock` | **Too soon** | **Checked in 4 min ago. Next entry 8:15 PM.** | still · title | **Done**, **Let in anyway** | `wrist-tap` | "Too soon. Checked in 4 minutes ago. Next entry 8:15 PM." |

Rules:

- **Let in anyway / Let in again** is a tapped action. It sends `override: true` with the original `idempotencyKey`. The result is a green ok with the "Let in again." meta. The switch-tick haptic plays on this tap only [U] (R §5.4).
- **Hidden when the scanner forbids overrides.** **Done** is then the only action, and the sub gains nothing.
- **Times** are in the venue's time zone when the template declares `scan.event.timeZone` (the starter's `venueTimeZone`), else in device local time. Formats: `7:41 PM` for times, `Sat, Jun 2` for dates, relative under 60 min ("12 min ago").

#### refused (red, `OctagonX`, refused tone, hold 3 s, then auto-resume; a different code replaces it)

| Reason | Headline | Sub | Card | Buddy beat | Announcement (alert) |
| --- | --- | --- | --- | --- | --- |
| `not_found`, which also covers **another org's code** (R §4.1) | **Not found** | **This code isn't a ticket here.** | none | `peek-shrug`: the lens comes down over one eye, then a shrug | "Not found. This code isn't a ticket here." |
| `not_found` offline | **Not found** | **Not on the offline list from 6:58 PM.** | none | `peek-shrug` | same sentence |
| `ambiguous` (a barcode hash matches more than one pass) | **More than one match** | **Look it up by name instead.** | none; action **Look up** (outline). This stops the auto-resume (it holds until a tap) | `peek-shrug` | "More than one match. Look it up by name instead." |
| `voided` | **Voided** | **Voided Nov 3.** | compact row | `tear-quick`: a teal tear, one sob | "Voided. Voided November 3. Anna Meyer." |
| `removed` | **Removed** | **Taken out of Wallet Nov 3.** | compact row | `tear-quick` | "Removed. Taken out of Wallet November 3." |
| `expired` (no event match applies) | **Expired** | **Ended Jun 1.** | compact row | gold pass droops 18° (the static `expired` pose, no beat) | "Expired. Ended June 1." |
| `wrong_event` | **Wrong event** | **For Jazz Night · Sat 8:00 PM.** | compact row | `peek-shrug` | "Wrong event. For Jazz Night, Saturday 8 PM." |
| `template_not_allowed` | **Not accepted here** | **{Template name} isn't on this scanner.** | compact row | head shake | "Not accepted here. Gym membership isn't on this scanner." |
| `test_pass` (live scanner) | **Test pass** | **Live scanners don't take test passes.** | compact row + `ModePill` | holds up the flask (D15) | "Test pass. Live scanners don't take test passes." |
| `live_pass` (test scanner) | **Live pass** | **This is a test scanner.** | compact row | holds up the flask | "Live pass. This is a test scanner." |

**Check order** on the server. The first match wins, so each verdict is specific and stable:

1. org and mode scope;
2. not found;
3. ambiguous;
4. test/live;
5. template allowed;
6. voided;
7. removed;
8. event match (wrong event, then wrong day);
9. door window (not open, ended);
10. expired;
11. action state (already in, cooldown, already out, not in).

Org scoping and identity are always checked first (PM §5, MA §10.7).

#### system (slate, our problem; system tone)

| Reason | Icon | Headline | Sub | Actions | Hold | Buddy | Announcement (alert) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `network` (offline, fetch error) | `CloudOff` | **No connection** | **Scan again. It won't count twice.** | **Done** | until a tap or any scan | a small cloud over its head (new pose) | "No connection. Scan again. It won't count twice." |
| `timeout` (5 s) | `CloudOff` | **No answer** | **Scan again. It won't count twice.** | **Done** | same | same | same pattern |
| `server` (5xx) | `Unplug` | **Something went wrong** | **Scan again.** + `Ref 7F3K` in `xs` mono muted | **Done** | same | `plug` short (spark, plug drops) | "Something went wrong. Scan again." |
| `rate_limited` (429) | `Hourglass` | **Too many scans** | **Try again in 20 s.** (a live countdown; text only, no motion) | none; auto-clears at 0 | until Retry-After | the hourglass flips in | "Too many scans. Try again in 20 seconds." |

"It won't count twice" is true because of the replayed `idempotencyKey` (5.2).

---

## 6. The buddy

**Placement.**

| Where | Phone | iPad |
| --- | --- | --- |
| Pair and Start cards | M, top edge, end | M (L at 1024 and up on Pair, matching sign-in) |
| Viewfinder card (aiming) | S, top edge, end | M, top edge, end |
| Result card (verdict) | S, top edge, end | M |
| Lookup sheet or panel | S on the sheet's top edge, only while the sheet is open (it hides the viewfinder buddy under its scrim) | none (the stage buddy stays; one buddy) |
| Shift and summary sheet | M on the summary card | M |

One buddy at a time (`useRegisterBuddy`). The verdict and sheets hide the viewfinder buddy the way an open dialog hides the page's (`art-wallet.css`).

**Beat API.** Scenes start 700 ms after landing and run 1.8 s or more (PM §8). Verdict beats need to start at once and stop at once. The buddy gets a new prop:

- `beat={name}` plays a beat immediately (from `BUDDY_DELAY`), at most 600 ms;
- `replay` (an existing counter) restarts it;
- unmounting or a new beat ends it on the rest pose (`animation: none`, then the pose class).

Beats are CSS under `[data-beat]` in a new `src/web/ui/art/beats/*.css`, imported by the scan chunk only. They have their own budget (2.5 kB gzip) and a timing test (`beats.test.ts`: every beat at 600 ms or less, transform and opacity only, ends on rest). This is a shared-file change in `ui/art` and needs sign-off from h0 or foundation.

| Beat or pose | Use | Built from | Cost |
| --- | --- | --- | --- |
| `pair` pose | Pair screen | new pose: teal pass raised (transform on the existing pass part) | tiny |
| `hello` | paired | existing scene | 0 |
| lock-on pose | detected | eye part `scale(1.25)`, pupils toward the centre | tiny |
| `rummage` (loops while pending) | looking up | new: pocket wiggles ±2°, passes dip and rise 2 units, 600 ms cycle; `.wl-essential` | small |
| `cheer-quick` | ok | `cheer` keyframes compressed to 600 ms | small |
| `cheer-fan` | milestones | `count` hop with the fan spread ±14°, 600 ms | small |
| `wrist-tap` | heads_up | new: brow up, teal pass taps the pocket's left edge twice (2 × 140 ms) | small |
| head tilt | `not_in` | rotate 8° and back | tiny |
| `tear-quick` | voided, removed | `tear` keyframes, 600 ms | small |
| expired pose | expired, event ended | existing `expired` state | 0 |
| `peek-shrug` | not found, ambiguous, wrong event | `peek` lens drop plus `sweep` shrug, 600 ms | small |
| head shake | not accepted here, wrong pairing code | `--wl-dur-shake` on the body | 0 |
| flask prop | test or live mismatch | new prop: a 3-node flask outline; the gold pass lifts it | small |
| cloud pose | network | new prop: one cloud path over its head | tiny |
| hourglass | rate limited | existing state part | 0 |
| plug short | server | `plug` spark only | small |
| asleep pose | paused | eyes shut (existing blink part held), slump 2 units | tiny |
| cover-eyes | camera blocked | new: outer passes rotate in over the eyes, then the teal pass points down-right toward Look up | small |
| notepad | manual lookup | new prop: a small pad; eyes follow the caret (as on sign-in) | small |
| NFC rings | reader prompt | new: 3 concentric arcs from the pocket toward the reader side, once on entry (not a loop) | small |
| catch | NFC read | pocket opens 3 units, squash, then the lock-on pose | tiny |
| `count` | shift summary | existing scene | 0 |

**Rules:**

- The buddy is never the only signal (n8b).
- It stays `aria-hidden`.
- A click on painted parts does nothing on `/scan`: no replay, so a gloved tap meant for "dismiss" can't be eaten.
- Under reduced motion, every beat becomes its static final pose, and the rummage stays still: the spinner carries the pending state.

---

## 7. Sound, torch, camera switching

### 7.1 Tones

Web Audio is synthesized at runtime: no files, and no `media-src` change (PM §7). Every tone has a 5 ms attack and an exponential release, at gain 0.5 of the master.

| Tone | Shape | Use |
| --- | --- | --- |
| ok | sine 1175 Hz, 110 ms | ok, queued, paired |
| milestone | ok, then 1397 and 1760 Hz at 70 ms each | milestones |
| heads-up | triangle 784 Hz, 90 ms, a 60 ms gap, 784 Hz, 90 ms | heads_up |
| refused | square 220 Hz through a 1200 Hz low-pass, 140 ms, a 70 ms gap, again | refused |
| system | sine 523 Hz then 392 Hz, 100 ms each | system |
| tick | sine 2000 Hz, 30 ms, gain 0.2 | detect, at 300 ms |

- **Toggle.** Sound is in the top bar (`Volume2` / `VolumeX`, label **Sound**, `aria-pressed`) and in the menu. It is on by default and stored in `localStorage` `passbook-scan-sound`.
- **Silent switch.** `navigator.audioSession.type = 'playback'` when present [U]. If the context is `interrupted`, the next tap resumes it.
- **Haptics.** None promised on iOS. The switch-tick trick fires only on tapped decisions (**Let in again**, **Check in** in the confirm step, **Undo**) [U] (R §5.4).

### 7.2 Torch

- **When it shows.** Only when `track.getCapabilities().torch` exists (R-crit 1; iOS Safari has it from 17). It is hidden on the front camera.
- **Control.** `IconButton` labelled **Torch**: `Flashlight` when off, `FlashlightOff` when on, plus `aria-pressed`.
- **State.** On fills it `accent-subtle`. It turns off on pause, End shift and backgrounding.
- **Announcement** (status): "Torch on." / "Torch off."
- **Stand:** in the stage's control row, under the camera.

### 7.3 Switching camera

- **Control.** `IconButton` **Switch camera** (`SwitchCamera`) toggles back and front.
- **Lens choice.** On first permission, enumerate the devices and pick "Back Camera" over "Back Ultra Wide" and the virtual multi-cams (R §5.8.3). Remember the `deviceId` per layout.
- **Specific lens.** The menu offers **Camera** with a radio list of friendly names: **Back**, **Back wide**, **Front**. Raw labels are shown only when the platform gives no friendly mapping.
- **While switching:**
  - the video fades to black (120 ms);
  - after 300 ms, a spinner sits in the reticle;
  - the bottom bar's camera controls are `disabled`;
  - the status reads **Switching camera…**;
  - the buddy looks aside.
- **When the stream is ready:** the video fades in, and the front camera mirrors (`scaleX(-1)` on the video only, never on the overlays).
- **Announcement** (status): "Front camera." / "Back camera."

### 7.4 Camera permission and failures

A panel replaces the viewfinder's video area (same card, same size, so nothing shifts). The rest of the screen keeps working: Look up, the reader and recent scans.

| State | Trigger | Icon in the panel | Headline | Sub | Actions | Buddy | Announcement |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Asking | the iOS prompt is showing | `Camera` | **Allow the camera** | **Safari is asking.** | none | eyes up toward the prompt | status: "Allow the camera." |
| Blocked | `NotAllowedError` | `CameraOff` | **Camera blocked** | **Allow it in Settings › Apps › Safari › Camera.** | **Look up** (primary), **Try again** (outline) | `cover-eyes`, then points to Look up | alert; focus to Look up |
| Blocked, reader present | same | same | **Camera blocked** | same, plus a second line **The reader still works.** | same | same | same |
| Unavailable | `NotReadableError`, `OverconstrainedError` | `CameraOff` | **Camera unavailable** | **Close other apps using it, then try again.** | **Try again** (primary), **Look up** | sad | alert |
| No camera | no video input | `CameraOff` | **No camera** | **Look up passes, or connect a reader.** | **Look up** | flat | status |

**Camera off** is a stand-only menu item, and a button in the stage's control row. It switches to the reader stage and stops the stream, which saves battery. It shows only when the scanner has a reader.

---

## 8. Readers: barcode and NFC (VAS)

### 8.1 Keystroke input

One listener, shared by the Bluetooth barcode readers and the VTAP NFC readers (R §5.8.4, onScan.js rules):

- **A read:** keydown buffered on `document` while no text field has focus. Reset on any gap over 80 ms. Accept on Enter or Tab when the length is at least 4 and the mean gap is under 50 ms. Clear the buffer after each read.
- **In a text field:** in the lookup field, the same timing test runs on `input`. A burst plus Enter counts as a scan: the field clears, the sheet closes, and the code goes to `checking` with `method: 'wedge'`.
- **Slow typing** with no field focused opens Look up with that first character typed in.
- **The method tag** comes from the scanner's reader setting:
  - `nfc` when the scanner is configured with an NFC reader and the value matches the scan-code shape (26 base32 characters, PM §5);
  - `wedge` otherwise.
- **Layout check:** if 3 bursts in a row contain characters outside `[A-Za-z0-9\-_.:/]`, the reader chip turns amber with **Set the keyboard to U.S.** VTAP types a US layout (R §3.4).

### 8.2 Reader chip and stage

| State | Chip (top bar on iPad; status line on phone) | Notes |
| --- | --- | --- |
| No reader configured | none | |
| Ready | `Nfc` or `ScanBarcode`, 14 px, **Reader** | The page has focus and no field is focused. "Ready" means the page is listening, not that a device is connected: the web can't tell (R-crit 2) |
| Paused | amber-subtle pill, **Reader paused** | The window lost focus, or a non-lookup field has focus. A tap on the chip refocuses. Announcement (status): "Reader paused. Tap to resume." |
| Layout wrong | amber-subtle pill, **Set the keyboard to U.S.** | |
| Just read | the chip's icon pops (300 ms bounce) | |

**NFC prompt.** This is the reader stage, on a stand with the camera off, or on a phone with a USB-C reader [U]. It sits in the viewfinder card's place, same size:

- **Surface:** `surface-sunken` with the `Nfc` glyph at 64 px, `fg-muted`.
- **Copy** (HIG wording, "hold near", never "tap" or "NFC"; R §2.1):
  - headline **Hold your iPhone near the reader** (`text-base` 600);
  - sub **Or scan your code at the reader.** (barcode readers) or **Or use the camera.** (camera on).
- **Buddy:** M on the card edge, holding its pocket out toward the reader. Three NFC rings play once on entry and once each time the stage returns from a verdict. They never loop.
- **No-read help:** VTAP fails silently (R-crit 7). After 6 s with no read in a row of activity, a hint swaps in: **Nothing? Show the code to the camera instead.** (camera on) or **Nothing? Unlock the phone and try again.** (camera off; covers `requiresAuthentication`, R §3.1).

**NFC read.**

- The burst completes at D0. The rings stop, and the buddy plays `catch` (pocket opens, squash, lock-on).
- From there the flow is identical to a camera decode: checking, then a verdict.
- The verdict is the same `ScanOutcome`.
- The event's `method` is `nfc`.

Sound and announcement are the same as for a camera scan, with the same timings.

**Camera and reader together** (the stand default when both exist):

- The viewfinder stays.
- A line under it reads **Or hold your iPhone near the reader**, with the `Nfc` icon (barcode readers: **Or scan at the reader**).
- The rings play from that icon.

---

## 9. Manual lookup, confirm, recent scans, undo, check-out

### 9.1 Lookup

**Phone.**

- **Look up** opens a bottom `Sheet` (slides up 260 ms). The video keeps running, but decoding pauses while the sheet is open.
- The field is focused with `data-autofocus`; the keyboard opens.
- The buddy S on the sheet's top edge holds the notepad, its eyes following the caret.

**iPad.** The always-visible field in the side panel. The results list replaces Recent in place (120 ms fade, no movement). Decoding continues: a code scanned while the guest list shows still produces a verdict.

| Part | Content |
| --- | --- |
| Title (phone sheet) | **Look up** |
| Field | `type="search"`, label (visually hidden) **Name, email or code**, the same text as the placeholder, `autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="search"`. 44 px, 16 px text |
| Under 3 characters (not an email, not a code) | help line **Type 3 letters or more.** |
| Searching | after 150 ms, 3 skeleton rows of the final height |
| Results (at most 10, R §4) | `ListRow`: title = holder display title; meta = **{subtitle} · a•••@g•••.com** (masked); trailing = a pill: **In 7:41 PM** (success), **Out 8:12 PM** (neutral) or nothing. Voided or removed rows are muted with a neutral pill **Voided** or **Removed**. Test passes on a test scanner show nothing; on a live scanner they never appear |
| Empty | inline empty, `lens` art at S: **No matches** / **Check the spelling, or use the full email.** |
| Rate limited | inline: **Too many lookups. Try again in 40 s.** with a live countdown; the field is disabled until 0 |
| Network | inline `ErrorState`: **Could not search. Check your connection.**, **Retry** |

Matching rules (server; R §4):

- an exact `scan_code`, or an exact barcode value through `barcode_hash`;
- else a name prefix of at least 3 characters, or a full exact email;
- scoped to the scanner's org, mode and allowed templates, plus the current event when one is picked. **All of today's events** widens it to today's events.

The debounce is 250 ms after typing stops; Enter searches at once. An exact code match with a single result goes straight to confirm.

**Announcements** (status, polite): "4 results." / "No matches." / "Too many lookups. Try again in 40 seconds."

### 9.2 Confirm step

A tap on a result row opens the confirm view in the same sheet: it slides 16 px from the right (wizard step motion). On iPad it opens in the side panel. **Back** returns to the results with the query kept.

```
┌───────────────────────────────────┐
│ ‹ Back                             │
│  ▭▭▭ PassCard still (120 px)       │  barcode hidden
│  Anna Meyer                        │  text-base 600
│  General · Row F, seat 12          │  text-sm
│  Main stage · Fri 7:00 PM          │  text-sm muted
│  [Active] [Test]                   │  status pills (lib/status.ts)
│  In since 7:41 PM · Front door     │  meta, only when already in
│                                    │
│ [          Check in          ]     │  primary, 44 px, bottom (sticky)
└───────────────────────────────────┘
```

| Pass state | Primary | Secondary |
| --- | --- | --- |
| Not in | **Check in** (Out direction: **Check out**) | **Back** |
| Already in | **Let in again** (if allowed), else none | **Back** |
| Voided, removed, expired, wrong event or day, or test/live mismatch | none; the reason shows as a red-tone line with `OctagonX` or amber `TriangleAlert`, using the same copy as the verdict sub | **Back** |

- **The primary** sends the scan with `passId`, `method: 'manual'` and a fresh `idempotencyKey`. The sheet closes at once and the full verdict plays: one outcome component (R §2.2.6).
- **Announcement:** focus goes to the h2 (the holder title) on entry.

### 9.3 Recent scans and undo

- **Phone:**
  - the last-scan row under the viewfinder;
  - a tap on the row body opens **Recent**, a bottom sheet with this shift's last 20 scans;
  - Undo shows on rows inside `UNDO_WINDOW` that were made by this device.
- **iPad:** the side panel's Recent card, last 8.

Row anatomy (`ListRow`):

- **Leading:** a 16 px outcome icon in the outcome's colour role, using the status tones: `success` for ok, `warning` for heads_up, `danger` for refused, `fg-muted` for system.
- **Title:** holder title, or **Unknown code** for not found.
- **Meta:** **Checked in · 7:41 PM** plus a method glyph (`Camera`, `ScanBarcode`, `Nfc`, `Search`), each with a tooltip.
- **Trailing:** **Undo** (ghost `sm`, `Undo2`).

**Undo.**

- **One tap, no confirm.** The row's trailing area swaps (120 ms fade) to a neutral pill **Undone**, and the counter counts down (`CountUp`).
- **Server:** `POST /api/v1/scan/{scanId}/undo`. A check-in undo writes `scan.undone` and frees the pass to check in again. A check-out undo restores "in".
- **A wrong tap** is fixed by scanning again; that's quicker than a dialog at a door.
- **Pending:** the button keeps its width and shows the `Undo2` icon rotating −360° once (an action verb) while the request is pending.
- **Failure:** `toast.error(error, 'Could not undo')`; the row keeps its Undo.
- **Announcement** (status): "Check-in undone. Anna Meyer."
- **After the window:** Undo disappears. An admin can still reverse a scan from the pass's sync log; that's out of door scope.

**Group (bundle).**

- **When it shows:** a checked-in pass that belongs to a bundle with members not yet in (PM §5, `bundle_passes_pass` index).
- **Result card:** a chip **1 of 4 in group**.
- **Recent row:** a trailing action **3 more** (ghost `sm`, `Users`) in place of Undo, for 10 min. Undo stays in the row's menu.
- **Tap:** a confirm sheet **Check in 3 more?** lists the masked titles; primary **Check in 3**.
- **Result:** one verdict: **Checked in** / **3 more from Anna's group** (the sub uses the first member's title).
- **Announcement:** "Checked in 3 more."

### 9.4 Direction and check-out

The In / Out switch shows only when re-entry is on (D9).

- **Phone:** on Start, and in the menu as **Direction: In / Out**.
- **iPad:** a `SegmentedControl` in the top bar, left of the counter.
- **Out mode markers:**
  - the top bar's event button gains a neutral pill **Out**;
  - the reticle corners draw dashed (stroke-dasharray, set at once, no motion), so the mode reads at a glance without colour;
  - the hint becomes **Point at the code to check out**.
- **Verdicts in Out mode:**
  - check-outs are green (**Checked out**);
  - already out or never in are amber (5.3).
- **Counters:** the event counter in Out mode reads **290 in · 22 out** (net in now, plus out).

---

## 10. Counters, shift, end of shift

| Counter | Where | Meaning | Update |
| --- | --- | --- | --- |
| Event | Phone top-bar pill **312/500**; iPad top bar **312 of 500 in**; Start rows | x = unique passes of the picked event checked in and not undone; y = active, not removed, same-mode passes of the event. All events: summed. Re-entry on: **290 in · 22 out**, with y in the shift sheet | Each scan response returns it; poll 10 s while visible; `CountUp` from the last shown value (600 ms, tabular). No animation from 0 on first paint |
| Shift | iPad side-panel footer **You: 128 · since 6:02 PM**; phone shift sheet | This device's ok outcomes this shift, net of undo | local, exact |
| Pending | A badge on the counter pill (absolutely positioned, no shift): **3** in `surface-overlay`; amber after 10 min unsynced | offline queue length | local |

**Shift sheet.** Phone: the event button or the counter pill opens it. iPad: the event button.

- Title **This shift**.
- **312 of 500 in** (stat value, `text-3xl`, `CountUp`), with a 4 px progress bar (`scaleX`, accent) under it.
- Lines (`text-sm`): **You: 128 checked in · 9 refused · 3 undone**, then **Started 6:02 PM · 2 h 41 min**.
- Offline only: **3 waiting to sync** with **Sync now** (ghost, `RefreshCw`).
- **Switch event** (outline, back to the Start picker; the shift continues, and the counters split by event in the summary).
- **End shift** (outline).

**End shift.** No confirm, because nothing is lost.

- **On tap:**
  - it releases the camera, the wake lock and the torch;
  - the summary replaces the page, using the Start card layout.
- **Summary:**
  - h1 **Shift ended**;
  - **128** (stat) with the label **checked in**;
  - lines **9 refused · 3 undone · 4 looked up** and **6:02 PM – 8:43 PM · Front door**;
  - primary **Start new shift**, which returns to Start with the event kept.
- **Pending offline scans:** a warning `Callout` above the actions, **3 scans haven't synced. Keep this page open while online.** The queue survives in IndexedDB; only Unpair drops it, after its own confirm.
- **Buddy:** M, plays `count` (the existing 2.2 s scene; nothing waits on it).
- **Sound:** none.
- **Announcement:** focus to the h1; the stat is in the text.

**Unpair** (menu, last item, danger):

- confirm (`sm` dialog or a bottom sheet) **Unpair this device?**, with the consequence line **You'll need a new code to scan here.**;
- with pending scans, the line adds **3 unsynced scans will be lost.**;
- button **Unpair** (danger).

### 10.1 Menu

The phone's action sheet and the iPad's dropdown share one list. Every item has an icon (`ui-consistency.md`, Page header):

1. **This shift**
2. **Switch event**
3. **Direction: In / Out** (re-entry only)
4. **Sound** (switch)
5. **Keep results until tapped** (switch)
6. **Layout: Handheld / Stand**
7. **Camera** (submenu)
8. **Camera off** (stand with a reader)
9. **End shift**
10. **Unpair this device** (danger), or **Stop scanning as admin** for admins

---

## 11. Offline (opt-in per scanner, check-in only)

**Roster.** On Start, and every 60 s while online, the device fetches the event's roster:

- for every in-scope pass: `sha256(scan_code)` and `sha256(barcode message)`, truncated to 16 bytes, plus `status`, `in` (bool) and `eventKey`;
- no names, no emails (D11).

It is kept in IndexedDB under the scanner id and cleared on Unpair and on a new event. The shift sheet shows **Offline list from 6:58 PM**.

**Offline scan** (navigator offline, a fetch error, or a 5 s timeout while offline is on):

| Local check | Verdict |
| --- | --- |
| Hash in the roster, active, not in, and not in the local queue | green `queued`: **Checked in · Saved offline** (5.3). Queued with `idempotencyKey`, `clientTs`, `method`, `passHash`; the local `in` flag set |
| Already in (roster or queue) | amber **Already checked in**, sub **{time} · this device** or **before 6:58 PM**. **Let in again** queues an override |
| Voided or removed in the roster | red, the same copy |
| Not in the roster | red **Not found**, **Not on the offline list from 6:58 PM.** |
| No roster yet (offline at Start) | slate **No connection**, **Scan again. It won't count twice.** |

**Sync.**

- **When:** on `online`, on visibility, every 15 s while pending, and on **Sync now**.
- **How:** the queue posts in order (`POST /api/v1/scan/sync`, at most 50 per batch). The server accepts with the original time (Ticketmaster model, R §5.6).
- **Conflicts:** another door got there first. These come back as `already_in`. The recent row gets an amber icon and the meta **Was already in · Side door 7:40 PM**, and the shift sheet counts **2 conflicts**. Nothing interrupts the door.
- **The pending badge** counts down and turns amber after 10 min unsynced (R §5.5).
- **Lookup offline:** inline **Look up needs a connection.**

**Limits** (said once, on the admin setting, not at the door):

- The page must be loaded online. There is no service worker yet, so a reload offline fails (PM §7.4).
- Devices can't see each other's offline scans.

---

## 12. Shared with the desk (one implementation each)

| Concept | Component | File |
| --- | --- | --- |
| Shell, top bar, live regions, timing | `ScanShell`, `SCAN_TIMING` | `src/web/scan/shell/*` |
| Verdict | `ScanOutcome` (kind, reason, pass, previous, actions, counter) and the copy map `SCAN_COPY` | `src/web/scan/outcome/*`, `src/shared/copy/scan.ts` |
| Viewfinder, decoder seam, camera panels | `Viewfinder`, `useCamera`, `useDecoder` (injectable for tests, PM §7.8) | `src/web/scan/camera/*` |
| Keystroke input | `useWedge` | `src/web/scan/input/wedge.ts` |
| Sound | `scanSound.play(kind)` | `src/web/scan/sound.ts` |
| Lookup and confirm | `LookupPanel` (sheet or inline), `ConfirmPass` | `src/web/scan/lookup/*` |
| Recent and undo | `RecentScans` | `src/web/scan/recent/*` |
| Pairing | `PairCard` on the hosted card and `CodeField` | `src/web/scan/pair/*`; `CodeField` moves from `portal/` to `ui/` with a `length` prop |
| Buddy beats | `Buddy beat=` | `src/web/ui/art/beats/*` |

Door-only: the event picker, direction, the event counter, offline, the group check-in and the stand layout.

---

## 13. Settings

**Scanner (admin, `/admin/scanners/$id`).** Door-relevant fields:

| Setting | Default | Notes |
| --- | --- | --- |
| Templates | required, at least 1 | the event list comes from these |
| Event | none (staff pick) | pin one event |
| Door window | opens 3 h before start; closes at the end, else start + 6 h | drives not open yet and event ended |
| Re-entry | off | shows In / Out |
| Let in again | on | D10 |
| Ask for a name | off | operator label |
| Keep scanning offline | off | D11 |
| Reader | none / barcode / NFC | chip, stage and method tag |
| Look up | on | name or email search; typed code always works |
| Mode | live | test scanners show the band |

**Device (local, per browser).** Sound, Keep results until tapped, Layout, Camera choice. Device settings never sync to the server.

---

## 14. What the UI needs from the API and data

These are the shapes, for the architecture doc. They follow R §5.8.6 and §5.8.11.

- **`GET /api/v1/scan/me`:** scanner name, org name, mode, the settings above, and the operator requirement.
- **`GET /api/v1/scan/events`:** `[{ eventKey, name, startsAt, endsAt, venue?, timeZone?, templateIds, counter: { in, out?, total } }]`, grouped server-side by `scan.event` inputs (D5). Templates without `scan.event` come back as `{ eventKey: 'tpl:<id>', name: <template name>, anyDay: true }`.
- **`POST /api/v1/scan`:** `{ code | passId, method: camera|wedge|nfc|manual, eventKey, direction: in|out, override?, operator?, idempotencyKey, clientTs }` → `ScanOutcome { kind, reason, scanId, pass?: { id, title, subtitle, templateName, status, mode, stillUrl }, previous?: { at, scannerName, operator? }, event?: { name, startsAt }, window?: { opensAt, closesAt }, cooldownUntil?, counter: { in, out?, total }, group?: { size, in } }`.
  - `stillUrl` is a scanner-scoped asset route, never a download token (PM §5).
  - `pass` is omitted on `not_found`.
- **`POST /api/v1/scan/{scanId}/undo`**, **`POST /api/v1/scan/group/{scanId}`** (check in the rest of the bundle).
- **`GET /api/v1/scan/lookup?q=&eventKey=`:** at most 10 masked rows.
- **`GET /api/v1/scan/roster?eventKey=`** and **`POST /api/v1/scan/sync`** (offline).
- **`POST /api/v1/scan/pair/preview {code}`** (name only, consumes nothing) and **`POST /api/v1/scan/pair {code}`** (sets the device cookie).

Leftovers for the door:

- **`scan_code`:** keep. It is the code in the QR and the NFC message (R §5.7).
- **`barcode_hash`:** keep, for old barcodes (`{{ticketId}}`).
- **`{{pass.scanCode}}`:** keep, and switch the starter event ticket's barcode to it. That stale-reissues its passes (PM §3), so do it before any real event.
- **`scan.*` kinds:** keep. Add `scan.checked_out` and `scan.undone`. Overrides are `scan.checked_in` with `data.override`. heads_up and refused are `scan.rejected` with `data.reason` and `data.kind`. The sync log titles `scan.rejected` as danger; it should show heads_up as warning, which needs a sync-model tweak (`admin/passes/detail/sync-model.ts`).
- **`scanner` actor:** keep.
- **`/scan`, `/admin/scanners`:** replace.
- **0014:** the scan tables, with a unique `(scanner_id, idempotency_key)`.

Never log codes or names (PM §10.32).

---

## 15. Changes to shared files (flag to their owners)

1. `public/_headers` and `platform/security-headers.ts` (foundation, through integration): `camera=(self)`, `'wasm-unsafe-eval'` and `worker-src 'self'` on `/scan` only. Add `/scan` to `NO_REFERRER_PREFIXES` (PM §7).
2. `ui/layout/mode-band.tsx` (n6): an optional `mode` prop.
3. `portal/code-field.tsx` (j) moves to `ui/` with `length`.
4. `ui/art/*` (h0): the `beat` prop, `beats/` and their budget test, and new props (flask, cloud, notepad, rings).
5. `styles/` (h0): `scan.css` verdict tokens, loaded only in the scan chunk.
6. `pass-card` (b): an optional prop that hides the barcode.
7. The template manifest (a2/c): `scan.event { name, startsAt, endsAt?, timeZone? }` next to `scan.actions`.
8. `sync-model.ts` (i): warning tone for heads_up reasons.
9. The bundle budget: everything above is in the lazy `/scan` chunk. The route file and nav entry exist already, so the entry chunk doesn't grow (PM §8).

---

## 16. Acceptance checks

- Verdict colour, icon, headline and tone land in the same frame. The buddy starts 150 ms or more later, lasts 600 ms or less, and a new scan cuts it off.
- The phone, at 390 × 844, in both themes:
  - aiming fits with no scroll;
  - every bottom control has a hit area of 64 px or more;
  - no layout shift on any state change (the CLS check).
- The iPad at 1180 × 820 landscape and 820 × 1180 portrait, and a desktop at 1440.
- At 200 % zoom on 390: the verdict content scrolls inside the wash, with no horizontal scroll.
- Reduced motion: no transform anywhere on `/scan` except `.wl-essential` spinners and rails; fades of 150 ms or less.
- VoiceOver reads each announcement sentence in section 5. On heads_up, focus lands on Done.
- Contrast: verdict text at 6.5:1 or more, and the reticle against white and black scenes.
- Wedge: a burst at 10 ms per character plus Enter checks in. Slow typing opens Look up. A burst in the lookup field counts as a scan.
- Same code: no second request for 5 s (accepted) or 30 s (refused). Two devices scanning one ticket give one ok and one already-in.
- Offline: queued check-ins replay with the same key and never double count. A conflict shows on the row and doesn't interrupt the door.

---

## 17. Open questions for the owner

1. **Offline at the door (D11).** It ships opt-in, without a service worker, so a reload while offline fails. Add a `/scan`-only service worker (it needs `worker-src`, a foundation change), or accept that limit for v1?
2. **The stand's front camera (D16).** Older iPads have the front camera on the short edge, so in landscape the reticle isn't next to it. Acceptable, or should the stand recommend a reader?
3. **Let in again defaults to on (D10).** Keep that, or default it to off for live scanners?
4. **Switching the starter event ticket to `{{pass.scanCode}}`** reissues every existing event-ticket pass (one stale-reissue wave). Do it now, while there are no real events?
