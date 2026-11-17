# PassBook brand guide

PassBook creates, issues and updates Apple Wallet passes for organizations. Its identity is
practical, tactile and quietly playful: clear words, teal actions, real pass artwork and a small
wallet buddy that responds to what is happening.

Use this guide for product, documentation and brand materials. The [visual edition](brand-guide/passbook-brand-guide.pdf)
shows the actual marks, components and email artwork. The [standalone HTML edition](brand-guide/passbook-brand-guide.html)
has the same pages. Edition 1, November 2026.

## Brand foundation

| Principle | In practice |
| --- | --- |
| Clear | Name the task and give the next action. Keep labels short. |
| Tactile | Passes deal, fan, flip and catch a little light. Preserve their real content. |
| Friendly | The buddy supplies expression. Copy stays useful and calm. |
| Responsive | Feedback follows the action and the server result. Input never waits for animation. |
| Respectful | An organization's identity leads wherever someone receives its pass. |

**Short description:** Create, issue and update Apple Wallet passes.

**Technical description:** Multi-tenant Apple Wallet pass platform on Cloudflare Workers.

Write **PassBook**, with capital P and B, as one word. Use the same spelling in headings,
navigation and email. Use **Apple Wallet** for the destination app and **Polaris ID** for the
sign-in option. The repository's internal `wallet` names are not alternative product names.

PassBook uses the Polaris Key design foundation: Rubik, shared UI tokens and violet/gold foil
colors. PassBook's face mark and teal action color identify the product. Do not substitute a
Polaris Key logo for the PassBook mark.

## Logo system

| Form | Source | Use |
| --- | --- | --- |
| Wordmark | `src/web/ui/layout/wordmark.tsx` | Default identity in console and portal headers; hosted sign-in |
| Open face mark | `src/web/ui/layout/brand-mark.tsx` and `.css` | Part of the wordmark; compact identity where the name is already clear |
| Tiled face | `public/favicon.svg`, `public/apple-touch-icon.png` | Browser/app icon; OIDC logo and sign-in email header |
| Buddy face | `src/web/ui/art/face.tsx` | Success toasts and status feedback; an illustration, not a replacement wordmark |

The face mark has an open pocket, two eyes, a smile and three fanned passes. Its outline is
teal; the passes are teal, violet and gold. The word is Rubik Semibold in the strong text color.
The favicon keeps its dark tile in both themes.

| Product lockup | Type | Mark | Gap |
| --- | --- | --- | --- |
| Standard | 16 px / 600 | 20 × 20 px | 8 px |
| Hosted sign-in | 20 px / 600, −0.015em tracking | 24 × 24 px | 10 px |

Keep the full name in the portal, including on phones. The open mark is drawn for 20–24 px;
use the supplied favicon for browser icon slots. Do not shrink a full buddy into a logo slot.

For standalone brand placements, this guide sets clear space of at least half the mark's width
around the complete lockup. This is a presentation convention; existing product header spacing
stays governed by its components. Large editorial lockups may scale proportionally.

Keep the artwork's proportions, pass order, smile and spacing. Do not stretch, rotate the whole
lockup, add shadows to the logo, fill its open pocket, outline the word, or set gradient text.
Use the theme-aware component on plain surfaces. Do not invent monochrome logo variants.

## Color

Teal identifies actions and selection. Neutral surfaces carry the interface. Violet and gold
belong to the passes and the foil detail, not to additional primary button styles.

