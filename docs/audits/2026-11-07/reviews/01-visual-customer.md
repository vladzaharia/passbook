# Customer visual audit

## Summary

The source shows a deliberate, cohesive design: the portal and public pass page share one layout, device-specific Wallet instructions, pass artwork, and Buddy states. Responsive breakpoints, loading/empty/error states, and dark-mode email styles are also present.

**One high-confidence customer-facing issue:** expired passes are treated as addable on **My passes** even though the pass card and detail page identify them as expired. A separate cold-load skeleton likely under-reserves space on the pass detail page. Email rendering has one narrow-content risk to verify, not a confirmed visual defect.

## Files

- `src/web/portal/my-passes-page.tsx:41-47,73-74,85-88,126-172,208-211` — pass-list state, card rendering, Wallet actions, bundle count, and loading/empty/error branches.
- `src/web/portal/pass-view.ts:24-30` — canonical holder-state derivation.
- `src/web/portal/holder-pass-view.tsx:41-115`, `holder-parts.tsx:15-84`, `holder-pass.css:1-95`, `add/add.css:1-160` — shared portal/public pass composition, status notices, responsive layout, and add instructions.
- `src/web/portal/pass-detail-page.tsx:115-148` — detail loading, error, and loaded states.
- `src/web/pass-card/PassCard.tsx:26-61`, `pass-card-base.css:1-24,122-142`, `pass-card-poster.css:1-15,146-154` — card states, proportions, text scaling, and label floors.
- `src/worker/modules/public/routes.ts:87-120`, `src/worker/ssr/pass-page.tsx:87-152` — public `/p/{token}` route and server-rendered active/expired/voided/removed pass page.
- `src/worker/email/pass.ts:87-109,129-164`, `src/worker/email/shell.ts:20-38,130-188` — pass email summary/actions, shared email shell, dark-mode tokens, and Outlook fallbacks.
- `src/web/portal/login-page.tsx:1-125`, `login-card.tsx:25-90`, `login-scene.css:1-100` — customer sign-in hierarchy, loading/error form states, and Buddy scenes.

## Architecture

`/` and `/passes/$passId` are SPA portal routes; `/p/{token}` is server-rendered. The detail route and public page share `HolderPassView`, while each supplies its own pass header/actions and state. Pass art is normalized from pass data and displayed by the shared pass-card components. Pass emails use a separate HTML renderer and token-derived shell; they are not rendered by those page components.

## Report

### P1 — Expired passes still offer Wallet installation from My passes

**Confidence:** High source evidence; rendered appearance is inferred from the shared card/status components.  
**Route/state:** `/` with an active-record pass whose `expirationDate` is in the past and which is not already in Wallet.

`toView(pass)` gives the card its expired state (`my-passes-page.tsx:85-88`; `PassCard.tsx:55-58`), but list eligibility checks only `status` and `removedAt` (`my-passes-page.tsx:41-45`). The same predicate drives the bundle count (`:172`), and the tile’s Apple Wallet badge is suppressed only for `voided` or `inWallet` (`:126-128`). By contrast, detail derives `expired` via `holderState` (`pass-view.ts:27-30`) and its add area has no install action.

**Fix:** Derive each tile’s holder state from its normalized view, and exclude expired passes from individual and bundle-add affordances; display an explicit expired state in the list.  
**Acceptance:** On `/`, an expired, not-in-Wallet pass has an expired indicator but no Apple Wallet badge or QR-add action; a mixed active/expired bundle includes only the active pass. Confirm active, voided, and removed tiles remain distinct.

### P2 — Cold pass-detail loading placeholder is shorter than the card

**Confidence:** Medium. Dimensions are source-confirmed; layout shift is inferred, not visually measured.  
**Route/state:** Cold/deep link to `/passes/:passId`, with the pass request delayed and no list data to seed the page.

The loading placeholder is fixed at `28rem` (`pass-detail-page.tsx:144-146`). The card’s default front uses a `320 / 460` aspect ratio (`pass-card-base.css:12-24`); at its `22rem` maximum width, the card alone is about `31.6rem` tall, before its side toggle and other stage elements. The placeholder therefore appears likely to grow noticeably when data arrives.

**Fix:** Reserve the loaded card-and-toggle footprint, or use a placeholder with the same responsive proportions.  
**Acceptance:** Capture a cold detail load at phone and desktop widths; the placeholder-to-pass transition should not cause a pronounced vertical jump or displace the details column.

### P2 — Verify long pass-field wrapping in email clients

**Confidence:** Low; source-based risk only, not a confirmed rendering defect.  
**Surface/state:** Pass-ready email with an unusually long, unbroken field value (for example, a long member or booking identifier), viewed in a narrow email client.

The pass summary uses a nested table; labels have `white-space:nowrap`, while value cells set no wrapping rule (`src/worker/email/pass.ts:96-109`). A long unbroken value may widen the summary or reduce readable space in some clients.

**Recommendation and acceptance:** Preview a long-value pass at a narrow viewport in major mail clients, including dark mode. Confirm no horizontal overflow, clipped field text, or obscured actions; only adjust wrapping if the preview demonstrates a failure.

## Browser-proof scenarios

- **`/`**: active, in-Wallet, expired, voided, removed; empty list, loading, request error, and a mixed active/expired bundle.
- **`/passes/:passId`**: active, expired, voided, removed with and without a removal note, not found, cold loading, and request failure.
- **`/p/{token}`**: active on iPhone, Mac, and other-device layouts; expired, voided, and removed on phone and desktop; light and dark theme.
- **`/login`**: initial/loading, wrong or expired code, rate limit, network error, and reduced-motion behavior.
- **Pass-ready email**: short and long field values, narrow viewport, dark mode, and Outlook rendering. The inspected email renderer has no customer-facing browser route.

## Limits

This is a source audit only. I did not run checks or claim rendered visual proof. Responsive behavior, actual clipping/shift, color contrast with real pass artwork, and email-client rendering require the parent’s browser/client review.
