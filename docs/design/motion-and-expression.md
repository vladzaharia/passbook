# Motion and expression

How Wallet moves, catches light and shows personality. Extends
[ui-consistency.md](ui-consistency.md) and [ux-principles.md](ux-principles.md); layout, density
and copy rules there still hold. Tokens: `src/web/styles/motion.css` (on the @polaris-key/brand
motion scale). Pass presentation: `src/web/pass-card/stage.{tsx,css}`. Art:
`src/web/ui/art/`.

## Personality

Tactile, quick, a little holographic. Passes act like cards you can pick up; each thing in the
console has a small picture that acts out what it is; the console around them answers fast and
stays out of the way. Fun comes from how things move and catch light, never from more words.

Every motion has a job: it shows what changed, where it came from or what the thing is. Each spec
names its trigger, property (transform or opacity), duration, easing and distance.

## Three speeds

| Tier | Things | Duration | Easing |
| --- | --- | --- | --- |
| Chrome | Controls, overlays, routes, rows, indicators, toasts | 80–280 ms; lands under 300 ms including stagger | ease-out in, ease-in out |
| Art | Entity illustrations | 400–600 ms, once on mount | spring for pops, ease-out for slides, bounce only for stamps |
| Signature | Pass stage (deal, flip, mint), login scene, wizard finish, celebrations | 480–900 ms | spring, 3D |