| Role | Dark | Light | Source token |
| --- | --- | --- | --- |
| Page | `#060912` | `#F6F8FF` | `--pk-surface-page` |
| Raised surface | `#0D111B` | `#FFFFFF` | `--pk-surface-raised` |
| Sunken surface | `#020408` | `#EBEEF8` | `--pk-surface-sunken` |
| Strong text | `#FFFFFF` | `#060912` | `--pk-text-strong` |
| Body text | `#DBE4FF` | `#262D40` | `--pk-text-default` |
| Muted text, web app | `#8F98AD` | `#48536B` | `--pk-text-muted` |
| Subtle border | `#212633` | `#DADEE9` | `--pk-border-subtle` |
| Strong border | `#61697B` | `#7E8699` | `--pk-border-strong` |
| Action teal | `#2DD4BF` | `#0F766E` | `--pk-accent` |
| Text on teal | `#04201C` | `#FFFFFF` | `--pk-accent-on` |
| Subtle teal | `#0A2326` | `#D5F1ED` | `--pk-accent-subtle` |
| Focus | `#5EEAD4` | `#0F766E` | `--pk-focus` |
| Foil violet | `#9A5CFF` | `#7A2FFF` | `--wl-foil-2` |
| Foil gold | `#FFC24D` | `#D07A00` | `--wl-foil-3` |

Dark SSR pages and emails use `#B5BED3` for muted text; the web app intentionally uses
`#8F98AD`. Keep these channel differences. Source values live in the brand package,
`src/web/styles/wallet.css`, `src/web/styles/motion.css`, `src/worker/ssr/theme.ts` and
`src/worker/email/shell.ts`.

Foil runs teal → violet at 55% → gold, at 115°. Use it as light: a mint sweep, a thin art edge,
celebration sparks, the sign-in card edge or the email header's 3 px rule. The individual passes
use those three colors as solid fills. Never use the gradient on page backgrounds, text or buttons.

Status colors retain their meaning: green for healthy/complete, amber for attention, red for
failure, blue for neutral information, teal for selection, neutral for inactive or origin.
Always pair status color with a label and the established icon. Read exact colors from the
semantic tokens; never borrow foil violet to mean “Processing.”

Use `#04201C` text on dark-theme teal buttons and white on light-theme teal buttons. These pairs
have approximately 9.18:1 and 5.47:1 contrast respectively. Do not put white text on `#2DD4BF`.
Check other text/background combinations in context; pass artwork keeps its own colors.

## Typography and shape

Rubik is the brand sans. Use 400 for body, 500 for labels and 600 for headings and the wordmark.
JetBrains Mono is the web app's utility face for codes, IDs, hashes and JSON. SSR code fields and
email use their system monospace stack; email body text uses the system sans stack.

| Role | Size / line height at a 16 px root | Weight |
| --- | --- | --- |
| Product page title | 24 / 32 px, −0.015em tracking | 600 |
| Portal title at ≥640 px; stat value | 30 / 36 px | 600 |
| Section heading; dialog title | 16 / 24 px | 600 |
| Card title | 14 / 20 px | 600 |
| Field label | 14 / 20 px | 500 |
| Body and values | 14 / 20 px | 400 |
| Metadata and help | 12 / 16 px | 400 |
| Technical values | 12 / 16 px, monospace | 400 |

Use tabular numerals for statistics. Preserve iOS Dynamic Type on holder pages. Large type in
the visual guide is editorial display only; it does not extend the product's type scale.

Shapes come from the UI kit: 6 px control radius, 10 px large radius, 18 px extra-large radius.
Prefer fine borders, generous space around the task and a restrained raised surface. Dark
surfaces can have a 1 px lit top edge; light surfaces use a quiet shadow. Use 44 px touch targets.

## Voice and copy

Say what happened and what to do. Use sentence case for headings, fields and actions; established
status pills use Title Case. Personality comes from illustration and motion, never extra copy.

| Situation | Existing wording |
| --- | --- |
| Sign-in title | Sign in |
| Primary action | Email me a sign-in link |
| Alternative | Sign in with Polaris ID |
| Sign-in footer | Signing in shows the passes sent to your email. |
| Email subject | Your sign-in link |
| Email heading | Sign in to PassBook |
| Invalid field | Enter a valid email. |
| Expired link | Link expired / Request a new one to sign in. |
| Offline load | Could not load this page. Check your connection. |

