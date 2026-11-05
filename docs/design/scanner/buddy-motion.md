# Scanner buddy: choreography, sound and admin moments

Production motion spec for the buddy on `/scan` (door and desk) and in the admin, from the owner's
direction in `scratchpad/n8b-buddy.md`. A builder implements from this file and the reference
drafts in `docs/design/scanner/buddy-draft/` (`beats.css`, `props.tsx`, `sound.ts`; measured, not final).

Sources, cited as:
- **R**: `research/scanning/report.md` (critic's corrections override its body);
- **PM**: `docs/design/scanner/platform-map.md`;
- **UXD**: `docs/design/scanner/ux-door.md`; **UXK**: `docs/design/scanner/ux-desk.md`;
- **ME**: `next/docs/design/motion-and-expression.md`;
- **BG**: `docs/design/brand-guide.md` (owner checkout, read-only).

File paths are relative to `scratchpad/next` unless they say otherwise.

> **Revision 2026-11-04, owner:** "The 'Voided'/'Invalid' etc should have the buddy shaking his head." Every red
> refusal now plays one beat, **`shake`** (§6.3), with eyes squeezed, brows sad and the pocket passes swinging behind.
> `peek`, `tear`, `sign` and `empty` are retired, with their props (lens, flask plate, the tear). Amber keeps `wrist`.
> Slate ends in a new **`sorry`** pose and never shakes (§6.4). Reference: `docs/design/scanner/b-final/motion/`, the strip
> `docs/design/scanner/b-final/sheets/b-final-strip-refused-{light,dark}.png`, the stills
> `b-final-still-refused-{light,dark}.png` and `docs/design/scanner/b-final/video/b-final-refused-{light,dark}.webm`.

> **Revision 2026-11-04, owner answers:** the two blueprints get their own beats: the **Balance card** plays the new
> **`coins`** (coins drop into the pocket; §6.1, §8) and the **Stamp card** plays `stamp` (the owner's "punches a stamp"; Redeem reward plays `punch`). **M2 fixed:** the
> earliest cut is T0 + 350 (`NEXT_SCAN_AFTER_VERDICT` 350, SA §7.5), as the plan and the head shake already assume;
> §2, §6, §7.5 and §9 follow.

> **Revision 2026-11-05** (stations and Access cards): a new green beat **`gate`** for **Access granted** (§6.1, §8):
> no prop, the gold pass is the barrier arm that lifts and waves the member through; re-entry within the visit gap
> plays it too. Access refusals use the existing `shake` (`guest_expired` also droops the gold pass). New §17: the
> buddy on a **Customer screen** (XL, the scanner's ok beats, `rummage` while the scanner reads, `sorry` and never the
> shake for **Please see the desk**, `wave` on idle) and on a **Desk monitor** (S, one small reaction per 2 s). M8
> gains one bounded loop: the customer `rummage`. Reference sheet: `addendum/access/sheets/access-gate-{light,dark}.png`
> (nine frames, reduced motion, denied, re-entry wait); customer stills `addendum/shots/c-*`.

> **Revision 2026-11-05, later** (occupancy and desk overrides; SA §20, SD §18): two new beats. **`bye`** (§6.1) is
> every exit (**Tapped out**): the teal pass rises like a hand and waves twice; it replaces `dip`. **`relent`** (§6.8)
> is a 150 ms prefix ("oh": eyes pop, sad brows lift, mood sad → happy) that turns a shown refusal into the grant's
> own beat when a desk overrides it on the fly, on the scanner and on its Customer screen. The in/out holds use the
> clock or the tilt, never the shake; **Full** (`capacity_full`) moves from red `shake` to amber `wrist` (fwd). The
> monitor's buddy nods once when its own staff override. Reference: `addendum/occupancy/sheets/occ-flip-*.png`
> (frames of a desk override), `occ-scanner-phone-*.png` (`bye`, holds), `occ-customer-*.png`.

---

## 0. Decisions

| # | Decision | Why |
| --- | --- | --- |
| M1 | **One beat vocabulary for door and desk** (section 6). It replaces the two lists in UXD §6 and UXK §5.3, which disagree on names, timings, moods and budgets (section 13). | One implementation per shared concept (owner direction). |
| M2 | **A result beat starts 150 ms after the verdict and lasts 550 ms, so the buddy is still by T0 + 700 ms.** `BEAT_DELAY` 150, `BEAT_MAX` 550. | n8b "Speed" (≤ 700 ms) read strictly, from the verdict. Colour and tone land first (R §5.4, Scandit's 150 ms). A different code is accepted from T0 + 350 (`NEXT_SCAN_AFTER_VERDICT`, SA §7.5), so the earliest cut lands at 36 % of a beat; §7.5 bounds the snap, and the head shake stays inside it at every frame. |
| M3 | **The cut is a restart in one frame, or an unmount.** No JS timers per beat, no `animationend`, no queued motion (section 7). | n8b "a new scan cuts the current beat off cleanly". |
| M4 | **Mood follows the verdict colour, and happy needs the server.** Green confirmed: happy. Amber: curious. Red and slate: sad. Saved offline: neutral. Undone: flat. | BG "Expressions" and "A buddy's expression must never imply a successful operation before it is confirmed". UXD gave the offline check-in a cheer; that changes to `stash`, neutral. |
| M5 | **Beats, props and chirps live in the scan chunk** (`src/web/scan/buddy/`). Only a small, generic beat API goes into `ui/art`. | The registry scenes have 12 B of headroom (8,948 / 8,960 B gzip, measured on `next/integration` 6687b4d; PM §8). The scanner owns `src/web/scan/**` (next-wave.md n8). |
| M6 | **Reuse before drawing.** `fan` is the `cheer` keyframes at beat speed; `droop`, `wait`, `hello`, `count`, `wave`, `cheer` and `tug` are existing scenes or state parts. New keyframes are 45 small ones. | ME "Reuse"; PM §8 list of scenes to reuse. |
| M12 | **One red beat: the head shake.** Every red refusal plays `shake`; the reason lives in the card's headline, sub and row. Only ME's one-meaning states keep a prop: expired (the gold pass greys and droops) and forbidden or org paused (the lock). Squeezed eyes belong to the red "no" alone. | Owner, 2026-11-04. Fewer props, one reading at the door: "no" is a head shake everywhere. |
| M13 | **Slate apologises.** Our problem ends in the `sorry` pose: eyes up at you, brows raised, passes drawn in, after a small bow. Never a shake, never squeezed eyes. | Owner, 2026-11-04: slate is our fault, not the guest's. |
| M7 | **Props ride inside the buddy's own SVG** through WalletArt's existing slots (`onCard`, `front`, `aside`), not a sibling `<svg>`. | A punch hole must move with the violet pass and a tear with the face; a sibling layer can't follow a part's transform (UXK §2.8 proposed a sibling). |
| M8 | **No loops except the rummage**, which runs only while a lookup is pending (or, on a Customer screen, while the scanner reads, §17, capped at 3 s) and never past 4.7 s. NFC rings play once per trigger. | ME "No ambient loops"; WCAG 2.2.2; UXK's looping `rings` while armed changes to once. |
| M9 | **The buddy never takes a tap on `/scan`.** No click replay, no hover blink, `pointer-events: none`. | UXD §6: a gloved "dismiss" tap must never be eaten. |
| M10 | **Sound: seven chirps and two garnishes, synthesized, on by default.** Rising means yes, falling means no, flat repeats mean "look". | R §5.4, UXD §7.1, UXK §2.7, merged (section 11). |
| M14 | **An exit waves goodbye** (`bye`), green and happy, on the scanner and the Customer screen. | The owner's tap-out; a goodbye reads at a glance and differs from every entry beat. |
| M15 | **A refusal can relent.** When the desk overrides a shown refusal, the buddy plays a 150 ms "oh" (`relent`) and then the grant's beat, all still by T0 + 700 from the override's arrival. The prefix moves eyes and brows only, so it is cut-safe. | "which would change the state and the screen": the change must look like a change of mind, not a new scan. |
| M11 | **Celebrations come from data and never wait.** Device milestones: `fan`, the `reward` chirp and six sparks from the verdict icon. Admin moments reuse `wave`, `cheer`, `count` and the face's `cheer`. | ME Signature 9; BG "no celebratory copy". |

---

## 1. Rules this spec keeps

From ME (The buddy, Scenes, Guardrails), BG (The buddy) and n8b:

- **One buddy in view.** `useRegisterBuddy` counts it. On `/scan` the scan machine owns a single `seat`, so exactly one host renders the buddy (section 3). In the admin, Radix dialogs hide the page's buddy (`art-wallet.css`).
- **Seated on a real bordered surface.** Base on the border line, legs over the edge, contact shadow, `at="end"` on cards with a title at the start. The viewfinder card has a 1 px `border-strong` border (UXD §2.3), so `--wl-seat-border` stays 1 px.
- **Signal.** Colour, icon shape, headline and tone carry every result (R §2.2 rules 1 and 3). The buddy adds to them. It is `aria-hidden` and adds no words.
- **The 5 s rule.** The buddy falls in once per page load (the first seat). It gets one idle beat at 2.4 s after that landing, then it is still. Every later seat is `landed`: no fall and no idle beat. Every other motion answers a scan, a tap or data, and ends within 700 ms of it. Exceptions: `cover` (1.2 s) and `rings` (0.96 s), both triggered, and the rummage (a pending indicator, ≤ 4.7 s). Nothing moves on its own more than 5 s after the event that caused it.
- **Transform and opacity only.** Individual `translate`, `rotate` and `scale` compose with the parts' rest `transform` (as in `scenes/cheer.css`). No layout, no `filter`, no `will-change`.
- **Reduced motion.** No beat runs: `data-run` is never set (`runScene` already returns under reduced motion, `replay.ts`). Each state shows its still (section 10). Mood and prop swaps are instant, except fades of 120 ms or less (allowed, ME Guardrails).
- **Budgets.** ≤ 40 SVG nodes per art; lazy chunk; sizes in section 14.

---

## 2. Architecture

### 2.1 The beat API (shared change in `ui/art`, owner h0)

`Buddy` and `BuddyArt` gain these optional props. Everything else stays in the scan chunk.

| Prop | Renders | Meaning |
| --- | --- | --- |
| `beat?: string` | `data-beat` on `.wl-buddy` | The beat to play. CSS lives in the scan chunk; `ui/art` knows no beat names. |
| `pose?: string` | `data-pose` on `.wl-buddy` | A held state (aim, lock, rummage, pair, note, reader, sleep, card, ask, aside). |
| `dir?: 'fwd' \| 'out'` | `data-dir` | Variant: the clock spins forward (`fwd`); sparks leave the pocket (`out`). |
| `onCard`, `front`, `aside` | passed to `WalletArt` | Prop slots (they exist on `WalletArt` today; `BuddyArt` forwards them). |
| `landed?: boolean` | `WalletArt still` | Already seated: no fall, no idle beat, no mood beat. Beats still run (their selectors outrank `.wl-art[data-still] [data-part]`). |
| `immediate?: boolean` | no `data-replay` | Start the scene or beat at once on mount and on every `replay` change, in a **layout** effect; no IntersectionObserver, no 700 ms landing wait, no click replay, no hover blink. |

Also:
- `replay.ts`: `useScene(auto, again, { immediate })`. With `immediate`, the `again` effect is a `useLayoutEffect` and also runs on mount when a beat or scene is set. `runScene` is unchanged (off, `getBoundingClientRect()`, on).
- `wallet.tsx`: no change. `BODY`, `SCREEN`, `JOY` and the part names are the contract the beats target.

Cost to the art kit: about 120 to 180 B gzip, against 145 B of headroom (15,215 / 15,360 B, measured). If the measured change doesn't fit, raise the kit budget to 15.25 kB with a comment in `art.test.tsx`, as its earlier raises did (lines 302-304).

### 2.2 The scan layer (`src/web/scan/buddy/`, owner n8)

| File | Contents |
| --- | --- |
| `scan-buddy.tsx` | `ScanBuddy`: reads `seat`, `beat`, `pose`, `mood`, `key` from the scan machine; renders `Buddy size at landed immediate scene="scan"` only when its `seat` prop equals the machine's seat; sets `--lx/--ly` and `--gx` through CSSOM (`el.style.setProperty`, CSP-safe, the sign-in precedent in `portal/login-scene.tsx`); calls `sound.cut()` before every new beat. |
| `beat-map.ts` | `BEAT_FOR(outcome)`: `{ beat, mood, pose?, state?, dir?, parts?, prop?, chirp, garnish? }` (red → `shake`; slate → `pose: 'sorry'`) for every reason in section 8. Pure, unit-tested. |
| `beats.css` | Poses and beats (draft: `buddy-draft/beats.css`). Imported by `scan-buddy.tsx`. |
| `props.tsx` | `SCAN_PARTS` (draft: `buddy-draft/props.tsx`). |
| `cover.css` | Optional split of the `cover` act if `beats.css` nears 300 lines. |
| `sound.ts` | Chirps (draft: `buddy-draft/sound.ts`). |
| `*.test.ts(x)` | Section 14. |

The scan chunk also imports `ui/art/wallet-states.tsx` for `HOURGLASS` and the expired droop (`wallet-states.css`). That is a shared lazy chunk with sign-in, already budgeted at ≤ 2.5 kB (`art.test.tsx`). The registry chunk (with `cheer`, `count`, `hello`, `tug`, `common.css`) starts loading with the app (`ui/art/index.ts`, `void preloadArt()`), so reused keyframes are present before the first scan. If it fails to load, beats that reuse it simply don't move; nothing breaks.

### 2.3 Timeline of one scan

D0 is the decode, wedge burst or NFC read. T0 is the verdict commit (UXD §3.4, UXK §5.1).

| t | Buddy | Chrome and sound (owned by UXD/UXK, listed for alignment) |
| --- | --- | --- |
| D0 | `lock` pose (camera) or `catch` beat (wedge, NFC) | Reticle presses, polygon outline |
| D0 + 300 | `rummage` pose, if no verdict yet | Spinner, loading rail, `tick` chirp |
| T0 | Mood, props and seat change in the same commit. The previous beat is cut | Wash 80 ms, icon, headline; main chirp |
| T0 + 150 | Result beat starts (`--wl-beat-at`) | Icon bounce ends at T0 + 300 |
| T0 + 350 | Impact for `punch` and `stamp`; the earliest cut (a different code is accepted) | `click` or `thump` garnish |
| T0 + 700 | Every result beat is at rest | |
| T0 + 1200 | | ok hold ends (`OK_HOLD`) |

---

## 3. Seats

The buddy sits where the result is read. The scan machine holds one `seat`; a seat change is a cut (section 7.2).

| Seat | Door phone | Door iPad (stand) | Desk phone | Desk iPad | Look direction (`pose`) |
| --- | --- | --- | --- | --- | --- |
| **Pair card** | M, end | M (L at ≥ 1024, as sign-in) | same as door | same as door | up at its raised pass (`pair`) |
| **Start card** | M, end | M, end | M, end | M on the stage card | neutral rest |
| **Viewfinder card** (aiming, detected, checking, camera panels, reader stage) | S, end; the 44 px status line is the 11/12 reserve | M, end | S, end | M, on the camera dialog's viewfinder (the dialog hides the stage buddy) | down-left at the reticle centre (`aim`) |
| **Result card** (the verdict) | S, end of the verdict's result card; the sub line keeps 72 px clear | M | S, end of the card sheet | M on the stage card (idle and member card share the slot, so state changes never move it) | down-left at the content (`card`) |
| **Lookup panel** | S on the sheet's top edge, `note` pose with the notepad | none: the stage buddy stays and gazes toward the panel | S on the lookup sheet, `note` | none: the stage buddy gazes toward the rail while the field has focus | follows the caret (`note`) |
| **Summary** (end of shift) | M on the summary card | M | M on the summary sheet | M on the summary sheet | rest |

- **Never under a wash.** The door verdict overlay has its own result card, and the buddy sits on it, above the wash. The desk's phone flood must leave the card sheet's top edge and buddy visible (z-order above the flood), or the flood starts below the sheet's handle row. **Desk to confirm** (UXK §5.1 does not say).
- **System verdicts have no card** (UXD §2.5). Their buddy sits on the footer strip's top edge (`surface-raised`, `rounded-xl`), at the end.
- **Blocking panels** (scanner removed, org suspended, signed out; UXD §4.5) use the Start card seat.
- **Sizes** follow ME The buddy: S in dense chrome (phone viewfinder, verdict card, sheets), M on state cards and the iPad stage.

---

## 4. Moods

| Verdict or state | Mood | Source |
| --- | --- | --- |
| Green, server-confirmed (`ok`) | happy | BG: happy is confirmed only |
| Green, saved offline (`queued`) | neutral | BG: never imply unconfirmed success |
| Amber (`heads_up`) | curious | The research's "third expression" (R §5.8 item 13) is the existing curious brow |
| Red (`refused`) | sad, with the `shake` beat's squeezed eyes | ME Moods: a refusal; owner 2026-11-04 |
| Slate (`system`) | sad brows, in the `sorry` pose (apologetic) | ME Moods: a failure; owner 2026-11-04: ours, so it says sorry |
| Undone | flat | A small reversal, not a failure |
| A slip (wrong pairing code) | flat, with the sign-in `data-shake` | ME Signature 8, sign-in slip |
| Aiming, detected, checking, start, pair, reader, lookup, desk card open | neutral | |
| Shift summary with ≥ 1 ok | happy | |

Mood swaps happen at T0 with the colour, not at the beat. The engine already glides them: body 240 ms, eyes and violet pass 200 ms (`art-wallet.css`, `art.css`).

---

## 5. Poses (held states)

A pose holds while the scanner is in a state. It changes on the engine's transitions (200 ms spring for eyes and the violet pass; `beats.css` adds 200 ms spring on `[data-look]` and `[data-trunk]` translate and rotate). Under reduced motion it changes at once.

| Pose | State | Seat | Mood | What changes (art units, viewBox 96 × 72) | Props | Reduced-motion still |
| --- | --- | --- | --- | --- | --- | --- |
| `aim` | Starting camera, aiming | Viewfinder | neutral | eyes −1.2, +1.4 toward the reticle centre; trunk −3° | none | same pose |
| `ask` | The iOS camera prompt is up | Viewfinder | neutral | eyes up 1.6 | none | same |
| `aside` | Switching camera (UXD §7.3) | Viewfinder | neutral | eyes right 1.6 | none | same |
| `lock` | Detected (D0) | Viewfinder | neutral | eyes `scale(1.25)` and shift toward the code's box: `--lx` = clamp(dx / 160, −1, 1) × 1.6 px, `--ly` = clamp(dy / 160, −1, 1) × 1.4 px, dx and dy from the buddy's eye point (rect left + 50 % width, top + 60.4 % height) to the decoded polygon's centre in viewport px (the page already maps it for the outline; mirrored on the stand) | none | same |
| `rummage` | Checking, from D0 + 300 | Viewfinder (door), stage card (desk iPad) | neutral | eyes down 1.6 into the pocket. **Loop while pending only**: each pass dips 6 and back, 600 ms cycle, phases 0, −200, −400 ms (teal, violet, gold, a ripple); body jigs ±1.5° per 300 ms | none | eyes down, violet pass 4 into the pocket; the `.wl-essential` spinner carries the pending state |
| `pair` | Pair screen; admin pairing dialog | Pair card | neutral | the violet pass up 9 and −10°, like a key card held out; eyes up at it | none | same |
| `note` | Lookup sheet open, or the desk search field focused | Lookup sheet; desk stage | neutral | eyes 1.4 down and `--gx × 1.5px` across, from the shared caret math (`lib/gaze.ts`, section 15); back to rest 1.5 s after the last keystroke or on blur | notepad (phone sheets only) | eyes forward, notepad shown |
| `card` | A verdict or a desk card at rest | Result card | the verdict's | eyes −1, +1.2 toward the content | the beat's end props | same |
| `reader` | Reader stage, desk armed with a reader | Viewfinder (reader stage); desk stage | neutral | trunk 5° toward the reader side (right); eyes right 1.5; the pocket reads as held out | rings, during `rings` only | same, no rings |
| `sorry` | A slate verdict at rest (set with `cloud`, `plug`, `wait`) | Result card | sad brows | eyes `scale(1.1)` and `translate(0, −0.8)`, up at you; brows up 0.5; teal and gold drawn in, +14° and −14° from their rest (to ±16° with the card out) | the slate prop | same |
| `sleep` | Paused (60 s idle on handheld, or back from background) | Viewfinder | neutral | the open eyes fade out and the shut arcs fade in (120 ms opacity); body sinks 1.5 with no transition, in the frame the 30 % dim overlay starts its fade, so it reads as part of the dim | shut-eye arcs | same |

The **pair** pose uses the violet (front) pass, not the teal one UXD §4.2 names: the front pass is the one fully visible and already has the lift transition (`[data-lift]`).

---

## 6. Result and input beats

All result beats start at `--wl-beat-at` (150 ms) and last 550 ms; every time below is **ms from the verdict (T0)**. Input beats start at their trigger (0). "Snap at cut" is the largest jump a cut at T0 + 600 or later shows; a cut between T0 + 350 (the earliest) and T0 + 600 stays inside §7.5's bound. 1 unit = 0.67 px at S, 1 px at M.

### 6.1 Green

**`hop`**: checked in (door), check-in (desk). Happy. No props. Chirp `ok`.

| T0 + ms | Motion |
| --- | --- |
| 150-227 | Crouch: body squash 1.06 × .90; the gold pass sinks 1 |
| 227-337 | Hop 7 up, stretch .96 × 1.06. The gold pass rises 10 and turns upright, like a thumb. Happy arcs widen 1.15 × 1.25 (293-480, `wl-s-cheer-joy`) |
| 337-436 | Lands in a squash 1.07 × .90 at 436. The thumb wiggles to −24° at 392 and back by 458 |
| 436-535 | Rebound .98 × 1.03; the thumb comes down (−4, −6°) |
| 535-612 | Tuck: the gold pass dips 3 into the pocket at 590 with a thunk (1.03 × .97); teal and violet jolt 1.5 at 612 |
| 612-700 | Settle to rest |

Snap at cut: ≤ 2 units.

**`gate`** (2026-11-05): **Access granted** on an access card, including a re-entry within the visit gap. Happy. No
props (the gold pass moves: 0 nodes). Chirp `ok`.

| T0 + ms | Motion |
| --- | --- |
| 150-230 | Anticipation: body squash 1.04 × .96; the gold pass tips down to horizontal across the pocket (the barrier arm: rotate −90° about its lower corner) |
| 230-390 | The arm lifts: the gold pass swings up to +12° past vertical (`--wl-ease-bounce`); the trunk leans 3° toward the door side; eyes look up-left 1.2 |
| 390-520 | Wave-through: the arm dips to 0° and back to +8° once (the "go on" wave); happy arcs widen 1.15 × 1.25 |
| 520-640 | The arm settles to its rest angle; the trunk returns |
| 640-700 | Rest; happy arcs |

Snap at cut: ≤ 2 units (the arm is the gold pass, so a cut snaps it home like any pass). Reduced motion: the end pose
with the arm up at +8°, happy. Customer screens play it at XL.

**`fan`**: a milestone or a reward (section 9). Happy. Chirp `reward`. Six sparks from the verdict icon (`Celebrate`, chrome). The `cheer` keyframes at 550 ms:

| T0 + ms | Motion |
| --- | --- |
| 150-216 | Crouch 1.06 × .90 |
| 216-348 | Hop 10 up; the violet pass rises 14 (from 315); teal and gold swing out ±16° (the fan opens to ±34°); happy arcs widen (293-480) |
| 348-414 | Lands in a squash at 414; the violet pass wiggles −6° at 403 |
| 414-535 | Rebound by 469, settled by 513; violet wiggles +6° at 458, holds high to 535 |
| 535-612 | The pass comes down; the fan closes by 612 |
| 612-700 | Rest |

Snap at cut: ≤ 3 units on the violet pass.

**`punch`**: redeemed (desk), single-use redeem. Happy. Props: a hole and its chad on the violet pass (`onCard`). Chirp `ok`, garnish `click` at 350.

| T0 + ms | Motion |
| --- | --- |
| 0 | Eyes open (the happy arcs wait); eyes look up 1.2 at the pass (216-458) |
| 150-288 | The violet pass lifts 6, presented |
| 315-359 | The press: body squash 1.05 × .93 at 359; the pass pushed to 4 at 348 |
| **350** | **Impact.** The hole pops 0 → 1 (220 ms, `--wl-ease-bounce`); the chad falls 10, turns 90° and fades by 610 |
| 403-535 | The pass back up to 6, then to rest by 535 |
| 480-600 | The right eye winks (`wl-r-blink`, 120 ms) |
| 623-700 | The happy arcs fade in over the open eyes |

End pose: the hole stays on the violet pass while the verdict shows. Snap at cut: none (the chad is gone by 610).

**`stamp`**: stamps added; the Stamp card's beat (owner: "punches a stamp"). Happy. Prop: an ink ring with a star, low on the violet pass (`onCard`). Chirp `ok`, garnish `thump` at 350.

| T0 + ms | Motion |
| --- | --- |
| 0 | Eyes open, look up 1.2 (216-458) |
| 150-288 | The gold pass swings over the violet one (−8, −6; −30° from its 18° rest) |
| 288-348 | It presses down 3; body squash 1.05 × .93 at 359; the violet pass dips 1.5 at 370 |
| **350** | **Impact.** The mark stamps on: scale 1.3 → 1, −12° → 0°, 300 ms bounce (the `Ban` verb's stamp, ME Action verbs) |
| 403-568 | The gold pass lifts and swings back to rest |
| 623-700 | Happy arcs |

End pose: the mark stays. Snap at cut: ≤ 1 unit (the mark's bounce tail).

**`sparkle`**: points added (`dir` none) or spent (`dir="out"`). Happy. Props: three foil sparks (teal, violet, gold) over the fan (`front`). Chirp `ok`.

| T0 + ms | Motion |
| --- | --- |
| 150-450, 210-510, 270-570 | Each spark appears (.6 → 1), falls 24 into the pocket and fades at the pocket's mouth, 60 ms apart. Spent: reversed, they rise out and fade above |
| 205-590 | Eyes up 1.4, then down 1 following the sparks, back by 590 |
| 546-623 | The pocket gulps: squash 1.06 × .94, rebound |
| 623-700 | Happy arcs |

The number in the card counts up from the old value (600 ms, `useRememberedCount` pattern) at T0: that is the "count ticks up" n8b asks for. N is never drawn in the art (BG: no text); three sparks stand for any N. Snap at cut: ≤ 1 unit.

**`coins`**: a money input changed (the Balance card's Charge, Top up and Set balance). Happy. Props: three gold coins over the fan (`front`), plain discs with an edge highlight, no symbol (BG: no text). Chirp `ok`. The `sparkle` track with coins for sparks: each coin appears (.6 → 1) and drops 24 into the pocket (150-450, 210-510, 270-570), turning edge-on (`scaleX` 1 → .3) at the pocket's mouth; the pocket gulps at 546-623 (squash 1.06 × .94, rebound); happy arcs 623-700. `dir="out"` when the balance falls (Charge, a lower set): reversed, the coins rise out and fade above. The number counts as for `sparkle`. Snap at cut: ≤ 1 unit; coins in flight vanish with the cut.

**`nod`**: points set. Happy. Squash 1.04 × .96 at 270 and a blink 270-410; rest by 450. Chirp `ok`.

**`bye`** (2026-11-05 later; replaces `dip`): every exit, **Tapped out** and **Checked out**. Happy. No prop (the teal
pass is the hand). Chirp `ok`.

| T0 + ms | Motion |
| --- | --- |
| 150-260 | The teal pass rises to −52° (34° past its rest, inside §7.5's 36°), like a hand; the trunk leans 3° toward the exit; eyes up-right 1.2 |
| 260-410 | First wave: −52° → −38° → −52°; two motion lines fade in beside it |
| 410-560 | Second wave |
| 560-700 | The hand comes down to rest; lines fade; happy arcs |

Snap at cut: ≤ 34° on the teal pass (inside the 36° bound), ≤ 1 unit on the body. Reduced motion: the hand up at −52°
with the lines, happy. Customer screens play it at XL. `dip` is retired with its keyframes.

**`stash`**: saved offline (door `queued`). **Neutral** (M4). Prop: the clock (`aside`). The clock pops onto the surface at its left (150-350, bounce); the gold pass rises like a thumb and tucks away (the `hop` thumb track, no hop); teal and violet jolt at 612. Chirp `ok` (the scan was taken). End pose: the clock stays.

### 6.2 Amber

**`wrist`**: already in, already out, already redeemed, wrong day, not open yet, event ended, cooldown, stale (UXK). Curious. Prop: a clock on the surface at its left (`aside`). Chirp `headsUp`.

| T0 + ms | Motion |
| --- | --- |
| 150-350 | The clock pops onto the surface (scale 0 → 1, bounce) |
| 150-249 | Trunk leans 4° toward it; brow lifts 1.2 |
| 270-570 | The minute hand spins one full turn: **backward** for "already" (it happened earlier), **forward** (`dir="fwd"`) for not open, ended, cooldown and wrong day (it's about later). Spring |
| 270-381 | First tap: the teal pass swings down onto the clock (−30°, −2, +14) and back |
| 403-568 | Second tap |
| 535-700 | Trunk upright; the brow settles to the curious rest |

End pose: curious, the clock beside it. n8b's "taps its wrist": the buddy has no wrists, so it taps its clock with a pass. Snap at cut: none.

**`tilt`**: not checked in or not tapped in (`not_inside`: an exit with no entry, or a zone whose parent needs a tap-in first). Curious. Head tilt: trunk 8° at 285, held to 465, back by 600. Chirp `headsUp`.

### 6.3 Red: the head shake

**`shake`**: every red refusal (section 8): voided, removed, not found (and another org's code), ambiguous,
replaced, wrong event, expired, not valid yet, test/live mismatch, not accepted here, not enough stamps or
points, forbidden, organization paused. (Capacity left this list 2026-11-05 later: **Full** is amber `wrist` fwd.) Sad. Chirp `refused`. No prop, except the two ME states: **expired** sets
`WalletArt state="expired"` at T0 (the gold pass greys and droops 18° past the fan, one meaning everywhere), and
**forbidden** and **organization paused** stand the lock beside it (`prop={<LockArt size="sm" />}`, the shackle
drops, 200 ms bounce). A forbidden answer to a tapped desk action also shakes that button (240 ms, ME Failure).

A side-to-side "no". The trunk turns on its planted feet (pivot 48, 66, so the legs stay put), the face leads the
turn (the look group slides across the pocket's screen, which reads as the head turning), the eyes are squeezed shut
and the sad brows pinch down for the whole "no". The teal and gold passes swing a beat (45 ms) behind each turn, about
the pocket (48, 58), then settle. It starts at `--wl-beat-at` (150), runs 550 ms with `ease-in-out` between keys, and
is still by T0 + 700.

| T0 + ms | % | Trunk `rotate` | Look `translate` | Eyes `scale` | Brows `translate` | Body `translate`, `scale` | Fan `rotate` (rel.) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0-150 | delay | 0 | 0, 0 | 1 (sad rest) | 0, 0 | 0, 0 · 1 (sad rest) | 0 |
| 180 | 5.5 | 0 | 0, 0.29 | **1.12, 0.28** shut | **0, 0.8** pinched | 0, 0.76 · 1.03, 0.96 | 0 |
| 185 | 6.4 | **0** | **0, 0.3** | shut | pinched | **0, 0.8 · 1.03, 0.96** wince | **0** |
| 230 | 14.5 | −5.6° | **−2.4, 0.3** face leads | shut | pinched | 0, 0.06 · 1 | +4.2° |
| 240 | 16.4 | **−6°** "no" left | −2.28, 0.3 | shut | pinched | **0, 0 · 1** | **+4.5°** lagging |
| 285 | 24.5 | −0.3° | +0.76, 0.3 | shut | pinched | rest | **−6°** swings past |
| 320 | 30.9 | +5.2° | **+2.2, 0.3** | shut | pinched | rest | −2.2° |
| 330 | 32.7 | **+5.5°** "no" right | +2.11, 0.3 | shut | pinched | rest | 0° |
| 350 | 36.4 | +4.6° | +1.37, 0.28 | shut | pinched | rest | +4.1° |
| 375 | 40.9 | +1° | −0.26, 0.23 | shut | pinched | rest | **+6°** |
| 410 | 47.3 | −3.3° | **−1.4, 0.2** | shut | pinched | rest | +2.9° |
| 420 | 49.1 | **−3.5°** | −1.34, 0.2 | shut | pinched | rest | +1° |
| 465 | 57.3 | −0.5° | +0.19, 0.12 | shut | pinched | rest | **−4°** |
| 490 | 61.8 | +1.3° | **+0.6, 0.1** | shut | pinched | rest | −2.8° |
| 500 | 63.6 | **+1.5°** | +0.57, 0.1 | shut | pinched | rest | −1.6° |
| 545 | 71.8 | +0.4° | +0.05, 0 | shut | pinched | rest | **+2°** |
| 550 | 72.7 | +0.2° | 0, 0 | **1.12, 0.28** opening | **0, 0.8** | rest | +2° |
| 560 | 74.5 | 0° | **0, 0** | 1.11, 0.35 | 0, 0.77 | rest | +1.7° |
| 568 | 76 | **0°** trunk still | 0, 0 | 1.09, 0.51 | 0, 0.69 | **0, 0 · 1** | +1.3° |
| 600 | 81.8 | 0° | 0, 0 | **1, 1.12** pop open | 0, 0.14 | 0, −0.71 · .99, 1.02 exhale | −0.7° |
| 610 | 83.6 | 0° | 0, 0 | 1, 1.11 | 0, 0.03 | **0, −0.8 · .99, 1.02** | **−0.8°** |
| 620 | 85.5 | 0° | 0, 0 | 1, 1.08 | **0, 0** | 0, −0.78 · .99, 1.02 | −0.8° |
| 650 | 90.9 | 0° | 0, 0 | **1** | 0, 0 | 0, −0.47 · .99, 1.01 | −0.5° |
| **700** | 100 | **0°** | **0, 0** | **1** (sad rest) | **0, 0** | **0, 0 · 1** (sad rest) | **0°** |

Bold values are keyframes (`beats.css`: `wl-b-shake`, `-look`, `-eyes`, `-brow`, `-body`, `-fan`); the rest are the
eased values, sampled from the mock with `getComputedStyle` (what the strip shows).
Rotations are about the art's view box (`transform-box: view-box`); eyes scale about
their own centre (`fill-box`). Units are the art's (viewBox 96 × 72): 1 unit = 2 px at XL (the B dock seat), 0.67 px
at S. The fan's relative angle is the follow-through: in world terms the passes peak at −6.3° at 285 and +7° at 375,
45 ms after the trunk's −6° at 240 and +5.5° at 330, then −4.5° at 465 and +2.4° at 545.

All `translate`, `rotate` and `scale` are the individual properties, so they compose with the mood's rest transforms
(sad eyes `translateY(0.7) scaleY(0.8)`, the passes' fan angles, `card="out"`). The `card` pose's look offset is the
implicit 0 % and 100 %.

**Cut-safe at every frame.** Every track stays within the snap bound of §7.5 for the whole beat: trunk ≤ 6°, fan
≤ 6° relative, look ≤ 2.4 units, body ≤ 0.8 units. A different code accepted at T0 + 350 (`NEXT_SCAN_AFTER_VERDICT`
in the plan's revision) lands mid-swing, and the next frame paints the new beat's 0 % (its mood's rest), with no
easing out: at most a 6° jump of the trunk, inside the same frame as the card swap and the new tint. A refusal after
a refusal restarts the shake from 0 % (`data-run` off, a layout read, on). Squeezed eyes snap open on a cut; that is
the one visible jump and it reads as the next look.

End pose: the sad rest, eyes open, with the expired state or the lock where they apply. Snap at T0 + 600: ≤ 0.7°
(fan) and 0.71 units (body); at T0 + 350: 4.6° (trunk), 4.1° (fan), 1.4 units (look).

Reference: `docs/design/scanner/b-final/motion/shake.css` (B's mock selectors) and `buddy-draft/beats.css` (production
selectors), frames in `docs/design/scanner/b-final/sheets/b-final-strip-refused-{light,dark}.png`.

**Retired by this revision:** `peek` (lens and shrug), `tear` (the `TEAR` drop), `sign` (the flask plate), `empty`,
and `wrist dir="fwd"` in red. The lens and plate props leave `props.tsx`; `TEAR` stays in `ui/art` for the admin's
`tear` scene only. `droop` stays for non-verdicts (an expired pairing code).

### 6.4 Slate: sorry, never a shake

Slate is our problem, so the buddy apologises: every slate beat ends in the `sorry` pose (§5), set by `ScanBuddy`
with the beat. Sad brows raised, eyes open and a little wide, looking up at you, the outer passes drawn in like hands.
No shake, no squeezed eyes (those mean "no" to the guest).

| T0 + ms | Motion (all slate beats) |
| --- | --- |
| 150-350 | The beat's prop arrives (below) |
| 350-450 | A small bow: body `translate(0, 1.6) scale(1.01, 0.97)`; eyes dip 0.8 (`cloud` and `wait`; `plug` keeps its flinch instead) |
| 450-560 | Up from the bow; the eyes rise to −0.8 (at you), widen to 1.1; teal +14°, gold −14° (drawn in); brows up 0.5 |
| 560-700 | Holds the `sorry` pose |

**`cloud`**: no connection, no answer (timeout), not confirmed. Prop: one cloud path on the surface at its left, like
the clock (`aside`), matching the `CloudOff` and `CloudAlert` icons. Over its head it would cover the B card's bottom
edge. It drifts down 6 into place and fades in (150-550, spring). End pose: `sorry`, the cloud beside it. Chirp
`system`.

**`plug`**: something went wrong (5xx). Prop: `UnpluggedArt size="sm"` beside it (ME: error is the plug). The prop
mounts at T0 and plays its own entrance (the plug drops 8 away, the spark flickers, T0 + 80 to 380). The buddy
flinches at 271-326 (1.5 right, 1 down, .97 × 1.02) with its eyes **wide** (`wl-b-widen`, no longer squeezed),
recovers by 425, then the `sorry` look. Chirp `system`.

**`wait`**: too many scans or lookups (429). Prop: `HOURGLASS` (`aside`, wallet-states.tsx); it flips in on the
surface at its left (rotate −180° → 0, 400 ms spring, 150-550; the engine's `wl-a-in` with the part's own `--f`).
Then the bow and `sorry`. Chirp `system`. The countdown is text only (UXD §5.3).

### 6.5 Neutral and flat

**`rewind`**: an action undone. Flat. The violet pass pops up 6 at 310, drops to 1 below rest at 450, rest by 550. Chirp `undo`.

**`glance`** (input, at 0): the desk card opens after a lookup or a scan in choose mode (UXK §5.3). Neutral. Eyes widen 1.2 at 105, back by 300. No chirp ("only answers make noise", UXK §2.7).

### 6.6 Input and pending

**`catch`** (at the read, D0): a wedge burst or an NFC read. Neutral. The violet pass drops into the fan from 14 above, fading in over its first 80 ms, landing at 260; the body nods (1.04 × .96) 160-420. Then the `lock` pose (no box: eyes to the centre), then `rummage` at D0 + 300 if still checking. n8b's "on read, it catches the pass". No chirp: hardware readers beep themselves.

**`rings`** (once per trigger): the reader stage appears; a verdict returns to the reader stage; the desk is armed. Neutral, `reader` pose. Two arcs from the pocket toward the reader side: ring 1 at 0-640, ring 2 at 320-960, each scale .6 → 1.5 and opacity .7 → 0, ease-out (the `Stethoscope` verb's 640 ms and 320 ms, ME Action verbs). **Never loops** (M8): the Reader chip and the copy hold the armed state.

**`wake`** (on the tap that leaves Paused): the eyes open (scaleY 0 → 1, 140 ms) and a nod (300 ms).

**`hint`** (the first hint of a shift only, at 4 s): the trunk leans 4° toward the reticle and back, 400 ms. Later hints are text only (5 s rule; UXD §5.2 asked for a lean on every hint).

### 6.7 Camera blocked: `cover`

Not a scan result, so it is not bound to 700 ms; it is bound to ME's scene rules (once, done within 5 s, ends at rest). It starts at once on the viewfinder seat when the buddy has landed, or 700 ms after the fall on a first mount. Flat (a setting the person can fix). 1.2 s. Props: two small passes (teal, gold) in `front`.

| ms | Motion |
| --- | --- |
| 0-240 | Teal and gold dip behind the pocket (16 down) as two small passes rise in front of the eyes, 40 ms apart |
| 480-624 | A peek: the left one slides aside (2, 3) and back |
| 744-912 | The small passes drop and fade; the fan's passes come back up |
| 912-1032 | The teal pass points down-left, toward **Look up** / **Search** (−34°); eyes follow |
| 1032-1152 | Holds the point |
| 1152-1200 | Rest |

n8b's "covers its eyes with its passes": the fan sits behind the pocket, so the passes can't reach the face. Two small passes in `front` read as the same passes moving forward. Other camera panels (UXD §7.4): **Unavailable** is sad with no beat; **No camera** is flat with no beat; **Asking** is the `ask` pose.

### 6.8 Override: `relent` (2026-11-05 later)

A desk override reaches a scanner whose refused or held card is still up (or is its latest verdict, under 60 s old):
the card turns green in place (SD §18.2) and the buddy changes its mind. `relent` is a prefix in the result beat's own
150 ms delay; T0 is the override's arrival, not the original scan.

| T0 + ms | Motion |
| --- | --- |
| 0-60 | "Oh": eyes pop to 1.06 × 1.22 and up 0.6; sad brows lift 1 unit; body 0.99 × 1.02 |
| 60-150 | Mood sad → happy (120 ms fade, ME's allowance) |
| 150-700 | the grant's beat: `gate` (access) or `hop` (event check-in), as §6.1 |

- Cut-safe: before 150 only eyes and brows move; a cut snaps them home in one frame. A shake still running when the
  override lands is cut first (§7), so the prefix starts from the still "no" at worst.
- Reduced motion: the destination's end pose at once (gate arm up, happy).
- Customer screens: from `sorry`, the same prefix, then `gate` at XL, as the slate card tucks and the green one rises.
- Only on the device the override answers. When the card is gone (the strip row turns green instead), no beat: the
  buddy never reacts to an old scan over the next person.
- Chirp: `ok` at 150 on the scanner; none on Customer screens (§17.1).

---

## 7. The cut

### 7.1 Same seat (the iPad stage, the desk card, a verdict replacing a verdict)

In one React commit, `ScanBuddy`:
1. calls `sound.cut()` (every live voice ramps to 0 over 8 ms);
2. renders the new `mood`, `state`, `beat`, `pose`, `dir` and props;
3. in its layout effect, removes `data-run`, reads `getBoundingClientRect()`, and sets `data-run` again (`runScene`).

The first painted frame shows the new verdict, with the buddy at the new beat's 0 % keyframe. That is the rest pose of the new mood, held by `animation-fill-mode: backwards` through the 150 ms delay. The old beat's mid-pose is never painted again. Its props unmount in the same commit, because props render per beat.

### 7.2 Seat change (phone: viewfinder ↔ verdict card, sheets)

The machine's `seat` changes. The old host's `ScanBuddy` returns `null` in the same commit, so its buddy never shares a frame with the new one. The new host mounts the buddy `landed` and `immediate`, with its pose or beat. On the door phone, the verdict's result card rises 8 px over 200 ms with the buddy on it. When the verdict exits (wash fade 120 ms), the verdict's buddy is already gone, and the viewfinder buddy is back in its `aim` pose.

### 7.3 Pending to verdict

The commit that sets the beat also clears `pose="rummage"`, so the loop ends and the beat starts in the same frame.

### 7.4 What a cut leaves behind

Nothing:
- no `setTimeout` per beat: delays are CSS, and `useScanMachine` owns the only timers (tick, holds);
- no `animationend` listeners;
- no `fill-mode: forwards`;
- audio garnishes are cancelled.

### 7.5 Snap bound

Every result beat keeps the body within 10 units of rest and the passes within 36°. The earliest cut is T0 + 350: a beat that would jump past that bound eases to rest in 120 ms instead (plan BU.3). At T0 + 600, the largest leftover displacement is 3 units (the `fan` violet pass), 2 px at S. `shake` is stricter: it stays within 6° and 3 units at **every** frame (§6.3), so a cut at T0 + 350 needs no ease-out. This is tested (section 14).

---

## 8. Reason to beat map (`beat-map.ts`)

One table for door (UXD §5.3) and desk (UXK §6). Every reason gets a colour, a mood, a beat and a chirp. Holds are UXD/UXK's. The rule behind it: **red shakes, amber taps its clock, slate says sorry.** `beat-map.ts` derives the red beat from the colour, so a new red reason shakes without a new row.

| Reason | Colour | Mood | Beat | Props | Chirp |
| --- | --- | --- | --- | --- | --- |
| `checked_in` (+ re-entry, + override) | green | happy | `hop` | | `ok` |
| `checked_out`, tapped out (every exit, zones and events) | green | happy | `bye` | | `ok` |
| let in by the desk (an override reaching the refusing device, §6.8) | green | sad → happy | `relent` + `gate` (`hop` on events) | | `ok` |
| access granted (`outcome.access` set; + re-entry in the gap, + override) | green | happy | `gate` | | `ok` |
| `zone_not_included`, `outside_hours`, `guest_visits_used`, `suspended`; `not_yet_valid` on access | red | sad | `shake` | | `refused` |
| `guest_expired` | red | sad | `shake` | (state `expired`) | `refused` |
| `queued` (saved offline) | green | neutral | `stash` | clock | `ok` |
| stamps added | green | happy | `stamp` | stamp | `ok` + `thump` |
| points added / spent | green | happy | `sparkle` / `sparkle dir="out"` | sparks | `ok` |
| money added / taken / set (Balance card: Top up, Charge, Set balance) | green | happy | `coins` (in on a rise) / `coins dir="out"` (on a fall) | coins | `ok` |
| points set | green | happy | `nod` | | `ok` |
| redeemed (`use_up`, or a `take` that spends a goal: the Stamp card's Redeem reward) | green | happy | `punch` | hole, chad | `ok` + `click` |
| goal reached, reward ready | green | happy | `fan` + six sparks | | `reward` |
| milestone (section 9) | green | happy | `fan` + six sparks | | `reward` |
| undone | neutral | flat | `rewind` | | `undo` |
| `already_in`, `already_out`, already redeemed, stale; `still_inside` (Already in, and the Auto turnaround); `not_inside` after an Auto exit (Already out) | amber | curious | `wrist` (back) | clock | `headsUp` |
| `capacity_full` (**{place} full**; was red) | amber | curious | `wrist dir="fwd"` | clock | `headsUp` |
| `wrong_day`, `not_open`, `event_ended`, `cooldown` | amber | curious | `wrist dir="fwd"` | clock | `headsUp` |
| `not_in`; `not_inside` (no entry at an exit, or the parent first) | amber | curious | `tilt` | | `headsUp` |
| can't undo | amber | curious | `wrist` (back) | clock | `headsUp` |
| `voided`, `removed` | red | sad | `shake` | | `refused` |
| `not_found` (+ another org's code), `ambiguous`, replaced | red | sad | `shake` | | `refused` |
| `wrong_event` | red | sad | `shake` | | `refused` |
| `expired` | red | sad | `shake` | (state `expired`: the gold pass grey and drooped) | `refused` |
| `not_yet_valid` | red | sad | `shake` | | `refused` |
| `test_pass`, `live_pass` (test/live mismatch) | red | sad | `shake` | | `refused` |
| `template_not_allowed` (not accepted here) | red | sad | `shake` | | `refused` |
| `no_balance` | red | sad | `shake` | | `refused` |
| `forbidden`, `org_inactive` | red | sad | `shake` | `LockArt` S beside it | `refused` |
| `network`, `timeout`, `unsure` | slate | sad, pose `sorry` | `cloud` | cloud (aside) | `system` |
| `server` | slate | sad, pose `sorry` | `plug` | `UnpluggedArt` S | `system` |
| `rate_limited` | slate | sad, pose `sorry` | `wait` | hourglass | `system` |
| same code within the ignore window | none | unchanged | none | | none |

Not verdicts:

| Moment | Seat | Mood | Motion | Chirp |
| --- | --- | --- | --- | --- |
| Pair screen | Pair card | neutral | `pair` pose; the first-landing idle beat | |
| Wrong pairing code | Pair card | flat | the sign-in slip: `data-shake` on the art, 240 ms | |
| Pairing code expired or used | Pair card | sad | `droop` (state `expired`) | |
| Pairing rate limited | Pair card | sad | `wait` | |
| Pairing offline | Pair card | sad | `cloud` | |
| Paired | Pair card (it stays while the card flips to Start) | happy | `hello` (existing scene, about 1 s, `immediate`) | `ok` (the Pair tap unlocked audio) |
| Scanner removed, org suspended | Start-card seat on the slate panel | sad | `tug` (existing scene, 2.8 s; nothing waits) with `LockArt` | |
| Signed out (admin shift) | same | sad | none | |
| Locked desk action tapped | Desk stage | sad | `tug` (existing scene) | |

---

## 9. Milestones and the end of shift

### 9.1 On the device

| Milestone | Who decides | Once per | Where it shows |
| --- | --- | --- | --- |
| Event count reaches a multiple of 100 (UXD §5.3) | Server: the check-in whose increment crossed it gets `milestone: 'count'` in its outcome | event and threshold | that device only |
| Everyone's in (x of y = y) | Server, same transaction: `milestone: 'all_in'` | event | that device only |
| Reward ready (goal reached; UXK §6.13) | Server: the apply that reached the goal | pass and reward | that device |
| This device's 100th ok of the day (UXK §6.13) | Client: the device counter | device and day | that device |

The server decides the shared milestones in the same atomic step as the counter, so two doors can never both celebrate the 100th (contract field `milestone?` on `ScanOutcome`, `src/shared/contracts/scan.ts`; tell the architecture spec).

The celebration:
- The verdict is the normal green one. It never extends the hold, and a next scan from T0 + 350 replaces it.
- `fan` (6.1), the bigger sibling of `hop`: a 10-unit hop, the fan open to ±34°, the violet pass up 14.
- `Celebrate` (six foil sparks, 640 ms, 40 ms apart; `ui/celebrate.tsx`) bursts from the verdict icon at T0. On the door phone the icon is the only counter-adjacent thing in view, because the overlay covers the top bar's counter pill. On the desk it's the band's check glyph (a reached goal keeps the check; there is no `Gift`). Re-key `Celebrate` per milestone (`key={outcome.scanId}`), because it plays once per mount.
- Chirp `reward` instead of `ok`.
- No words (BG "no celebratory copy").
- Reduced motion: green, the happy still, no sparks, the chirp still plays.

### 9.2 End of shift (the count scene)

- **Trigger:** **End shift** (UXD §10, UXK §6). The summary replaces the page (door) or opens a sheet (desk).
- **Seat:** the summary card's top edge, M, at the end, `landed`. No second fall: the buddy fell once per page load.
- **Scene:** the existing `count` (2.2 s; ME My passes), started `immediate` as the summary paints.
  - The stat counts up from 0 over 600 ms at the same time.
  - The buddy's three passes pop up in turn (130-1170).
  - It hops with the fan spread (1170-1890), after the number has settled, so it reads as counting along.
- **Mood:** happy with at least one ok; flat with none, and then no scene (nothing counts 0 → 0, ME Numbers).
- **Sound:** none (UXD §10).
- **Reduced motion:** the happy or flat still, and the numbers show their values.
- **"Start new shift":** returns to Start. The buddy stays landed, neutral.

---

## 10. Reduced-motion stills

No `data-run` is ever set, so no beat runs. Each state shows its end pose with its props, except red, which holds a still "no" so the refusal still reads as one without motion:

| State | Still |
| --- | --- |
| Aiming, detected, checking, reader | the pose (`aim`, `lock`, `rummage` static, `reader`); no rings |
| `hop`, `fan`, `nod` | happy rest |
| `bye` | happy, the teal pass up at −52° with the two motion lines |
| `relent` | the destination's end pose (gate arm up, happy) |
| `punch` | happy, the hole in the violet pass |
| `stamp` | happy, the stamp mark |
| `sparkle` | happy (no sparks; the number shows its value at once) |
| `coins` | happy (no coins; the amount shows its value at once) |
| `stash` | neutral, the clock beside it |
| `rewind` | flat rest |
| `wrist`, `tilt` | curious, the clock (`wrist`) |
| `shake` (every red) | **the still "no"**: trunk `rotate(−4°)`, look `translate(−1.8, 0.3)`, eyes `scale(1.12, 0.28)` (shut), brows `translate(0, 0.8)` (pinched), fan `rotate(4°)` (the passes hang the other way, as if just swung). Plus the expired state or the lock where they apply |
| `droop` (expired pairing code) | sad, the expired state (gold pass grey and drooped) |
| `cloud`, `plug`, `wait` | the `sorry` pose, with the cloud, the plug or the hourglass |
| `cover` | flat rest, eyes down-left toward Look up |
| `sleep` | eyes shut (an opacity swap under 150 ms) |
| `pair`, `note` | the pose with its pass or notepad; eyes forward |
| `count`, `hello`, `wave`, `cheer`, `tug` | their scenes' final poses (ME) |

Admin moments under reduced motion are listed in section 11.

---

## 11. Admin moments

Admin is silent: no sound outside `/scan`. Each moment follows ME: from data, on screen, once; one buddy per view.

### 11.1 Scanner paired (`/admin/scanners`, create-and-pair dialog; owner n8)

- **Waiting:**
  - The dialog shows the pairing QR and the 8-digit code (UXD §4.2 and §13) on a bordered panel.
  - The buddy M sits on that panel's top edge at the end, in the **`pair` pose**, neutral. It is the same key-card pose as on the device, so both ends of pairing look alike.
  - It falls in once as the dialog opens; one idle beat at 2.4 s; then still.
  - The dialog's buddy hides the page's (`art-wallet.css`).
- **Detect:** while the dialog is open, the tab is visible and the code is unexpired, poll the scanner every 3 s (`refetchInterval`; stop when hidden).
- **Paired** (`pairedAt` appears):
  - The panel content crossfades (160 ms) to **Paired** with the device line.
  - The buddy turns happy and plays **`wave`** at once (existing scene, 1.8 s, `immediate`: it has already landed).
  - The new row behind the dialog gets the insert highlight (ME Row inserted).
  - No toast: the dialog says it, and a toast would show only a check while the buddy is in view.
- **Code expired while open:** sad, the expired droop (`droop`), with **New code** in the panel.
- **Reduced motion:** happy still, no wave.

### 11.2 First scan of an event (the door card; owner n8)

- **Where:** the event's door card: **Checked in · x of y** with a progress bar.
  - Shown on the scanner detail page and on the event template's page, wherever the admin UX places it.
  - The card is the page's buddy host: other empty states on that page use the inline empty state, without a buddy.
- **Seat:** S on the card's top edge at the end. While x = 0 it waits, neutral, with eyes on the number (the `card` pose). The card reads **No check-ins yet**.
- **Detect:** the card refetches every 10 s while visible (UXD `COUNTER_POLL`).
- **The first check-in, seen live** (a refetch moves x from 0 to 1 or more while the card is on screen; never on the first load):
  - The number counts up (600 ms).
  - The bar grows (`scaleX`, 600 ms ease-out, transform only).
  - `Celebrate` bursts from the number.
  - The buddy turns happy and plays **`cheer`** (existing, 1.8 s, `immediate`).
- **Everyone's in, seen live** (x reaches y): `Celebrate` from the number, and the buddy plays **`count`** (2.2 s).
- **Once:** per event per browser session (an in-memory set keyed by event id). A revisit after the fact shows the happy still with no scene: "cached revisits never re-enter" (ME Motion follows data).
- **Reduced motion:** the values show at once; happy still; no sparks.

### 11.3 Dashboard milestone (admin overview KPI tile; owner h)

- **Where:** the overview's scan tile (**Check-ins** or **Scans**, once metrics carry scan totals; PM §10 gap 25). Tiles are dense, so there is no seated buddy here.
- **Trigger:** the tile's remembered count (`admin/overview/count.ts`, `useRememberedCount`) crosses a threshold on screen.
  - Thresholds: 100, 500, 1,000, 5,000, 10,000, then every 10,000.
  - The test is `prev < T ≤ value`, where `prev` is the value this tile showed earlier in the session.
  - The first visit of a session never celebrates: it counts from 0 and would cross every threshold.
- **Motion:**
  - `Celebrate` from the value.
  - The tile's `EntityIcon` swaps (120 ms opacity) to **`BuddyFace size="sm" scene="cheer"`**: a squash and hop, the gold pass up like a thumb, a wink; 1.4 s (ME face: cheer).
  - The face stays for the rest of the view, then the icon returns on the next mount.
  - If another buddy is on screen (`useBuddyOnScreen()`), there is no face, only the sparks.
- **Reduced motion:** the face shows statically and happy; no sparks.

---

## 12. Sound palette

### 12.1 Engine (`src/web/scan/buddy/sound.ts`; draft `buddy-draft/sound.ts`)

**Synthesis.**
- Web Audio, synthesized at runtime: no files and no CSP change (PM §7 item 5).
- One `AudioContext({ latencyHint: 'interactive' })` and a master gain of 0.8.
- Each note: an oscillator, then a low-pass at 2.4 kHz (6 kHz for `click`; it softens the edges), then a gain envelope:
  - 5 ms linear attack;
  - exponential release to 0.0001 at the note's end;
  - the oscillator stops 20 ms later.
- A glide note ramps its frequency exponentially over its first 60 ms.

**Unlock.**
- `unlock()` runs synchronously inside the click handler of the first tap: **Start scanning**, **Pair**, **Tap to scan** or the sound toggle (R web-feasibility §6; iOS needs a gesture).
- It sets `navigator.audioSession.type = 'playback'` when present [U], so the ringer switch doesn't silence the scanner (R §5.4, UXD §7.1). Test on device.
- On `visibilitychange` hidden: `suspend()`. On the next tap: `resume()`. An `interrupted` context resumes on the next tap.

**Toggle.**
- An icon button, `Volume2` / `VolumeX`, labelled **Sound**, with `aria-pressed`.
- 36 px, or 44 px on touch (owner sizes). Placement per UXD §2.3 and UXK §4.4.
- On by default, stored in `localStorage` `passbook-scan-sound`. Storage access sits in try/catch; a throw means on.
- Turning it on plays `ok` once as a preview, which also unlocks audio.

**Scheduling.**
- The main chirp starts at T0, in the same handler that commits the verdict.
- A garnish is scheduled at its impact time minus `ctx.outputLatency` (else `baseLatency`), so the sound meets the picture.
- `cut()` before every new verdict or beat.

**Never.**
- No sound for the same code inside the ignore window, a desk card opening, poses, admin pages or reduced-motion changes. Sound doesn't depend on motion settings.
- Sound is never the only signal (R §2.2 rule 3).

### 12.2 Chirps

Gains are relative to the master. The meaning comes from the contour: **up = yes, down = no, flat and repeated = look, low step down = our problem** (R ux-guidelines §4: staff already read a short high beep as OK and a low double tone as not OK).

| Chirp | Mood | Notes (wave, Hz, start ms, length ms, gain) | Total | Used by |
| --- | --- | --- | --- | --- |
| `ok` | happy | sine 1175 → 1568 glide, 0, 110, .5 | 110 ms | every green verdict, paired, the toggle preview |
| `reward` | happy, bigger | sine 1175 → 1568, 0, 90, .5 · sine 1397, 90, 70, .45 · sine 1760 → 2093, 160, 140, .45 | 300 ms | milestones, reward ready (replaces `ok`) |
| `headsUp` | curious | triangle 784, 0, 90, .5 · triangle 784, 150, 90, .5 | 240 ms | amber |
| `refused` | sad | triangle 262 → 220, 0, 140, .6 · triangle 247 → 196, 210, 160, .6 | 370 ms | red |
| `system` | sad, ours | sine 523, 0, 100, .45 · sine 392, 120, 120, .45 | 240 ms | slate |
| `undo` | flat | sine 880 → 660, 0, 60, .25 | 60 ms | undone |
| `tick` | neutral | sine 2000, 0, 25, .12 | 25 ms | D0 + 300, only if no verdict yet (UXD `DETECT_TICK_AFTER`) |
| garnish `thump` | | triangle 180 → 90, 0, 60, .5 | 60 ms | `stamp`, at T0 + 350 |
| garnish `click` | | square 3200, 0, 18, .06 | 18 ms | `punch`, at T0 + 350 |

Changes from UXD §7.1 and UXK §2.7, which differ from each other:
- `ok` rises (a chirp) instead of holding one pitch.
- `refused` is a falling triangle (soft and low, as n8b asks) instead of a square or a flat triangle.
- The `read` tick plays only at D0 + 300 when no answer has come (door rule), not on every read (desk rule). A fast answer's own chirp already confirms the read, and two sounds 150 ms apart blur together.
- Garnishes are new, and only on `punch` and `stamp`, the two tactile props.

---

## 13. Reconciliation with the UX specs

The door and desk specs were written in parallel. This section settles each buddy point they differ on, or where they differ from the motion rules. Both should cite this file for the buddy and drop their own beat lists.

| Topic | UXD | UXK | Decision |
| --- | --- | --- | --- |
| Beat location | `src/web/ui/art/beats/*.css` | `src/web/scan/buddy/beats.css` | `src/web/scan/buddy/` (M5). `ui/art` gets only the API (2.1) |
| Budget | 2.5 kB gzip | 3 kB + 16 nodes | Measured (section 14.1); both were under the full vocabulary |
| Delay / length | 150 / ≤ 600 | 150 / ≤ 700 | 150 / 550; still by T0 + 700 (M2) |
| Props layer | not stated | sibling `<svg>` | the WalletArt slots (M7) |
| Names | `cheer-quick`, `cheer-fan`, `wrist-tap`, `tear-quick`, `peek-shrug`, head shake | `hop`, `fan`, `wrist`, `tear`, `shrug`, `sign`, … | Section 6 names |
| Offline check-in | `cheer-quick` + tuck by the clock | n/a | `stash`, neutral (M4) |
| `event_ended` | droop | n/a | `wrist dir="fwd"` (amber is time; droop means expired) |
| `not_yet_valid` (red) | n/a | droop | `shake` (red) |
| `template_not_allowed` | head shake | shrug | `shake` |
| Red refusal beats (owner, 2026-11-04) | `tear-quick`, `peek-shrug`, droop, head shake by reason | `tear`, `shrug`, `sign`, droop | `shake` for every red reason (M12); props only for expired and forbidden |
| Slate | cloud, plug | cloud, plug, wait | the prop, then the `sorry` pose; never a shake (M13) |
| `forbidden` | n/a | `tug` | `shake` + the lock beside it (a verdict waits on nothing longer than 550 ms; the full `tug` is for the locked-action sheet and the blocking panels) |
| Network | cloud | plug | `cloud` for connection (matches `CloudOff`/`CloudAlert`); `plug` only for 5xx |
| Moods of `sign`, `empty` | n/a | flat | retired: red shakes, sad |
| Rummage | 600 ms, `.wl-essential` (also "stays still" under reduced motion) | 900 ms riffle; static under reduced motion | 600 ms ripple; **not** `.wl-essential`; static under reduced motion; the spinner carries pending |
| NFC rings | once per entry and per return | loop while armed | once per trigger (M8) |
| Hint | lean on every hint | n/a | first hint only |
| Milestone sparks | from the icon | from the counter chip | from the verdict icon, both |
| Celebration frequency | multiple of 100, all in | 100th of the device's day, reward | all four (9.1), server-decided where shared |
| Pair pose | teal pass | n/a | violet pass (5) |
| Click on the buddy | none | n/a | none, enforced by `immediate` (M9) |
| Sounds | 6 tones | 7 tones | section 12 |

---

## 14. Budgets and tests

### 14.1 Measured (drafts in `docs/design/scanner/buddy-draft/`, gzip level 9)

| Piece | Source, as `art.test.tsx` measures (comments in) | Shipped (minified) | Test budget |
| --- | --- | --- | --- |
| `beats.css` (22 beats, 11 poses, 45 keyframes; after the head shake) | 4,445 B (was 4,164) | 2,558 B (was 2,445) | ≤ 4.5 kB source: 55 B headroom. If a later beat needs room, split `cover` into `cover.css` (§2.2) |
| `props.tsx` (lens and flask plate gone) | 1,508 B (was 1,694) | about 950 B | with `scan-buddy.tsx` and `beat-map.ts` ≤ 3.5 kB source (estimate 2.9 kB) |
| `sound.ts` | 1,508 B | about 800 B | ≤ 1.75 kB source |
| **Scan buddy layer, shipped in the lazy `/scan` chunk** | | **about 5 kB** | |

Already shipped, and reused at no new cost:
- the registry scenes (`cheer`, `count`, `hello`, `wave`, `tug`, `common.css`);
- `rest.css` (`wl-r-blink`) and `art.css` (`wl-a-in`);
- `wallet-states` (the droop, the hourglass), a lazy chunk shared with sign-in, ≤ 2.5 kB.

On staff devices that never open `/login`, `wallet-states` is a first load on `/scan`.

The initial bundle (5 B headroom, PM §8) is untouched: every file here is imported only from the lazy `/scan` route, and the admin moments use components that already ship (`Celebrate`, `BuddyFace`, `Buddy`).

**Nodes.**
- The seated buddy is 29 to 30 nodes (svg, defs, gradient with 2 stops, shadow, 2 wrapper groups, 2 legs, trunk, fan, 3 cards × 3, body, stitch, screen, look group, eyes group, 2 eyes, joy or brows, mouth).
- Props, one beat's set at a time:
  - 0 nodes: `shake` and `sorry` (they move existing parts);
  - 1 node: cloud, shut eyes;
  - 2 nodes: hole and chad, rings, cover passes;
  - 3 nodes: stamp, sparks, coins (one disc each; the edge highlight is a stroke), notepad;
  - 4 nodes: clock.
- Worst case: 34 ≤ 40. A red refusal is 29-30 nodes (no prop), or the buddy plus `LockArt`'s own SVG.
- `UnpluggedArt` and `LockArt` are their own SVGs, each within the ≤ 39 nodes they're tested at.

### 14.2 Tests

**`src/web/scan/buddy/beats.test.ts`.** Parse the stylesheet as `ui/art/replay.test.tsx` does, then check:
- every `[data-beat]` animation's delay plus duration is ≤ 700 ms, except `cover` (≤ 1200) and `rings` (≤ 960);
- `infinite` appears only under `[data-pose="rummage"]`;
- keyframes touch only `translate`, `rotate`, `scale`, `transform` and `opacity`;
- every animation sits inside `prefers-reduced-motion: no-preference`;
- every new keyframe ends at rest, as `scene-ends.test.ts` checks;
- the reused names (`wl-s-cheer-body|up|l|r|joy`, `wl-s-sigh`, `wl-r-blink`, `wl-w-droop`, `wl-w-glance`, `wl-a-in`) are still defined in their source sheets, so a rename can't silently stop a beat;
- the sizes in 14.1;
- the snap bound: the value of every keyframe track at 82 % of its beat is within 3 units and 6° of rest;
- **the head shake**, from the parsed `wl-b-shake*` keyframes:
  - timing: delay `var(--wl-beat-at)` (150), duration 550, so it ends at T0 + 700; trunk and look are back to 0 by
    76 % (568), eyes and brows by 91 % (650), body and fan by 100 %;
  - shape: trunk peaks alternate sign and shrink (−6, +5.5, −3.5, +1.5); every fan peak comes 8.1 % (45 ms) or more
    after the trunk peak it follows (follow-through); the look's peaks lead the trunk's;
  - cut-safe: every keyframe value of every `shake` track is within 6° and 3 units (not only at 82 %);
  - eyes stay squeezed (`scaleY ≤ 0.3`) from 5.5 % to 72.7 %; no other beat squeezes the eyes (slate included);
  - only `rotate`, `translate` and `scale`, the individual properties, so the mood's rest transforms compose;
- the reduced-motion block sets the still "no" (`[data-beat="shake"]`: trunk −4°, look −1.8, eyes 0.28, fan 4°) and
  no animation;
- the `sorry` pose has no `rotate` on `[data-trunk]` and no keyframes with alternating signs (never a shake).

**`scan-buddy.test.tsx`:**
- One buddy across seat changes: the presence count is ≤ 1 after every transition.
- A new verdict removes `data-run`, reads layout, then sets `data-run`, all inside the layout effect.
- Under reduced motion, `data-run` is never set.
- The buddy has no `data-replay` on `/scan`, and a click reaches the verdict's dismiss handler.
- For every beat's props, the total `querySelectorAll('*')` is ≤ 40 and there is no `<text>`.
- The `lock` vector clamps to ±1.6 and ±1.4.
- `cut()` is called before every beat.
- The head-shake cut: render a red verdict, advance the animation clock to T0 + 350 (`document.getAnimations()`,
  `currentTime`), dispatch a green one; inside the same layout effect `data-run` is removed and set again, and the
  next animation frame reads `rotate: 0deg` on `[data-trunk]` with no `wl-b-shake` animation left on the buddy.
  Red after red: the shake's `currentTime` is 0 after the cut (a restart, not a continuation).
- Reduced motion: every red reason renders `data-beat="shake"` with no `data-run`, and `getComputedStyle` gives the
  still "no" values; amber renders the curious clock; slate renders `data-pose="sorry"`; the buddy has no running
  animations.

**`beat-map.test.ts`:**
- every door and desk reason has a beat, a mood and a chirp;
- green-offline is neutral, red and slate are sad, and amber is curious;
- every red reason maps to `shake` (no `peek`, `tear`, `sign`, `empty`); only `expired` sets a state and only
  `forbidden`/`org_inactive` add the lock; no amber or slate reason maps to `shake`; every slate reason sets
  `pose: 'sorry'`.

**`sound.test.ts`**, with a fake `AudioContext`:
- `unlock` creates the context once;
- `play` schedules at `currentTime`, and garnishes subtract the latency;
- `cut` ramps every live gain;
- muted plays nothing;
- throwing storage means on.

**Admin:**
- the door card celebrates only on a live 0 → ≥ 1 change, never on first load;
- the KPI tile never celebrates on the first visit;
- the pairing dialog's `wave` runs once, when `pairedAt` appears.

**Manual acceptance (UXD §16 extended):**
- iPhone 390 × 844 and iPad 1180 × 820, light and dark, reduced motion on and off.
- 20 codes scanned back to back at a 350 ms cadence (`NEXT_SCAN_AFTER_VERDICT`, plan BU.3): no stacked props, no double tones, the buddy never more than one beat behind.
- Refusals at a 350 ms cadence (voided, not found, voided, …): each one restarts the shake, the buddy never drifts
  off its feet, and the eyes open on the first green.
- Sound with the ringer switch on silent, with headphones, and in a noisy room [U].

---

## 15. Shared-file changes (say so in the report)

| File | Owner | Change |
| --- | --- | --- |
| `src/web/ui/art/buddy-art.tsx`, `buddy.tsx`, `replay.ts` | h0 | The beat API (2.1) |
| `src/web/ui/art/art.test.tsx` | h0 | Kit budget +0.25 kB only if the API doesn't fit the 145 B headroom |
| `src/web/lib/gaze.ts` (new) from `portal/login-scene.tsx` `lookAt` and `portal/login-email-face.tsx` `caretX` | h0, j | One caret-gaze helper for sign-in and the scanner's `note` pose |
| `src/web/admin/overview/kpis.tsx` | h | The milestone face and sparks on the scan tile (11.3) |
| `src/shared/contracts/scan.ts` | n8 | `milestone?: 'count' \| 'all_in' \| 'reward'` on `ScanOutcome` |
| `docs/design/motion-and-expression.md` | n8 with h0 | Add a "Scanner beats" section pointing here, `cover` in the scenes table, the scanner milestones and the admin moments under Celebrations, `wave`/`cheer`/`count` uses in the admin |
| `docs/design/scanner/ux-door.md` §6, §7.1 and `ux-desk.md` §2.7, §2.8, §5.3 | scanner design | Point to this file; adopt section 13 |

---

## 16. Open questions

None need the owner. The motion decisions are made above. Left for others:

- **Device checks [U]:**
  - Does `audioSession.type = 'playback'` keep chirps audible with the ringer switch on silent, on iOS 26 and 27?
  - Does it pause the staff member's own audio? If it does, try `'transient'`.
  - How long is the Web Audio output latency on an iPhone? It sets the garnish offset.
- **Desk:** confirm that the phone flood leaves the card sheet's top edge, and its buddy, above the wash (section 3).
- **h0:** sign off on the beat API and, if it's needed, the 0.25 kB kit raise.
- **Architecture spec:** the `milestone` field, decided server-side, in the same atomic step as the event counter.

---

## 17. Customer screens and desk monitors (2026-11-05)

Stations (SA §18, SD §16) add two faces of `/scan`. Same `Buddy` and beat API, same scan chunk, one seat each. The
customer face picks the scanner's beat for each result with `beat-map.ts` from `screen`, `milestone` and the view's
`cue { kind, unit }` (SA §18.4): `access` → `gate`, a count `add` → `stamp`, money → `coins`. Never from the band's
words, which are copy.

### 17.1 Customer screen

| Moment | Seat and size | Motion | Mood | Chirp |
| --- | --- | --- | --- | --- |
| Idle (enter) | shelf, XL (phone 240, iPad 320) | `wave` once (the teal pass up like a hand), then rest | neutral | none |
| `reading` beat from the scanner | same | `rummage` lean-in, eyes down into the pocket; ends at the result or after 3 s | neutral | none |
| Ready (staff choosing) | same | `glance` up at the card | neutral | none |
| Review (amount under review) | same | holds; eyes on the amount | neutral | none |
| OK | same; the violet pass is the card (`card: 'out'`) | the scanner's beat for the result: `gate`, `hop`, `stamp`, `coins`, `punch`, `sparkle`; `fan` + sparks on a reward or milestone | happy | none by default |
| Tapped out (exit) | same | `bye` at XL, the wave toward the exit | happy | none |
| Let in by the desk (an override replacing the shown **Please see the desk**) | same | `relent` from `sorry` (§6.8), then `gate` | sad → happy | none |
| Please see the desk (any heads-up or refusal) | same | the slate bow (§6.4, 350-560) into `sorry`. **Never `shake` and never `wrist`**: a customer is not told "no" by the buddy | sad, `sorry` | none |
| Undone | same | `rewind`, then idle | flat | none |
| Reconnecting | same | rest; no beat | curious | none |

- **Silent by default.** Customer screens play no chirps (the scanner beside them already did); a station may turn
  sound on later (not this wave).
- **Holds** (SD §16.2): ok 4 s, see the desk 6 s, ready up to 60 s; returning to idle replays `wave` once.
- **Cuts** as §7: a newer result cuts the beat in one frame; at most one beat per 350 ms, so two tills scanning at once
  never strobe the screen.
- **Reduced motion:** the end pose of each beat (gate arm up, `sorry`, the wave's peak held 600 ms then rest).

### 17.2 Desk monitor

| Moment | Seat and size | Motion |
| --- | --- | --- |
| Rest | the rail's seat (216 desk, 192 iPad) or the phone dock (152) | rest |
| A new alert (a refusal) | same | one `shake`; at most one per 2 s, the newest wins; nothing during a replay (`hello { replayed }`) |
| Green and amber rows | same | none (a busy door would make it jitter) |
| Its own staff override or mark someone out (Desk actions, SD §18.5) | same | `nod` once; throttled with alerts, 1 per 2 s |
| Empty feed | moves into the empty card (one buddy per view) | `wave` once |
| Reconnecting | same | rest, curious |

No chirps unless the monitor's `screen.sound` is on, then only `refused` for a new alert.

### 17.3 Tests

`gate`: frames at 150, 230, 390, 520, 700 against the table; snap at a 350 cut ≤ 2 units; reduced-motion end pose.
`bye` (2026-11-05 later): frames at 150, 260, 410, 560, 700; the teal pass never past −52° (34° from rest) at any
keyframe; reduced-motion pose. `relent`: frames at 0, 60, 150, 390, 700; only eyes and brows move before 150; a cut at
100 leaves no transform on the trunk or the fan; reduced motion jumps to the grant's end pose. The beat map: every
exit maps to `bye`, no in/out hold or `capacity_full` maps to `shake`, and the customer map still yields no `shake` or
`wrist`. Monitor: an own override plays `nod` once; a second within 2 s plays nothing.
Customer map: every `ScanCustomerView.screen` maps to a beat, and no customer path can produce `shake` or `wrist`
(a unit test over the map). Monitor: only alerts animate it, the 2 s throttle, no beats during replay.