**No ambient loops.** Only things that carry pending state loop, and only while work is pending:
spinners, pending rings, the loading rail, the sync rail and the upload buddy's riffle. Art and the login scene get one idle
beat; nothing moves on its own more than 5 s after mount (WCAG 2.2.2).

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--wl-dur-press` | 80 ms (`pk-duration-micro`) | Press feedback |
| `--wl-dur-hover` | 120 ms | Colour and hover |
| `--wl-dur-exit` | 120 ms | Overlay exits |
| `--wl-dur-tooltip` | 100 ms in, 80 ms out | Tooltips |
| `--wl-dur-enter` | 200 ms (`pk-duration-base`) | Overlays, rows, toasts, panels, step changes |
| `--wl-dur-shake` | 240 ms, `wl-shake` 0 / −4 / 4 / −2 / 0 px | Failure after a user action |
| `--wl-dur-route` | 260 ms (`pk-duration-moderate`) | Route fade-through total |
| `--wl-dur-indicator` | 280 ms | Nav, tab and segmented indicators |
| `--wl-art-delay` | 80 ms | Art entrance start |
| `--wl-dur-card` | 480 ms (`pk-duration-deliberate`) | Deal, shared-card morph, art part ceiling |
| `--wl-dur-flip` | 640 ms | Pass flip, sign-in card flip |
| `--wl-dur-sheen` | 900 ms | Mint sweep |
| `--wl-dur-count` | 600 ms | Number count |
| `--wl-dur-highlight` | 1200 ms | Insert highlight fade |
| `--wl-ease-out` | `pk-ease-enter` | Entrances |
| `--wl-ease-in` | `pk-ease-exit` | Exits |
| `--wl-ease-move` | `pk-ease-standard` | Moves within a page |
| `--wl-ease-spring` | `pk-ease-spring` (4% overshoot) | Cards, flip, indicators, art pops |
| `--wl-ease-bounce` | `linear()`, 13% overshoot | Stamps, seals, success checks, celebrations |
| `--wl-rise` | 8 px | Entrance rise |
| `--wl-slide` | 16 px | Route and step slide by direction |
| `--wl-deal` | 24 px | Card deal |
| `--wl-tilt` | 7° per axis (5° on touch) | Pass tilt |
| press scale | 0.98 (`pk-motion-scale-press`); mint 0.965 | Buttons, icon buttons; mint |
| `--wl-stagger` | 30 ms rows, 60 ms cards; cap 6 steps | Lists; last item starts by 180/360 ms |
| `--wl-foil` | teal → Polaris violet → Polaris gold | Mint sweep, art hero edges, sparks, login cards, sign-in and email top edge |
| `--wl-edge` | `inset 0 1px 0 rgb(255 255 255 / .05)`, dark only | Lit top edge on raised surfaces |
| `--wl-glow-accent` | accent at 45%, 16 px blur (35%, 10 px light) | Primary button hover and focus |

## What moves and when

| Thing | Motion | Rule |
| --- | --- | --- |
| Route change | Fade-through: old main fades out in 90 ms (half the slide), new main starts at 60 ms and fades in over 200 ms with an 8 px rise or a 16 px slide by path depth | Two headings are never legible together. Path changes only: filters, sort, `?tab=`, `?v=` never animate. Sidebar and top bar never move |
| Shared pass card | List tile morphs into the detail card and back (480 ms spring) | `transitionName="pass-<id>"` on both; the detail is seeded from the list cache so the first frame has the card |
| Nav, tab and segmented indicators | Slide to the new item, 280 ms spring; the pill translates and takes its width directly | `ActiveIndicator`; no scale at rest |
| Tab panel | Fades in 120 ms; strip scrolls smoothly to reveal the active tab | No translate |
| List first load | Rows fade and rise 8 px, 30 ms stagger, cap 6 | Once per mount, after a skeleton. Rows that arrive during a route transition only fade (160 ms) |
| Refetch, filter, sort, cached revisit | Nothing re-enters. After 150 ms rows dim to .6 and a 2 px loading rail runs on the card's top edge | `keepPreviousData`; `aria-busy` on the table |
| Row inserted | Accent-subtle overlay fades .8 → 0 over 1200 ms; no movement | Only rows new since the last render, never on first load |
| Row removed | Item scales to .96 and fades in 160 ms; neighbours close up over 240 ms | Same-document View Transition with `row-<id>`; never animate layout |
| Pass grids | Deal on the stage only: rise 24 px, −2°, .96, spring, 60 ms stagger; tile chrome rises 8 px after the card | Portal My passes, template gallery and pickers |
| Dialog, popover, menu, select | In: fade, .98 scale and 4 px from the trigger side, 200 ms; out: fade 120 ms | Radix `data-state` keyframes and `--radix-*-transform-origin` |
| Bottom sheet (<640) | Slides up 260 ms, down 200 ms | Dialogs, confirms and menus on phones |
| Sheet | Slide 260 ms in, 200 ms out; on touch it follows the finger and closes past 40% or 0.5 px/ms, else springs back in 200 ms | Overlay opacity tracks the drag |
| Tooltip | Opacity plus 2 px from its side, 100 ms in, 80 ms out | No scale; 400 ms delay |
| Buttons, icon buttons | Press .98 in 80 ms; hover colour 120 ms; dark primary glows on hover | Loading keeps the width and the icon (busy verbs) |
| Switch, checkbox | Thumb slides on spring 200 ms and stretches 1.25× toward its travel while pressed; the tick draws, short stroke (90 ms) then long (150 ms), only when it changes after mount | Never on load |
| Copy, saved | Icon swaps to a check (300 ms bounce), back after 1.5 s | Same label |
| Toasts | Sonner's slide. Icon: success is the buddy's face, pops (300 ms bounce) and winks at 380 ms (200 ms); info fades (160 ms), error shakes (240 ms) | Copy unchanged |
| Skeleton → content | Skeleton after 150 ms (`pk-delay-skeleton`), same shape and height; handoff: skeleton fades 120 ms while content rises 4 px in 200 ms | No layout shift |
| Numbers | Count from the last value shown this session (first visit from 0), 600 ms ease-out, tabular-nums | `CountUp`; nothing counts 0 → 0 |
| Status change | One ring pulse in the pill's tone (scale 1 → 1.6, fade, 640 ms) | Only when the value changes on screen |
| Save bar | Slides up on spring 260 ms; on save the button shows a check for 400 ms, then the bar slides down 200 ms; Discard exits at once | Stays mounted while closing |
| Wizard step | New step enters 16 px from the direction of travel plus opacity, 200 ms; old step fades in 90 ms; a done step fills with a bounce (.7 → 1, 320 ms) and its tick draws | Focus moves to the step heading |
| Drop zone | A file dragged over lifts the art or upload arrow 4 px (200 ms spring) | Settles on leave or drop |
| Theme change (admin) | Root crossfade 200 ms; the toggle icon rotates out and springs in | View Transition type `theme`; instant under reduced motion |
| Offline bar | Slides down 200 ms under the top bar, up 160 ms when back online | |
| Failure | One shake (240 ms) on the thing that failed, only after a user action | Error states never shake on first render |
| Focus ring | Instant | Never animated |

## Buddy cameos

The mascot turns up at real moments, one per view, decorative (`aria-hidden`). Each is one-shot
except the riffle, which runs only while an import does.

| Moment | What happens | Time | Where |
| --- | --- | --- | --- |
| Success toast | The face (`BuddyFace`, 24-unit icon) pops with the toast and winks | 200 ms at 380 ms | `ui/toaster.tsx` |
| Status all good | The face replaces the check and winks | 200 ms at 640 ms | `admin/status/summary.tsx` |
| Empty state | The buddy's eyes drop to the action under the pointer or focus | 200 ms | `art-wallet.css` |
| Palette, no results | The lost buddy with its lens, eyes left and right | Art entrance | `ui/command-palette.tsx` |
| Template upload | On the drop zone: passes reach up and the mouth opens for a hovering file; a caught file gets the smile and a hop; an import past 600 ms riffles the passes left to right (900 ms cycle) until it ends; a refusal sighs. Done, it moves to the result card | 320 ms; 640 ms hop | `admin/templates/upload-*` |
| Pass created | The happy buddy steps out from behind the new pass (420 ms spring at 520 ms), hops once and stays beside it | ≈1 s | `admin/passes/detail/detail-page.tsx` |
| Signed out | The sign-in scene's top card waves from the pocket once, within two minutes of a sign-out in this tab | 860 ms at 700 ms | `portal/login-*` |
| Wordmark | Hover (fine pointers): the wallet's pocket curve deepens into a smile, the card line peeks up 1.5 px; SPA and SSR | 160 ms | `kit-verbs.css`, `ssr/theme.ts` |

The favicon and `apple-touch-icon.png` (also the sign-in email's header mark and the OIDC logo) are
the face on the dark tile, in teal with the foil passes.

## Action verbs

Icons act out the action they label (`Button busy="verb"` keeps the icon while pending). Transform
on the svg only.

| Icon | While pending (loops) | When the server confirms (once) | Hover, fine pointers (≤160 ms) |
| --- | --- | --- | --- |
| `RefreshCw` | Spins 360° per 900 ms, linear | — | — |
| `Zap` (Test) | Opacity 1 → .35 → 1 per 600 ms | Result pill pops (pass) or shakes (fail) | — |
| `Upload` | Arrow bobs 2 px per 600 ms | — | Arrow lifts 1.5 px |
| `Stethoscope` (APNs) | Two rings leave the seal (640 ms, second at 320 ms) | Seal pops (healthy) or shakes (failing) | — |
| `Send`, `Mail` | — | Flies 6 px up-right and fades (240 ms), returns from bottom-left (200 ms) | 1.5 px up-right |
| `RotateCw` | — | Rotates 360° once (400 ms ease-out) | — |
| `KeyRound` | — | Turns 90° (300 ms spring); reverse on revoke | — |
| `Ban` | — | Stamps: scale 1.3 → 1, −12° → 0° (300 ms bounce) | — |
| `Copy` | — | Check pops (300 ms bounce) | — |
| `Trash2` | — | — | Lid lifts 1.5 px and tilts −12° |
| `Download` | — | — | Arrow drops 1.5 px |
| `ExternalLink` | — | — | Arrow moves 1.5 px up-right |
| `Plus` | — | — | Rotates 90° |
| `LogOut` | — | — | Arrow moves 1.5 px right |

Under reduced motion the pending loops keep running; confirmations and hover verbs are off.

## Entity art (R1)

Every empty, filtered, not-found and error state names its art; there is no generic fallback.
Passes keep the pass art; everything else gets its own picture and verb.

System:

- Inline SVG, `viewBox 0 0 96 72`: 96×72 on pages, 64×48 inside cards, tabs and the palette.
- Strokes 1.5 px non-scaling in `border-strong`, round caps and joins. Objects fill
  `surface-raised`; slots fill `surface-sunken`.
- Exactly one accent part (accent stroke, accent fill at 20%). Foil only as a 2 px top edge on the
  hero object. No text. Faces only on the holder mascot (`wallet`).
- Each part is a `<g data-part>` with `transform-box: fill-box` and an explicit origin.
- Entrance: once on mount after 80 ms; each part ≤480 ms, the whole art ≤600 ms.
- Idle: one beat (≤400 ms) at 2.4 s after mount. On fine pointers, hovering the empty block replays
  the beat once per hover. No loops.
- One active art per screen. A checklist plays only the current step's art (entrance and beat);
  done steps hold the final frame with a check, later steps wait at .45. A step that turns current
  enters 120 ms after the previous check pops. Other arts on that screen pass `still` (final frame)
  or `beat={false}`.
- Filtered: the entity art at .6 opacity with the lens at bottom-right (scale .6).
- Decorative: `aria-hidden`, adds no words. The title and single action stay as they are.
- Reduced motion: the final frame, no beat. Cameos swap pose at once: no wink, hop, riffle, step-out
  or wave.
- Budget: ≤40 SVG nodes per art; all art ≤8 kB gzip. Files `src/web/ui/art/<name>.tsx` (named
  exports, under 300 lines); `art.css` (tokens, part engine, keyframes) plus the part rules in
  `art-records.css`, `art-details.css` and `art-wallet.css`; the map in `src/web/ui/art/index.ts`.
- API: `<EntityArt name size="lg"|"sm"|"xl" beat? still?>` or the named component (`PassesArt`…).
  `LayersArt compare` splits the top two sheets. `WalletArt state mood lift onCard face front` (states
  `login`, `empty`, `lost`, `confirm`, `expired`, `no-access`, `break-glass`) renders through
  `renderToStaticMarkup`; SSR pages inline `ART_CSS` (`art/css.ts`, every art sheet in cascade
  order; tokens fall back to the SSR names) and
  pass `beat={false}` to stay static. Hover replay needs a `data-art-host` ancestor.
- Parts animate from CSS variables on `[data-part]` (`--f` from, `--t` rest, `--d`, `--u`, `--e`,
  beat `--b`); `art.test.tsx` checks the timing budget from the stylesheet.

| Art | Picture | Entrance | Beat |
| --- | --- | --- | --- |
| `passes` | Three passes with a header strip, two field bars and a barcode; foil edge on the front | Stacked → fan −10°, 0°, 10° with ±14 px (480 ms spring); outer cards 60 ms later | Front lifts 4 px and tilts 3° |
| `template` | Dashed pass outline; header bar, image block (accent), barcode | Outline fades in (160 ms); pieces drop 14 px and snap (300 ms spring, 70 ms apart); foil edge with the last | Pieces lift 3 px in turn |
| `plugs` | Plug and socket; socket LED (accent) | Slide together from ±16 px (300 ms), snap (160 ms spring), three-line spark (200 ms), LED on | Part 3 px and reconnect |
| `people` | Three busts, no faces; badge dot on the centre one (accent) | Centre rises 10 px (360 ms spring); sides 60 ms later | Heads bob 2 px in a wave |
| `building` | Building with 3×3 windows, door and a roof flag (accent) | Grows from the ground (scaleY .7 → 1, 360 ms spring); windows light 40 ms apart from 200 ms; flag swings | Windows flick in a diagonal wave |
| `certificate` | Document with three lines; rosette seal (accent) | Document rises 8 px (200 ms); seal stamps at 180 ms (scale 1.4 → 1, −20° → 0°, 400 ms bounce) | Seal pops 1 → 1.12 → 1 |
| `key` | Lock with keyhole; key with an accent bow | Key slides in (240 ms), turns 90° (320 ms spring) | Turns back and forth |
| `log` | Document window with five text bars; newest bullet accent | Rises 8 px (200 ms); lines scroll up one step (320 ms) | One more line scrolls |
| `activity` | Rail with three dots; newest accent | Rail draws (scaleY, 300 ms); dots pop 80 ms apart | Newest dot pops |
| `pulse` | Monitor with a heartbeat line | An accent dot travels the line once (480 ms, the part ceiling), trail fading in behind | Dot travels again |
| `runs` | Three linked nodes | A dot hops node to node (3 × 160 ms); each node pops | One more hop |
| `phone` | Phone; a pass above it; accent bubble | Phone rises 8 px; the pass drops toward the screen and stops above it (360 ms spring) | Pass bobs; with devices it slides into the screen and the bubble pops |
| `envelope` | Envelope with a flap; pass inside with an accent edge | Rises 8 px (200 ms); flap opens (220 ms); pass peeks up (280 ms spring) | Pass sinks and peeks |
| `frames` | Two photo frames; sun (accent) | Front frame slides in from 10 px, 10° → 4° (360 ms spring); sun rises 4 px | Front frame slides aside and back |
| `layers` | Three offset sheets; top accent edge | Sheets drop onto the stack (300 ms spring, 60 ms apart). Compare pose: top two split ±10 px | Top sheet shuffles |
| `mapping` | Two columns of slots; arrow (accent) | Slots pop; arrow draws across (scaleX, 300 ms) | Arrow redraws |
| `lens` | Magnifier (accent glass) over a 3×2 grid of blank cells | Slides in from −12 px, −8° (360 ms); cells brighten as it passes | Sweeps 10 px and back |
| `torn` | Pass with a torn corner | Corner tears off and drifts 6 px, 12° (420 ms) | Corner wobbles ±3° |
| `lock` | Pass with a padlock | Shackle drops 5 px (200 ms bounce), squash .94 → 1 | Shackle lifts and drops |
| `unplugged` | Socket and a dropped plug with slack cord; spark in `danger` | Plug drops 8 px away (300 ms); spark flickers once | None; shakes once after a failed retry |
| `wallet` | Holder mascot: stitched pocket, accent clasp with two dot eyes and a smile, three foil cards (teal, violet, gold) | Moment 8. Empty: no cards; a dotted card outline bobs once and the eyes look up. Lost: the lens over the pocket, eyes look left and right | One blink |

## Signature moments

One per screen. The wordmark flips once per browser session in the SPA and never on `/p`, `/login`
or the SSR mascot pages.

1. **Pass stage** (`PassCardStage`, every pass on every surface). The pass lights the surface
   under it in its own background colour (a radial gradient, no blur filter); in dark a 1 px rim
   and a soft drop keep dark passes visible, and a too-dark glow mixes in the label colour. Fine
   pointers tilt it up to 7° with a highlight that follows; touch tilts up to 5° while pressed
   (vertical scrolling still works). `Details` flips it in 3D (640 ms spring); the far face is
   `inert`. Pixels inside the card are never altered.
2. **Mint** means "this pass has new current content". When a pass is created, refreshed or gets a
   new active version, the card presses to .965, springs back and one foil band sweeps the
   visible face. Triggered by data, not the click. Never on void, never while browsing versions
   (those crossfade in 160 ms in the same box).
3. **Deal.** Passes arriving on a page rise from 24 px with a slight 3D tip, 60 ms apart, on first
   load and on deep links; a shared-card morph replaces it. Voided passes enter quietly (fade and
   8 px, no tip, no glow, no tilt); voiding fades the glow (480 ms), settles the card once and
   stamps the `Ban` icon.
4. **Wizard finish.** The review step shows the live preview. Create morphs that card into the
   detail page preview, then it mints. The org's first pass also celebrates.
5. **Portal Add and Refresh.** The badge never moves. Pressing it dips the card 6 px towards it
   (420 ms) as the download starts; nothing claims success. Refresh runs a 2 px foil sync rail
   under the card while pending, then the card mints and the existing toast shows. The QR dialog
   sweeps a scan line over the code once (900 ms).
6. **Sliding indicators.** Sidebar, portal nav, tabs and segmented controls share one indicator.
7. **Entity art.** See above.
8. **Sign-in: "the wallet fills"** (owner direction 2026-11-01, R5: cute, playful, short).

   | Beat | Motion |
   | --- | --- |
   | Scene | The `wallet` mascot (128×96; 112×84 under 640) sits behind the hosted card's top edge, which hides the pocket's bottom; three mini passes in foil teal, violet and gold fan out of the pocket from one pivot at its bottom centre |
   | Load | Pocket rises 8 px and fades in (0–200 ms). Cards pop out (bounce, 60 ms apart) and fan to −18°, 0°, 18° (100–540 ms). Eyes open (scaleY 0 → 1, 120 ms) at 480 ms. Done by 600 ms, inside the art budget. The form works from 0 ms. A hidden tab holds every animation (`data-paused`), so the entrance and the idle beat play when someone looks |
   | Idle | One bob (±3 px, ±1°, one cycle) and one blink at 2.4 s (scaleY 1 → .1 → 1, 140 ms). Fine pointers: the wallet sways 1.5° and the fan 2.5° more towards the pointer (4° in all) and the eyes look at it (±1.5 px). Typing: the eyes look down at the field and follow the text across it, back to the pointer on blur or after 1.5 s. Nothing moves on its own after 5 s |
   | Email | When the address is valid, the top card lifts 6 px (200 ms spring) and its first letter stamps on (1.9 → 1, 280 ms bounce) |
   | Send link | The top card hops out over the pocket's right shoulder and drops behind the card like a letter going out (320 ms: ease-out up, ease-in down, fading at the end); the other two close to ±10° and the eyes look down. After 120 ms the card flips (640 ms spring) to the code face, the far face inert; focus moves to the code field at 500 ms |
   | Code | Each digit pops into its slot (.6 → 1, 140 ms spring), grouped `123 456`. Complete: the field glows teal once (300 ms). Wrong or expired: the pocket shakes once (240 ms) and the eyes go flat for 600 ms; border and icon carry the error. Expired: an hourglass flips once |
   | Success | The posted card comes home from above and the fan slides into the pocket (18 px, 200–260 ms ease-in), then the pocket bounces (squash 1.06 × .9 → 1, 360 ms bounce) and the eyes close into a smile (240 ms bounce). Navigation starts at once; nothing delays it |
   | Polaris ID | Fine-pointer hover: one foil sweep along the button border (480 ms) |
   | Worker pages | Same scene, CSS only, static after load (`src/worker/ssr/hosted-art.*`: these states never ship in the app bundle). Confirm: a check pops on the top card (300 ms bounce). Link expired: the gold card pops out, greys and slips 18° further (480 ms spring); the eyes glance at it. No access: the fan closes under a padlock on the top card whose shackle drops (200 ms bounce). Break-glass: a key slides into a keyhole right of the clasp (200 ms) and turns, its bow going edge-on (280 ms spring); the eyes glance at it |
   | Reduced motion | The fanned frame, eyes open; faces and states swap with a fade of 150 ms or less (the letter shows on the resting card, the posted card fades, the smile fades in); no bob, blink, lift, drop, shake, sway or look |

   SVG and CSS on tokens, transform and opacity only, no library. The badge never appears here.
   Copy stays as terse as the reference: the fun is all in the motion.
9. **Celebrations.** Milestones only, from data: an org's first pass, a template import with zero
   issues, a connection's first successful sync. Six foil sparks (2×6 px) fly 14 px out from the
   target with rotation and fade (640 ms, 40 ms apart), once. One per screen, never on lists.
10. **Upload template assembles.** The drop zone holds the `template` art: drag-over lifts its
    pieces 4 px, each server step lands the next piece (360 ms spring), success stamps the seal
    (420 ms bounce) and deals the sample still into the report column; a failure slides the
    failing piece out and shakes the outline once. The buddy rides on the zone (Buddy cameos).

## Expressive visual language

- **Colour.** Teal stays the only interactive accent. Foil is light, never a fill: mint sweep, art
  hero edges, sparks, the login cards, the 2 px top edge of the sign-in card and the email header.
  Never on text, buttons or page backgrounds.
- **Depth, dark.** Raised surfaces: `--wl-edge` lit top edge plus elevation-1. Overlays:
  elevation-3 and a lit edge. Pass glow: radial gradient in the pass background colour at 32%
  (20% light), clipped to the pass footprint plus 24 px; rim on dark passes. Primary button: accent
  glow on hover and keyboard focus.
- **Depth, light.** No lit edge; the pass glow reads as a tinted soft shadow; elevations unchanged.
- **Typography.** Rubik only. Page titles `text-2xl font-semibold` with
  `tracking-[-0.015em]`; portal titles `text-3xl` at ≥640. Stat values `text-3xl font-semibold
  tabular-nums`. No marketing display scale in product (brand rule).
- **Iconography.** One glyph per entity and per action (ui-consistency.md "Entity identity").
  Template gallery and passes list show stills of the pass.
- **Pass art.** Never restyled. Only the stage around it is ours. A still shows exactly the pass:
  its art, its real colours and Wallet's truncation.

## Guardrails

- **Reduced motion means no movement, not no feedback.** Under `prefers-reduced-motion: reduce`:
  no translate, scale, rotate, 3D, art entrances, beats, view transitions, tilt or highlight.
  Kept: opacity swaps of 150 ms or less (theme, tab panel, wizard step, login faces, version
  crossfade) and `.wl-essential` loops (spinners, pending rings, loading and sync rails), which
  carry state. Skeletons keep their 150 ms delay without the pulse. Counts show the value; mint
  shows nothing. No blanket reset in `base.css`; each module states its own reduce block.
- **Transform and opacity only.** Nothing animates size, position or `filter`; nothing shifts
  layout. Entrances use `animation-fill-mode: backwards`. No `will-change`, no blur filters on
  grids. SSR hover changes background colour, not `filter`.
- **Motion follows data.** Success motion plays when the server confirms. Refetch, filter, sort
  and cached revisits never re-enter. Failures shake only after a user action.
- **Never block input or delay content.** Total stagger ≤360 ms; routes ≤270 ms; data never waits
  for motion; navigation never waits more than 320 ms.
- **The badge.** Apple's artwork never animates: no entrance, glow, press scale or dimming.
- **Focus and a11y.** Navigation focuses the `h1`. Hidden faces are `inert`. Art is
  `aria-hidden`. Motion never carries meaning alone. Glow and edges never lower text contrast.
- **Pass fidelity.** Faces keep their own size; the back fills the front's box and scrolls, as in
  Wallet.
- **Copy.** Terse, unchanged. No new words for flair.
- **Email.** No animation, no GIFs: static foil line only.
- **SSR and CSP.** Worker pages use CSS only: a checkbox flips the public pass, keyframes run on
  load. Style nonces; no inline scripts.
- **Budget.** No new dependency. `motion.css` + `stage.css` ≤4 kB gzip; art ≤8 kB gzip; motion
  hooks ≤1.5 kB. One rAF-throttled pointer listener per visible stage.

## Library decision

CSS, the View Transitions API, Radix `data-state` and small hooks (`useArrival`, `useCountUp`,
`useChangeCount`, `useMintedOnArrival`, `useInsertHighlight`, `removeWithTransition`, the stage
tilt, the sheet drag). No motion library.

- `motion` costs about 34 kB gzip (20 kB with `LazyMotion`). Its strengths are covered: row removal
  reflows through same-document View Transitions, exits are Radix Presence, and the two gestures
  (tilt, sheet drag) map pointer events to CSS variables.
- Support: route and removal transitions need View Transitions (types: Chrome 125+, Safari 18.2+);
  other browsers update instantly. `linear()` and `@starting-style` fall back to no easing curve
  or no entrance.

## Where it lives

| Piece | File |
| --- | --- |
| Tokens, route fade-through, list entrances, loading rail | `src/web/styles/motion.css` |
| Overlays, controls, skeleton, ring, indicator, verbs, sparks | `src/web/styles/kit-motion.css` (split when it nears 300 lines) |
| Entity art and the mascot | `src/web/ui/art/*.tsx`, `src/web/ui/art/*.css`, `ART_CSS` for SSR |
| Entity and action registries | `src/web/lib/entities.ts`, `src/web/lib/action-icons.ts` |
| Hooks | `src/web/lib/motion.ts` |
| Online state | `src/web/lib/online.ts` |
| Pass stage (glow, rim, tilt, flip, deal, mint, dip, sync rail) | `src/web/pass-card/stage.{tsx,css}` |
| Sliding indicator | `src/web/ui/active-indicator.tsx` |
| Wizard, stepper | `src/web/ui/wizard.tsx` |
| Route transition types, chunk-load errors (offline chunks: `lib/offline-routes.ts`) | `src/web/router.tsx` |
| Sign-in scene | `src/web/portal/login-*.tsx` on `src/web/ui/art/wallet.tsx` |
| SSR scene, error pages | `src/worker/ssr/{theme,hosted,hosted-art}.*`, `src/worker/ssr/error-page.tsx`, `src/worker/modules/auth/pages.ts` |
| Public page tilt (fine pointers) | `public/pass-tilt.js` |
| e2e with reduced motion | `playwright.config.ts` |
