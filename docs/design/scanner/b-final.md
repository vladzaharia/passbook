# B strengthened: the locked visual reference

B's layout (live camera, the buddy XL on the dock, its violet pass rising into the result card, the last-scan strip
with Undo, desk input on the card) with A's verdict strength (a 104 px band, a 56/64 px solid glyph, a 40 px
headline, a stronger tint and a 10 px ring). Content follows `../display/display-model.md` as reconciled
(R1-R19). Where this file and `../b-buddy/direction-b.md` differ, this file wins.

> **Revision 2026-11-04, owner answers:** the custom title may add the holder's name and take 2 lines (stack custom
> band 202, "The card"); coffee is the **Stamp card** blueprint and prepaid the **Balance card**, each with its own
> palette, strip and tile from `../../../template-identity/`. Not yet rendered: a 2-line title sheet, the two
> blueprints' identities and the `coins` beat (`buddy-motion.md` §6.1).

## Sheets

| Sheet | What |
| --- | --- |
| `sheets/b-final-phone-door-{light,dark}.png` | Checked in, already checked in, voided, not found, wrong event, saved offline, milestone, live pass on a test scanner |
| `sheets/b-final-phone-desk-{light,dark}.png` | Member card with the stepper, stamp added (reward ready), redeem confirm, Manager PIN |
| `sheets/b-final-phone-custom-{light,dark}.png` | The six owner examples: VIP, gym, coffee (Stamp card), prepaid (Balance card), coupon, the event blueprint |
| `sheets/b-final-ipad-{door,desk,custom}-{light,dark}.png` | All 18 states at 1180 × 820 |
| `sheets/b-final-strip-checked-in-{light,dark}.png` | Frames D0 → 1400 ms |
| `sheets/b-final-strip-interrupt-{light,dark}.png` | Amber interrupted by red (red plays the head shake) |
| `sheets/b-final-strip-refused-{light,dark}.png` | The head shake on a voided scan, 8 frames 120 → 700 ms, the buddy at 2.6× under each |
| `sheets/b-final-still-refused-{light,dark}.png` | End poses: red at rest and its reduced-motion "no", amber's clock, slate's `sorry` (and reduced) |
| `video/b-final-refused-{light,dark}.webm` | Real time: voided, then not found, cut 380 ms in by a checked-in code |
| `sheets/b-final-annotated-{light,dark}.png` | Slots and measurements, measured from the pages |

Render: `bash gen/all.sh` (pages, shots and the six state sheets), then `node gen/motion.mjs`, `node gen/strips.mjs
<theme> checked-in interrupt`, `node gen/annotate.mjs <theme>` and, for the refusals, `node motion/gen.mjs` then
`node motion/render.mjs <theme> [strip|stills|video]`. Phone shots are 390 × 844 at 3× with touch, iPad
1180 × 820 at 2×. `gen/shoot.mjs` prints each card's top, height and band height and flags a card over its limit or
any clipped text. CSS: `assets/b.css` (tokens, shell, buddy), `card.css` (card, band, rows), `ipad.css`,
`motion.css`, `beats.css`, `../motion/shake.css` (the head shake and slate's `sorry`, owner direction 2026-11-04;
spec `buddy-motion.md` §6.3-6.4).

## Decisions on the mismatches

| Mismatch | Rendered |
| --- | --- |
| Ticket columns | Model R2: `columns` takes 2-4. Section · Row · Seat · Gate on one line when every value is ≤ 4 characters, else 2 × 2. 4 columns use `1.3fr 1fr 1fr 1fr` |
| Redeem inside a card | Gone. Controls live only in the action area: the card footer (desk input) and the dock. A reached goal promotes **Redeem reward** to the dock's primary button |
| Panels on a refusal | None. Refused shows the stacked band, the compact pass row (system) and the notes slot (`notes.refused`, then the event note) |
| Email | Never shown, never hinted |
| Scan code | Never shown: no "Code ends …" meta. The coupon's meta is the offer title; a review's meta is the holder line |
| Live pass on a test scanner | The template name only, no meta (R18) |
| Names in the band | Owner, 2026-11-04: literal text plus the holder's name ("Welcome back, Maya"), up to 2 lines (model R16). A name that fails the model's name check (1.3: 1-3 words of letters, no verdict word) renders the system band: no eyebrow, the verdict as the headline |
| Holder versus subtitle | Holder line is system (22/28, always shown). `header.subtitle` is the meta line under it |
| Slot order | Band → identity row (pass tile or photo, holder line, meta, chips) → panels → notes |
| Uncustomized event blueprint | Ticket panel: Seat as a `big` row, then Ticket, Doors, Room (model R8) |
| System copy | `SCAN_COPY` only: "+2 stamps", "Voided Nov 3.", no milestone words |
| Event staff note | Kept, `heads_up` and `refused` only, after the template's note (shown on Already checked in) |

