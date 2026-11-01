# Motion and expression

How Wallet moves, catches light and shows personality. Extends
[ui-consistency.md](ui-consistency.md); layout, density and copy rules there still hold. Tokens:
`src/web/styles/motion.css` (on the @polaris-key/brand motion scale). Pass presentation:
`src/web/pass-card/stage.{tsx,css}`.

## Personality

Tactile, quick, a little holographic. Passes act like cards you can pick up; the console around
them answers fast and stays out of the way. Fun comes from how things move and catch light, never
from more words.

Two speeds:

| Layer | Things | Duration | Easing |
| --- | --- | --- | --- |
| Chrome | Buttons, menus, dialogs, tabs, routes, rows | 80–260 ms | ease-out in, ease-in out |
| Cards | Passes, pass tiles, nav pill | 480–640 ms | spring, 3D |

## Where it is flat today

| Surface | Today | Direction |
| --- | --- | --- |
| All | Nothing moves; route changes cut; one teal on near-black; identical bordered boxes | Two-speed motion, lit edges, pass-coloured glow |
| Pass card (everywhere) | Flat image in a box; Show back swaps instantly; public page uses a disclosure | One stage: glow, tilt, flip, deal, mint |
| Overview | Eight identical KPI boxes, static | Larger tabular stats that count; status pulse |
| Templates list | Text table for a visual product | 32 px still of the sample pass in the first column |
| New-pass wizard | Review step has no preview; Create cuts to detail | Preview on review; card morphs into the detail page and mints |
| Empty states | Dashed box, grey icon | Pass-stack illustration that fans open once |
| Sign-in, SSR auth | Heading and box floating on an empty page | Card rises once; wordmark flips once; magic-link step flips the card |
| Emails | Slate bar, plain title | 3 px foil line over the org bar (static, teal fallback) |

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--wl-dur-press` | 80 ms (`pk-duration-micro`) | Press feedback |
| `--wl-dur-hover` | 120 ms | Colour and hover |
| `--wl-dur-exit` | 120 ms | Overlay and route exits |
| `--wl-dur-enter` | 200 ms (`pk-duration-base`) | Overlays, rows, toasts, panels |
| `--wl-dur-route` | 260 ms (`pk-duration-moderate`) | Route enter |
| `--wl-dur-card` | 480 ms (`pk-duration-deliberate`) | Deal, nav pill, shared-card morph |
| `--wl-dur-flip` | 640 ms | Pass flip |
| `--wl-dur-sheen` | 900 ms | Mint sweep |
| `--wl-dur-count` | 600 ms | Number count |
| `--wl-ease-out` | `pk-ease-enter` | Entrances |
| `--wl-ease-in` | `pk-ease-exit` | Exits |
| `--wl-ease-move` | `pk-ease-standard` | Moves within a page |
| `--wl-ease-spring` | `pk-ease-spring` (4% overshoot) | Cards, flip, pill |
| `--wl-ease-bounce` | `linear()`, 13% overshoot | Celebration only (mint settle, check pop) |
| `--wl-rise` | 8 px | Entrance rise |
| `--wl-slide` | 16 px | Route slide by depth |
| `--wl-deal` | 24 px | Card deal |
| `--wl-tilt` | 7° per axis | Pass tilt |
| press scale | 0.98 (`pk-motion-scale-press`); mint 0.965 | Buttons; mint |
| `--wl-stagger` | 30 ms rows, 60 ms cards; cap 6 steps | Lists; last item starts by 180/360 ms |
| `--wl-foil` | teal → Polaris violet → Polaris gold | Mint sweep, empty-state art, sign-in and email top edge |
| `--wl-edge` | `inset 0 1px 0 rgb(255 255 255 / .05)`, dark only | Lit top edge on raised surfaces |
| `--wl-glow-accent` | accent at 70%, 24 px blur (55%, 14 px light) | Primary button hover and focus |

## What moves and when

| Thing | Motion | Rule |
| --- | --- | --- |
| Route change | Old main fades out 120 ms; new main fades in and rises 8 px; deeper path slides in 16 px from the right, shallower from the left | View Transitions through TanStack `defaultViewTransition` types. Path changes only: filters, sort, `?tab=`, `?v=` never animate. Sidebar and top bar never move |
| Shared pass card | List tile morphs into the detail card and back | `transitionName="pass-<id>"` on both; unmatched cards leave with main. Portal and wizard only, never 50 table rows |
| Nav and tab indicators | Pill slides to the new item, spring 480 ms | `ActiveIndicator` (transform only); same component for tabs |
| Tab panel | No motion: `?tab=` changes are instant; only the underline slides | — |
| List first load | Rows fade and rise 8 px, 30 ms stagger, cap 6 | Only when data arrives after a skeleton (`useArrival`); refetch, filter and sort never animate; appended pages do |
| Pass grids | Deal: rise 24 px, −2°, 0.96 scale, spring, 60 ms stagger | Portal My passes, template gallery and pickers |
| Dialog, popover, menu, select | In: fade, 0.98 scale and 4 px from the trigger side, 200 ms; out: fade 120 ms | Radix `data-state` keyframes and `--radix-*-transform-origin` |
| Sheet | Slide 260 ms in, 200 ms out | Overlay fades with it |
| Buttons | Press scale 0.98, 80 ms; hover colour 120 ms; dark primary gets the accent glow on hover | Loading keeps the button width |
| Switch, checkbox | Thumb slides on spring 200 ms; check pops 0.6 → 1 | — |
| Copy, saved | Icon swaps to a check with a bounce pop, back after 1.5 s | Same label |
| Toasts | Sonner's own slide; the icon pops | Copy unchanged |
| Skeleton → content | Skeleton appears only after 150 ms (`pk-delay-skeleton`); lists, totals and grids that replace it rise in | No layout change |
| Numbers | Count from the old value (first load from 0), 600 ms ease-out, tabular-nums | `CountUp`; tests and reduced motion show the value at once |
| Status change | One ring pulse in the pill's tone (scale 1 → 1.6, fade, 640 ms) | `StatusPill`, only when the value changes on screen |
| Save bar | Slides up on spring 260 ms | — |
| Focus ring | Instant | Never animated |

## Signature moments

1. **Pass stage** (`PassCardStage`, every pass on every surface). The pass lights the surface
   under it in its own background colour (a radial gradient, no blur filter). On fine pointers it tilts up to 7° towards the pointer
   with a soft highlight that follows it, and springs back on leave. Show back flips it in 3D
   (640 ms spring); the far face is `inert`. A single stage replaces the instant swap on admin,
   portal and the public page.
2. **Mint.** When a pass is created, refreshed or gets a new version, the card presses to 0.965,
   springs back, and one foil band sweeps across it. Triggered by data (`modifiedAt`,
   `lastRefreshedAt`, version), not by the click, so it means "this is the new pass".
3. **Deal.** Passes arriving on a page rise from 24 px with a slight 3D tip, 60 ms apart. Public
   page and portal grid on first load; template gallery.
4. **Wizard finish.** The review step shows the live preview. Create morphs that card into the
   detail page preview (shared transition name), then it mints. No confetti.
5. **Portal Add to Apple Wallet and Refresh.** Add dips the card 6 px towards the button
   (420 ms) as the download starts; nothing claims success, since the page cannot know. Refresh:
   the spinner becomes a check pop, the card mints, and the existing "Pass updated" toast shows.
6. **Sliding pills.** The sidebar, portal nav and tabs share one sliding indicator.
7. **Empty states.** One illustration: three blank pass silhouettes fanned −6°, 0°, 6°, the
   page's Lucide icon on the top card, a 1 px foil edge. It fans open once (480 ms spring).
   SVG and CSS on tokens; same title and single action as today.
8. **Sign-in.** The card rises once (260 ms) and the wordmark card flips once. Requesting a magic
   link flips the card to the code step. SSR auth pages get the same rise in CSS only.

## Expressive visual language

- **Colour.** Teal stays the only interactive accent. The foil gradient is a light effect, never
  a fill: mint sweep, empty-state art edge, the 2 px top edge of the sign-in card and the email
  header bar. Never on text, buttons or page backgrounds.
- **Depth, dark.** Raised surfaces: `--wl-edge` lit top edge plus elevation-1. Overlays:
  elevation-3 and a lit edge. Pass glow: radial gradient in the pass background colour at 50%.
  Primary button: accent glow on hover and keyboard focus.
- **Depth, light.** No lit edge; the pass glow reads as a tinted soft shadow; elevations unchanged.
- **Typography.** Rubik only. Page titles `text-2xl font-semibold` with
  `tracking-[-0.015em]` (`pk-tracking-heading`); portal titles `text-3xl` at ≥640. Stat values
  `text-3xl font-semibold tabular-nums`. No marketing display scale in product (brand rule).
- **Iconography.** Lucide everywhere; empty states use the pass-stack art around the icon.
  Templates list gets a 32 px still of the sample pass in the first column.
- **Pass art.** Never restyled. Only the stage around it (glow, tilt, highlight, flip, sheen) is
  ours; a still frame shows exactly the pass.

## Guardrails

- **Reduced motion.** `prefers-reduced-motion: reduce` turns off transitions, keyframes, view
  transitions, tilt and highlight. Flips and indicators jump; counts show the value; mint shows
  nothing. Spinners keep spinning (they carry state).
- **Transform and opacity only.** Nothing animates size or position properties; nothing shifts
  layout. Entrances use `animation-fill-mode: backwards` so finished animations hold no layer.
  No `will-change`, no blur filters on grids.
- **Never block input or delay content.** Total stagger ≤ 360 ms; route transitions ≤ 260 ms and
  start after loaders finish; data never waits for motion; no animation on refetch.
- **Focus and a11y.** Navigation still focuses the h1. The hidden pass face is `inert`. Motion
  never carries meaning alone (status text and icon change too). Dialogs focus a field marked
  `data-autofocus`. Check contrast in both themes: glow and edges must not lower text contrast.
- **Pass fidelity.** See above. Faces keep their own size; the back fills the front's box and
  scrolls, as in Wallet.
- **Copy.** Terse, unchanged. No new words for flair.
- **SSR and CSP.** Worker pages use CSS only: a checkbox flips the public pass, keyframes run on
  load. Inline style attributes are allowed there (`style-src-attr`); the SPA sets CSS variables
  through CSSOM. No inline scripts.
- **Performance budget.** No new dependency. `motion.css` + `stage.css` ≤ 4 kB gzip; motion hooks
  ≤ 1 kB. One rAF-throttled pointer listener per visible stage, fine pointers only.

## Library decision

CSS, the View Transitions API, Radix `data-state` and a few small hooks (`useArrival`,
`useCountUp`, `useChangeCount`, `useMintedOnArrival`, the stage's pointer tilt and replay). No
motion library.

- `motion` costs about 34 kB gzip for `motion` components, about 20 kB with `LazyMotion` +
  `domAnimation`, about 2.5 kB for the `animate` mini build. It earns that for velocity-based
  drag and swipe, layout animation of reflowing lists, and exit animation of unmounting trees. We
  have none: exits are Radix Presence, reflow is avoided, the one gesture (tilt) is pointer to
  CSS variables.
- Revisit for swipe-to-dismiss sheets, drag-to-reorder, or animated row removal.
- Support: route transitions need view-transition types (Chrome 125+, Safari 18.2+); other
  browsers navigate instantly. `linear()` and `@starting-style` fall back to no easing curve or no
  entrance.

## Where it lives

| Piece | File |
| --- | --- |
| Tokens, route transitions, list entrances | `src/web/styles/motion.css` |
| Overlays, controls, skeleton, ring, empty-state art, indicator | `src/web/styles/kit-motion.css` |
| Hooks | `src/web/lib/motion.ts` |
| Pass stage (glow, tilt, flip, deal, mint, dip) | `src/web/pass-card/stage.{tsx,css}` |
| Sliding nav and tab indicator | `src/web/ui/active-indicator.tsx` |
| Route transition types | `src/web/router.tsx` (`viewTransitionOption`) |
| SSR rise, foil edge, wordmark flip | `src/worker/ssr/theme.ts` (`SSR_CARD_CSS`) |
| Public page tilt (fine pointers) | `public/pass-tilt.js` |
| e2e runs with reduced motion | `playwright.config.ts` |

## ui-consistency.md wording (applied)

Replace the motion bullet under "Icons, focus, motion" with:

> - Motion: follow motion-and-expression.md. Chrome moves in 80–260 ms with ease-out; passes in
>   480–640 ms on a spring. Route changes move main only (fade with an 8 px rise, or a 16 px
>   slide by path depth); search-param changes never animate. Lists animate once, after their
>   skeleton, 30 ms apart, capped at six. Overlays open from their trigger in 200 ms and fade out
>   in 120 ms; sheets slide in 260 ms; nav and tab indicators slide. Only transform and opacity
>   animate. prefers-reduced-motion turns all of it off.

Add a section after "Icons, focus, motion":

> ## Passes and expression
>
> - Every pass renders through PassCardStage: glow in the pass colour, tilt and highlight on fine
>   pointers, 3D flip between faces, deal in on arrival, mint on change. The pass art is never
>   restyled.
> - Teal is the only interactive accent. The foil gradient is reserved for the mint sweep,
>   empty-state art and the sign-in card and email top edge.
> - Dark raised surfaces get a 1 px lit top edge; the primary button glows on hover and focus.

Change these rows: Typography "Page title" → `text-2xl font-semibold tracking-[-0.015em]`; "Stat
value" → `text-3xl font-semibold tabular-nums`, counts to its value. Empty, loading, error:
"EmptyState: pass-stack illustration (three fanned blank passes, icon on top), title text-sm
font-medium, one action. Skeleton appears after 150 ms."