Use **Built-in**, **Uploaded**, **Duplicate**, **Details**, **All organizations** and **Polaris ID**.
Keep action verbs distinct: **Update devices**, **Pull from source**, **Sync now**, **Reload list**;
reserve **Refresh** for the portal. Avoid internal terms such as Baked, Clone, Render and Pocket ID.

Errors need a plain sentence and a recovery action. Keep request IDs and raw codes under Details.
Do not add mascot dialogue, puns, “Oops!”, emoji or celebratory copy to routine tasks. A buddy's
expression must never imply a successful operation before it is confirmed.

## The buddy

The buddy is a small wallet: a stitched pocket, a teal clasp with eyes and a mouth, and three
passes that can act like arms. In seated scenes its legs hang over the host's edge. It is the
same character as the face in the mark, expressed at illustration scale.

Keep the pocket, stitch line, clasp and pass fan intact. The default fan opens to −18°, 0°, 18°;
documented moods and scenes can change it. Use the existing SVG component and theme tokens.
Do not redraw it as a person, add unrelated props or give faces to the other entity illustrations.

| Expression | Appearance | Use |
| --- | --- | --- |
| Default | Open eyes and a small smile | Sign-in at rest |
| Happy | Eyes smile shut | Confirmed milestones; sign-in link email |
| Curious | Raised brow, eyes up and aside | Empty lists; confirm-email message |
| Sad | Worried brows, frown, slumped pocket and drooping passes | Failure, refusal, lost or expired link |
| Flat | Half-shut eyes, straight mouth | Empty audit log; brief incorrect-code response |

Use one active buddy per view, at a meaningful moment. Seat it on the host's top edge; reserve
11/12 of its art height above the edge. Standard art is 96 × 72 px; compact is 64 × 48 px.
The sign-in scene uses 128 × 96 px, or 112 × 84 px below 640 px. Do not crop the fan or feet.

The buddy is decorative in product: `aria-hidden`, never focusable. A title and an action must
explain the state without it. Clicking painted art can replay a scene, but must not trigger the
parent card or link. Reduced motion shows the resting pose and disables replay.

Email uses the existing happy/curious PNGs at a displayed 96 × 76 px, with 2× and 3× sources.
They sit on the bottom edge of the dark PassBook header. Use empty alt text and a fixed box so
blocked images do not change the layout. Pass-delivery emails belong to the organization and
do not carry the buddy.

## Illustration and motion

Each entity has one illustration and one verb: passes fan, templates assemble, connections
connect, organizations light up, identities stamp, keys turn, deliveries open. Use the registry
in `src/web/ui/art/registry.ts`; entity and action icons come from `src/web/lib/entities.ts`
and `src/web/lib/action-icons.ts`.

Entity art uses a 96 × 72 viewBox, 1.5 px non-scaling strokes, round joins/caps, neutral surfaces
and one accent part. Foil is a 2 px hero edge. No text in the illustration. Use Lucide for UI
glyphs: 16 px in buttons/nav, 14 px in pills and 20 px in entity tiles.

| Motion | Timing | Meaning |
| --- | --- | --- |
| Controls and chrome | 80–280 ms | Immediate response |
| Entity art entrance | 400–600 ms, once | Show what the thing is |
| Pass deal / flip / mint | 480 / 640 / 900 ms | Arrival / details / new current content |
| Buddy scene | 1–4 s after landing | Act out the current state, then settle |

Useful scenes: `search` for an empty portal, `inspect` for an empty entity list, `sweep` for no
filter matches, `mend` for a torn pass, `tug` for no access, `plug` for an error, `peek` for a lost
item and `cheer` for a successful import. Use `wave` for a created pass, `tear` when voided this
visit and `nudge` for a pass not yet on a device. See the motion spec for exact triggers.

One signature moment per screen. Scenes start after the art lands and settle within five seconds
of mount; only pending-state indicators loop. The wordmark's hello runs once per browser session
and does not compete with the sign-in scene. Animate transform and opacity; never delay input.