## Phone geometry (390 × 844, CSS px)

```
  0 ┌────────────────────────────┐ status bar, safe top 47                       z 50
 53 │ ╭ capsule 366 × 52, r 26 ╮ │ x 12-378, glass                               z 20
105 │                            │
117 │ ┌ card top limit ────────┐ │ the card never rises above 117                z 11
    │ │ band ≥ 104             │ │ x 24-366 (342), r 28
    │ │ identity 44-96         │ │
    │ │ panels / notes         │ │
560 │ └ card bottom (fixed) ───┘ │ 284 from the bottom: where the pass leaves the pocket
546 │       ╲▯ buddy ▯╱          │ 192 × 144, x 99-291, y 546-690                z 12
678 │╭ dock 166, r 28 top ──────╮│ padding 24 16 42                              z 10
    ││ last-scan strip 40        ││
    ││ thumb row 50              ││
844 ╰╰───────────────────────────╯╯ home indicator 134 × 5 at bottom 8          z 30
```

- Card height is content height, max **443** (560 − 117). Measured: VIP 434, already checked in 440, gym 436, Manager
  PIN 436, stepper 438, coffee 428, coupon 390, blueprint 407, voided 386, wrong event 274, not found 200 (band only).
- Aiming only (hidden while a card is up): reticle 236 × 236 at (77, 206), corners 40 long, 4 px, r 18; live pill
  centred at y 460, 36 tall, 15/500 white on `rgb(10 12 20 / .62)` with blur 20. During a result the capsule's second
  line reads **Scanning** with a green dot.
- Grid: 4 px base; spacing 4 8 10 12 14 16 20 24 32. Every left edge in the card sits at 24 (card inset 12 + 12).

### z-order (back to front)

