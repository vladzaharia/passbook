# UX principles

How Wallet behaves on every screen and flow. Visual rules: [ui-consistency.md](ui-consistency.md).
Motion: [motion-and-expression.md](motion-and-expression.md). The Apple rules below win wherever
Apple requires something (badge artwork, Wallet messaging, pass design).

## People

| Who | Where | Wants |
| --- | --- | --- |
| Operator | Console; desktop and iPad | Issue, fix and update passes for many orgs, fast and safely |
| Holder | Portal, `/p`, email; mostly iPhone | Get the pass into Wallet. Nothing else |

## UX rules

1. **The next step is one click.** Every result screen offers the obvious next action.

   | Result | Next |
   | --- | --- |
   | Empty platform | Overview "Get started" checklist |
   | Org created | Checklist: Assign a template, Issue a pass, Connect a source |
   | Template opened or uploaded | New pass, Upload version, Update N passes |
   | Pass created or reassigned | Send email, Copy link |
   | Link rotated | The new link with Copy and Email |

2. **One scope control.** The top-bar org switcher is the only org scope. Lists, overview, audit,
   wizards and list footers read it; wizards prefill it and skip steps with one choice. It hides
   on pages it does not scope (Users, Settings, Status, Apple identities). No page-level Org select.
3. **Guard by blast radius, the same way everywhere.**
   - Anything that reaches a holder's device or many records (void, bulk actions, suspend org,
     disable user, disable magic link, rotate link, reissue) confirms with the consequence and a
     count, in a danger button.
   - Typed confirms use a human word: the title (up to 24 characters), the slug, else `delete`.
     Case-insensitive, trimmed. Never a UUID.
   - Row menus, bulk bars and palette actions use the guard the header uses.
   - Self-harm is blocked before the confirm (no Disable on your own account).
   - Secrets shown once are labelled and masked; Done waits for "I saved the secret".
4. **One meaning per word.** No raw codes, ids or enums beside labels; codes live in drawers and
   details, in `xs` mono.

   | Say | Never |
   | --- | --- |
   | Built-in, Uploaded | Baked |
   | Claimed, Not claimed, No holder | Owned, Waiting, Unassigned |
   | Update devices (push), Pull from source (bound pass), Sync now (connection), Reload list (icon), Refresh (portal only) | Refresh for all of them |
   | Duplicate | Customize, Clone |
   | All organizations | Any org, None |
   | Preview (a version) | Render |
   | Details (back of a pass) | Show back, Back |
   | Paused after repeated failures | Breaker |
   | Polaris ID | Pocket ID |

5. **Specific, quiet states.** Every entity has its own art (ui-consistency.md "Entity identity").
   Filtered-empty differs from truly empty. Inside cards, empty is one inline line with small art.
   Not found names the thing and offers a way back. Errors are one sentence plus Retry, never raw
   JSON on any surface, worker HTML routes included. Offline is visible and the app stays put.
6. **Mobile is content-first.**
   - Pass and template previews collapse below 1024 so tabs and fields sit in the first screen.
   - Customer actions are 44 px; console controls are 44 px on touch.
   - Phone confirms and menus open as bottom sheets.
   - More than five tabs become a select below 640.
   - Next and Save stay on screen (sticky bars).
7. **The holder is a person with an email.**
   - `/login` leads with the email path; Polaris ID is the alternative.
   - Off iPhone the QR leads ("Scan with your iPhone.").
   - Emails show what the pass is before the badge.
   - Account email flows never dead-end: a pending address shows with Resend and Cancel.
   - Holder views lead with the org's identity, not the platform's.
8. **Forms help, never trap.** A blocked submit focuses the first invalid field and announces one
   summary. Defaults are real values; examples are placeholders. Wizards keep state on Back and
   on step jumps. Page forms save through the SaveBar.
9. **One signature moment per screen.** Login has its own (R5); the rest is chrome.
10. **Terse copy.** Short plain labels, no filler, errors in one sentence (what happened, what to
    do). Fun comes from art and motion, never from more words.

## Apple rules

### Add to Apple Wallet badge

- Apple's badge artwork only: SVG from Apple's kit, unmodified, locale matching the page language,
  black on light grounds, outline on dark. Email uses a PNG export of Apple's artwork.
- Never recreate, restyle, dim, animate, glow or press-scale it. No custom "Add to Apple Wallet"
  buttons anywhere, bundles included (badge plus a plain label beside it: `All passes (3)`).