Reduced motion keeps the final pose, short fades of at most 150 ms and essential pending
indicators. Remove decorative movement, tilt, wink and mint sweeps. Email is static.

## Brand across surfaces

| Surface | Identity that leads | Expression |
| --- | --- | --- |
| Admin console | PassBook wordmark | Teal controls; entity-specific art |
| Portal | Full PassBook wordmark | Real passes and their org names; buddy at meaningful states |
| Sign-in and auth pages | PassBook wordmark | One buddy on the card edge; email-first action |
| Sign-in and verify-email messages | PassBook tiled face and name | Static happy or curious buddy; foil top rule |
| Public pass page and pass-delivery email | Organization logo or name | Org colors and actual pass content |
| Installed pass | Organization identity | Org logo, icon, name and colors; truthful pass artwork |

The pass remains the primary object. Show its real colors, field limits and barcode; a preview
must not “improve” its appearance. PassBook can shape the stage around it. Never put the platform
mark on an organization's pass or make its artwork adopt the page theme.

Use the supplied Apple Wallet badge unchanged, next to the pass, secondary to the pass and org
identity. No custom badge, recoloring, animation, dimming or press scaling. The repo's badge
spec uses 40–48 px height, 44 px on touch, with clear space of at least 0.1 × height.

**Asset handoff:** `public/apple/README.md` records that the current badge files are interim
copies. The owner still needs to supply Apple's official kit and complete its license record.
Do not describe the current badge set as a finalized official asset package. The intended
black/light and outline/dark variants currently contain identical artwork.

## Asset map and maintenance

| Need | Canonical path |
| --- | --- |
| Logo geometry and lockup | `src/web/ui/layout/{brand-mark,wordmark}.tsx`, `brand-mark.css` |
| Tile artwork | `public/favicon.svg`, `public/apple-touch-icon.png` |
| Buddy and expressions | `src/web/ui/art/{wallet,buddy,face,cameo}.tsx`, `art-wallet.css` |
| Buddy scene behavior | `src/web/ui/art/scenes/`, `replay.ts`; `public/buddy-replay.js` |
| Static email buddy | `public/email/buddy-{happy,curious}@{2,3}x.png` |
| Entity illustrations | `src/web/ui/art/registry.ts` and named components |
| Type | `public/fonts/rubik-var-latin.woff2`; `@polaris-key/brand/fonts` |
| Colors and motion | `src/web/styles/{wallet,motion}.css`; `@polaris-key/brand/tokens.css` |
| Email composition and copy | `src/worker/email/{shell,sign-in,pass,buddy}.ts` |
| Apple badge and provenance | `public/apple/badge/en/`, `public/apple/README.md` |

Template-specific logos and artwork in `templates/` belong to their sample organizations or
pass designs. They are not PassBook logo alternatives.

Before sharing: check the spelling, the correct logo form, light/dark contrast, the buddy's mood,
the next action, organization priority, truthful pass content and reduced-motion behavior.
Inspect at desktop and phone widths, and check exported pages for clipped art or text.

The visual edition renders the source components; it does not define replacement SVG masters.
Rebuild it from the repo root with `node docs/design/brand-guide/build.mjs`. This also produces
the PDF and checks for page overflow, missing images and missing fonts. Preview captures and a
contact sheet are written to `/private/tmp/passbook-brand-guide-review/`.

Edit `pages.html` and the four guide stylesheets for the visual edition. The local Biome config
excludes only the generated HTML, whose embedded component CSS and SVG are checked at source.
Keep `font-licenses.txt` with the exported HTML/PDF when distributing the guide.

Related rules: [UX principles](ux-principles.md), [UI consistency](ui-consistency.md),
[motion and expression](motion-and-expression.md). Those specs govern product implementation;
this guide consolidates the brand and adds the standalone-logo clear-space convention above.