| z | Layer |
| --- | --- |
| 0 | camera (`.b-cam`), then scrim, verdict tint, desk dim, in DOM order |
| 4-6 | lock outline (Checking…), reticle, live pill |
| 9 | a tucking card (interrupt: the old card goes behind) |
| 10 | dock |
| 11 | the result card or desk panel |
| 12 | buddy (its fanned passes overlap the card's bottom edge) |
| 20 | capsule |
| 30 | home indicator |
| 40 | verdict ring |
| 50 | status bar (the OS draws it above the ring) |

## The card

### Verdict band (system)

| Layout | When | Spec |
| --- | --- | --- |
| **row** | ok and heads-up with the system headline | padding 22/24, min-height 104, flex row, gap 16, glyph 56 (heads-up triangle 63 × 56), centred on the text block |
| **stack** | refused, system problems | padding 24/24/26; glyph row 64 tall (triangle 72), 14 below it; headline on the full 294 measure |
| **stack custom** | ok with `header.title` | template icon 56 with the verdict word beside it (eyebrow 20/24 600, gap 16), 10 below; title on the full measure, 1 or 2 lines (`titleLines`); padding-bottom 24. Height 158 at 1 line, 202 at 2 (one more 44 line; costs 1 panel unit) |

- Headline 40/44, weight 650, −0.025em, `text-wrap: balance`, max 2 lines (clamp). Sub 17/22 500 at 92 %,
  6 below the headline. Text colour is `--v-on`.
- **Solid glyph** (shape alone says the verdict): circle (ok), triangle (heads-up), octagon (refused), squircle r 18
  (system). Shape fill `--v-on`; the mark is knocked out in `--v` at 6.5 stroke in a 64 viewBox (triangle 72 × 64).
  Paths: `gen/kit.mjs` `G`. Saved offline adds a 30 px badge (arrow up) on the check.
- **Custom icon** (ok only): a solid `--v-on` tile, r 16 (r 18 in stack), the Lucide icon 30 px (34 in stack) at
  2.25 stroke in `--v`. Verdict badge: 30 px circle of `--v` with a 24 px check disc inside (3 px ring), at −9/−9 on
  the lower trailing corner.
- **Hold rail**: 4 px at the band's bottom edge, `currentColor` at 30 %, `scaleX(1 → 0)` over the hold.
- Milestone: a 3 px foil ring around the whole card (conic foil 1 → 2 → 3) and six 5 × 12 foil sparks at 0°, 60° …,
  starting 30 px from the glyph centre. No words.

### Body

- `.bdy` padding 14/12/12, gap 12.
- **Identity row**: padding 0 12, min-height 44, gap 12. Pass tile 40, r 10, the pass background with its logo 20 px
  white. Holder line 22/28 600 −0.015em, one line, ellipsis. Meta line 15/20 muted. Chips 8 below the meta; with no
  meta line the chips ride on the name line (gap 10) and wrap below (gap 8). Chevron 18 in a 24 × 44 target.
- **Photo** (`photo` set, Desk and up): replaces the tile, 96 px r 18 (iPad 128 r 22).
- **Compact pass row** (refused): the tile becomes a neutral 40 px square (`--fill-gray`, ticket icon muted), no
  chevron; meta is the pass title; a neutral **Voided** pill when voided. Live/test mismatch: the pass title is the
  holder line (modes never show each other's holders).
- **Chips**: 28 tall, r 14, padding 0 10, 13/16 600, icon 14. Tones gold, violet, teal, neutral (tokens below).
- **Panel**: r 16, padding 12, gap 12, `--s-inset` with a 0.5 px inset line. Header 16 tall: icon 16 muted, label
  13/16 600 strong, trailing detail 13/16 600 muted. Panels stack with gap 12.
- **Notes slot**: r 16, padding 12, gap 10, icon 18 muted (`Info`), text 15/20 strong, max 2 lines.

### Rows

| Row | Spec |
| --- | --- |
| `columns` big | label 12/16 500 muted, value 28/32 600 −0.02em tabular, 2 below the label; columns after the first get padding-left 12 and a 0.5 px rule |
| `columns` normal | value 17/22 500, no rules, padding-left 16 |
| `field` | label 15/20 muted left, value 17/22 500 right, wraps to 2 lines; optional icon 18 muted |
| `big` | optional label 12/16, value 28/32 600, unit 15/20 muted 8 after |
| `progress` | readout: from 17/22 muted, arrow 16, now 28/32, "of 10 stamps" 17/22 muted. Stamps 44 discs, 5 a row spaced between, row gap 10; filled: tone with the icon 20 in the inset colour; new: plus a 16 px badge (strong, 2 px inset-colour ring) at −3/−3; pending (desk draft): 2 px tone ring on 14 % tone; empty: 1.5 px ring of muted at 45 %. Caption 15/20 muted, the number 600 strong, a gift 18 in tone once reached |
| `money` | old 17/22 muted, struck 1.5 px; arrow 16; new 28/32 600; this change as a neutral chip at the trailing edge |
| `history` | rows ≥ 44, 32 px disc (icon 16), title 15/20 500, detail 12/16 muted, amount 15/20 500 tabular; 0.5 px separators inset 44 |
| `list` pair | 2 columns, gap 12/16, icon 20 in tone, text 17/22 500, detail 15/20 muted |
| `divider` | 0.5 px `--line`, bleeds to the panel edges |

The template tone (`--tone`) colours stamps, progress fills, list icons and the caption gift. Nothing else.

### Desk panels (`ready`)

- No band and no tint. The camera dims (`rgb(4 6 12 / .55)`, 200 ms) and keeps decoding.
- Header: padding 20/24/16, tile 40, title 22/28 600 (holder, or the review question), meta 15/20 muted, 0.5 px
  hairline below. The Manager PIN line may wrap.
- While an amount control is open only the first template panel shows; its `progress` or `money` row previews the
  draft (pending stamps outlined, old balance struck).
- System input under the panel: padding 2/12/0, title 17/22 600 with the hint 15/20 muted at the trailing edge;
  stepper buttons 56 r 16, value 28/32. Presets (44, r 12, selected = accent tint + 2 px accent ring) show on iPad only.
- Review: before 17/22 muted → after 28/32 600, the consequence 15/20 muted.
- Manager PIN: staff row (40 avatar, **Change** plain button), six 14 px dots (gap 16), keypad 3 × 4 of 48 px keys,
  r 14, 24/1 500.
- The commit pair is in the dock: secondary 116 wide (**Cancel** or **Back**), primary teal, grows. The verb arms at
  T0 + 260 (opacity .4 until then).

## Dock and buddy

- Last-scan strip 40: a 24 px verdict disc (icon 15), title 15/20 600, meta 13/16 muted, **Undo** 15/20 600 in a
  44 × 44 target. At T0 it becomes this scan. Amber puts the first scan's time, place and staff here
  ("First in 6:29 PM · Side door · Sam K.").
- Thumb row 50: buttons r 14, 17/600; gray (`--fill-gray`), filled (accent), square 50. Door: **Look up**, torch,
  keyboard. Desk: **Look up**, NFC, torch. Amber: **Let in again** (gray, grows), **Done** (filled, 116).
- Buddy XL 192 × 144 (iPad 256 × 192), 3 px line (3.25 iPad), seated on the dock's top edge. With a card up the
  middle pass is hidden and the pocket shows a 2 px notch; the outer passes fan to ±24°.

## iPad 1180 × 820

- Status bar 24, capsule top 32, 60 tall, r 30, insets 24. Dock 128 in one row: the strip as a 460 px gray group with
  Undo trailing, the actions at the right. Card bottom 290 from the bottom (y 530), top limit 108, so max 422.
- **Split card**, 980 wide, r 32: the band is a 360 px column on the left, full card height, always stacked (padding
  32, glyph 80, triangle 90, 20 below it, headline 52/56, sub 20/26). Content on the right at the wide width
  (padding 20/24, gap 14); two panels stack, so Ticket and Access each stay on one line. A band-only card (not
  found) is 600 wide.
- Desk panels keep the header on top, then the template panel (1.25 fr) and the system input (1 fr) side by side.
- Ring 12 px, glow 56. Stamps 10 a row at 44 on ok, 5 a row at 48 beside the stepper. Sparks scale 1.4.
- Measured: VIP 414, stepper 418, prepaid 413, blueprint 379, already 345.

## Type steps

| Token | Phone | iPad | Use |
| --- | --- | --- | --- |
| `--t1` | 12/16 500 | 14/18 | column and field labels, history detail |
| `--t2` | 13/16 600 | 15/20 | chips, panel headers |
| `--t3` | 15/20 400 | 17/22 | meta, notes, captions, field labels |
| `--t4` | 17/22 500 | 20/26 | values, verdict sub, list text |
| `--t5` | 22/28 600 | 32/38 | holder line, panel header title |
| `--t6` | 28/32 600 | 40/44 | big values, columns big, money, stepper |
| `--t8` | 40/44 650 | 52/56 | verdict headline |
| eyebrow | 20/24 600 | 24/30 | the verdict word beside a custom icon |

Rubik variable; tabular numbers on every value. Nothing in the card outranks the headline.

## Colour tokens

Verdict hues are theme-invariant (band, glyph, ring, strip disc):

| Verdict | `--scan-*` | on-colour | Contrast |
| --- | --- | --- | --- |
| ok | `#22c55e` | `#04170b` | 8.1 |
| heads-up | `#f59e0b` | `#1f1600` | 8.3 |
| refused | `#b91c1c` | `#ffffff` | 6.5 |
| system | `#334155` | `#ffffff` | 10.4 |

Full-screen verdict layers, tuned for a dark venue:

| Layer | Light | Dark |
| --- | --- | --- |
| scrim | `rgb(4 6 12 / .30)` | `rgb(0 0 0 / .38)` |
| ok wash | `#22c55e` at .50 | `#15803d` at .62 |
| heads-up wash | `#f59e0b` at .56 | `#b45309` at .62 |
| refused wash | `#dc2626` at .60 | `#b91c1c` at .66 |
| system wash | `#334155` at .56 | `#334155` at .66 |
| ring | 10 px `--v` + inner glow 36 px blur, 12 px spread, `--v` at 55 % | same, glow at 70 % |

Surfaces and text (light / dark): card `#ffffff` / `#0d111b`; inset `#f2f4f9` / `#171c28` with a 0.5 px line at
5 %; glass `rgb(255 255 255 / .84)` / `rgb(13 17 27 / .74)`; text strong `#060912` / `#ffffff`, body `#262d40` /
`#dbe4ff`, muted `#48536b` / `#8f98ad` (7.0 and 5.9 on inset); line `#dadee9` / `#212633`; fill-gray
`rgb(118 124 140 / .14)` / `/ .24`; accent `#0f766e` / `#2dd4bf` (on `#ffffff` 5.5 / on `#04201c` 9.2).

Chips (bg / fg): gold `#fbf1d9 / #7a5a12` (5.7), dark `#2e2410 / #e8c27a` (9.0); violet `#efe6ff / #5418c9`
(7.4), dark `#2a1a4d / #cdb2ff` (8.4); teal `#d8f2ee / #0b5c55`, dark `#0a2629 / #5eead4`; neutral `#eceef4 /
#333b50`, dark `#222838 / #c3cbe0`. Template tones: violet `#7a2fff` / `#b48aff`, teal `#0f766e` / `#2dd4bf`, gold
`#8a6514` / `#e8c27a`. Buddy: line `#6f7890` / `#8a93a8`, body `#ffffff` / `#121722`.

## Motion (ms from the verdict, T0)

All transform and opacity. The card is FLIP'd from the violet pass's live box (`--fx --fy --sx --sy`, `assets/b.js`).

| t | What | Timing |
| --- | --- | --- |
| D0 | code read: frame frozen, reticle presses to .9, lock outline; **Checking…** after 300 | — |
| 0 | tint, scrim and ring fade in; chirp | 80 linear |
| 0-60 | the violet skin lifts off the card's content | 60 linear, 1 → 0 |
| 0-210 | rise: from the pass (`perspective(900px) rotateX(28°) rotate(−3°)`) to `translateY(−10) scale(1.02) rotate(.6°)` | `cubic-bezier(.32,0,.12,1)` |
| 210-290 | overshoot to `translateY(2) scale(.997)` | `cubic-bezier(.45,0,.55,1)` |
| 290-380 | settle to rest | same |
| 60-380 | glyph or custom icon pops from scale .6, opacity .3 | 320, `--bounce` |
| 0-220 | headline, sub and body rise 4 px from opacity .6 | 220 `cubic-bezier(0,0,0,1)` |
| 0-120 | reticle and live pill fade; dock strip and row cross-fade from .35 | 120 linear |
| 120-760 | milestone sparks, 40 apart, 30 → 52 px out, +40°, `scaleY .4`, fade | 640 ease-out |
| 150-700 | buddy beat: hop or fan (green), wrist (amber), **shake** (every red), sorry (slate) | 550, ease-in-out between keys |
| 220 + 90k | new stamps land from scale 1.5 | 350 `--spring` |
| 350 | a different code is accepted | — |
| hold | rail runs: ok 1200, refused 3000, amber until **Done**, a tap or a different code | linear |
| tuck | back into the pocket, content kept; opacity holds to 55 % then fades | 180 `cubic-bezier(.3,0,1,1)` |
| interrupt | old card tucks in 150 at z 9 while the new one rises skinless in its colour at z 11, same frame | — |
| desk | dim 200 `cubic-bezier(0,0,0,1)`; commit verb arms at 260 | — |

`--spring: linear(0, .035 2.1%, .141 4.4%, .723 12.9%, 1.017 20.5%, 1.043 24.5%, 1.007 36%, 1)`;
`--bounce: linear(0, .24 7%, .86 17%, 1.1 24%, 1.13 28%, 1.08 35%, .98 46%, 1.01 58%, 1)`. Mid-rise, a new verdict
calls `commitStyles()` and tucks from where the card is. Reduced motion: the card cross-fades in place over 120 ms;
no rise, tilt, scale, rail, sparks or beat; tint switches at once.

## Keeping the direction isolated

Everything above is the **screens** workstream (`scan/result/*` views, `scan.css` layout and tokens) and the
**buddy** workstream (XL seat, `card` prop, beats). The model, renderer, `ScanDisplay` contract, validator, editor and
server carry content, order and the `oneLine` hint only, never geometry or colour. Switching to "A at the door, B at
the desk" swaps the door's result view and the buddy seat; nothing else moves.

## Open items for the lead

1. **Keypad entry on a phone.** Balance (money + a 3-row ledger, 240) plus a 3 × 4 keypad (216) does not fit under
   443. The prepaid tile shows the review step. Options: the keypad in the dock (the dock grows into a keypad tray and
   the buddy peeks over it), or the ledger shows one row while the keypad is open. iPad fits side by side.
2. **Fit budget.** The model estimates a 408 px card and a 104-148 band. Measured: limit 443; band 104 (ok), 116
   (with a sub), 158 (custom title), 202 (custom title on 2 lines, not yet measured), 160 (amber, 2 lines), 200 (refused, no panels follow). The six tiles fit with
   7-15 px to spare.
3. **Not found sub.** Settled: **This code isn't a pass here.** (one sub for door and desk, `SCAN_COPY`).
4. **Goal reached.** UK swaps the check for a gift and adds a **Reward ready** pill. Rendered: the check keeps its
   shape, the panel caption says "1 reward ready" and the dock promotes **Redeem reward**.
5. **Gym photo** is 96 on phone (model says 112) so the card fits with the custom-title band; 128 on iPad.
6. **Already checked in.** UD's card meta "6:29 PM · by Sam K." moved to the strip, since the meta line is
   template-owned (R6).