- Height 40–48 px (44 on touch); clear space at least 0.1 × height.
- Next to the pass, and secondary to the pass and the org's identity.
- iPhone, iPod and Mac can add. Everywhere else (iPad included) show the QR and one line:
  `Open on iPhone or Mac to add to Apple Wallet.` In-app browsers: `Open in Safari to add to Apple Wallet.`
  These are the only added sentences.
- Never show the bare word "Wallet" as a brand in a view that shows the badge.
- A pass already registered on a device shows `In Wallet` and leaves the Add all bundle.
- Licence, source and credit line: `public/apple/README.md`.

### Pass design

- Tenant identity: every pass carries the org's logo, icon, name (`logoText`, `eventLogoText`),
  colours and the description `{Org} {kind}` ("Northwind Climbing membership card"). Never the
  platform's "Wallet" or "W".
- Images: PNG at @2x and @3x only, tight to content (no padding), small files.

  | Slot | Size (pt) | Notes |
  | --- | --- | --- |
  | logo | 50–160 × 50 | Leading-aligned, no padding |
  | primaryLogo | 30–126 × 30 | Poster passes, semantic boarding passes |
  | secondaryLogo | 12–135 × 12 | Poster passes |
  | icon | 38 × 38 | Required |
  | strip | 375 × 144 | Motif at the trailing or bottom edge |
  | thumbnail | 60–90 × 90 | Rounded corners, transparent |
  | background | 343 × 503 | |
  | artwork | 358 × 448 | Poster |
  | footer | 268 × 15 | Boarding passes (286 warns as legacy) |

- Size: pkpass at most about 400 KB, any image at most about 200 KB.
- Front: essentials only, one line per field (header ≈12, primary ≈20, secondary and auxiliary
  ≈22 characters). No URLs on the front (Wallet does not link them); the rest goes to the back.
- Back: contact for the signer (platform "Pass service") and for the org.
- `changeMessage` only on time-critical fields (gate, time, status, balance, tier), never on free
  text. Editors opt in per save with "Notify holders".
- Times in the venue's or airport's local time (`ignoresTimeZone`); `relevantDates` as windows.
- Contrast: foreground at least 4.5:1 and labels at least 3:1 against the background.
- Localise through `pass.strings` with sentence-case keys and labels.
- Template lint enforces these as warnings: `COLOR_CONTRAST`, `FIELD_LENGTH`, `PLACEHOLDER_URL`,
  `BACK_CONTACT`, `CHANGE_MESSAGE_FREE_TEXT`, `LOGO_TEXT_PLATFORM`, `PLATFORM_BRANDING`,
  `PASS_SIZE`, `IMAGE_BYTES`, `IMAGE_PADDING`, `THUMBNAIL_CORNERS`, `LOCAL_TIME`, and
  `POSTER_LINEAR_BARCODE` (info). One image-slot spec (`src/passkit/schema`) serves the engine
  validator, the template analyzer and the override API.

### Truthful previews

- The admin preview, portal and `/p` draw what Wallet draws: real colours (no legibility fixes),
  the per-style field limits, one-line truncation, a barcode that is never clipped.
- Style per target: `iOS 27` and `iOS 26 and earlier`, including the posterGeneric → generic
  fallback and NFC poster event tickets. The toggle shows only when the faces differ.
- Poster event tickets and semantic boarding passes lay out from semantics and carry `Approximate`.
- A still shows exactly the pass: art, colour and truncation.

### iPhone Safari standard

Customer pages always; the console on touch devices.

- Hit areas of 44 pt under `pointer: coarse`; visual density may stay for fine pointers.
- Form text 16 px so focus never zooms. Never `maximum-scale`.
- `viewport-fit=cover` is set, so every edge-anchored element insets by `env(safe-area-inset-*)`.
- Reflow at 200 %: no horizontal scroll, key-value pairs stack, buttons wrap, no min widths.
- Dynamic Type on customer pages through `-apple-system-body`.
- `<html lang>` matches the copy (`en` today).
- Holder surfaces follow the system appearance; no app theme toggle.
- `prefers-reduced-motion` respected; transform and opacity only; nothing moves on the badge.
- Errors render as HTML pages.
- `apple-touch-icon` (180 × 180), `theme-color` per scheme, `format-detection: telephone=no`.
