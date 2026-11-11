# Google and Samsung Wallet: 1.5-class product definition

Status: proposed, 2026-11-11. Owner decisions in §6 gate the build.
Target UX: `docs/audits/2026-11-07/mockups/` (customer-portal, other-surfaces, admin-interfaces), `wallet-badges/README.md`. Policy: `docs/audits/2026-11-07/reviews/control-ux-system.md`, `control-ux-redesign.md`, `27-wallet-providers.md`, `business-adaptive-wallet-offers.md`.

## 0. Definition

- **Apple (first class):** the pass is authored as Apple `pass.json`. Every Apple feature PassBook supports stays.
- **Google and Samsung (1.5):** a native projection of the same released template, issued from the same pass record. A 1.5 projection may show less. What it does show is always correct, current within the stated lag, and revoked at the same moment. It never needs separate authoring, a separate pass record or a separate admin journey.
- One pass = one entitlement = one barcode message = one admission rule. Provider copies are instances of it, not new passes.

### What exists today

| Area | State |
| --- | --- |
| Accounts | Per org, per mode, per provider (`wallet_provider_accounts`, `0037`). Encrypted credentials; configure/revoke API; admin UI under org (`src/web/admin/orgs/wallet-accounts*.tsx`). Readiness is `absent/configured/revoked`; `externalApprovalVerified` is hard `false`. |
| Projection | `projection-contract.ts`: Google generic (text, QR, reviewed artwork); Samsung `loyalty/others` (text, QR, artwork, app link). Title + up to 9 fields. Bound into releases (`0038`). |
| Issuance | **Denied for both.** `instance-policy.ts` `walletIssuancePermitted` returns false. The release panel says "Native wallet offers remain unavailable until provider requirements are verified." |
| Offers | `GET /p/{token}/wallet/{provider}`, Samsung click-time offer, offers in portal (`holder-pass-view.tsx`) and pass email. Excluded on transfer-pending, removed, quarantined and stale keyset. |
| Lifecycle | Sync queue, callbacks, tombstones, retirement and generation fences. `onWalletPassUpdated` runs on refresh, reissue, void and unvoid; `onWalletPassRetired` runs before deletion. |
| Admin pass | `wallet-provider-status.tsx` shows each provider's instance lifecycle and desired operation. |
| Device | `src/shared/device.ts` knows `iphone | mac | other` only. No Android or Galaxy class. |
| Not wired | Bundles, broadcasts/messages, scan, status page, audit categories, test inbox. `platform-architecture.md` still lists "Google Wallet" as out of scope. |

"Bake in" means: lift the issuance gate under defined proofs, finish the surfaces in the "Not wired" row, and make every journey below pass its acceptance test.

## 1. Parity table

| Journey | Apple (first class) | Google (1.5) | Samsung (1.5) | Acceptable difference |
| --- | --- | --- | --- | --- |
| Authoring | Full `pass.json` designer: styles, all barcode formats, back fields, images, locations, beacons, NFC flag, upcoming events | No separate editor. The template's Presentations tab shows a Google projection: title field plus up to 9 mapped fields, QR, reviewed logo/hero. Every mapping is chosen from template fields. | Same as Google, as a loyalty card (`others` subtype) with country and app link | Fewer fields and fewer layouts. Mappings are defaults derived from the Apple layout, editable per projection. Raw provider JSON is never accepted. |
| Review and release | Release binds org, mode, revision and hash | The same release also binds the Google projection revision, the adapter revision and each named optional omission | Same | None in the gate. Changing any projection invalidates approval, as an Apple edit does. A required feature the provider cannot show blocks that provider only, never Apple. |
| Issuance (admin, API, connector, bulk) | Builds and signs `.pkpass` | No artifact at issue. The instance is created lazily on first offer click (save JWT / object insert) or eagerly when the org opts in (§6). | Lazy: card data on click / Data Fetch Link | No new API fields or connector config. One `POST /passes` serves all wallets. Bulk counts report per provider. |
| Delivery email | Badge, optional `.pkpass` attachment, open-pass link | Official Google PNG badge linking to a durable PassBook URL that mints the JWT at click time | Official Samsung badge linking to a durable PassBook URL; the click-time offer or Data Fetch Link starts then | No device recommendation in email. Every eligible wallet is listed in fixed order Apple, Google, Samsung. No token that expires in the static mail. |
| Portal and `/p` | Badge, QR on non-iPhone, `In Apple Wallet` from registration | Badge when eligible; recommended on Android | Badge when eligible; recommended on Galaxy | Install state: Apple from registration; Google from save callback; Samsung from its callback. Absent evidence = no claim. "Other wallets" always lists the remaining eligible ones. |
| Add to wallet | Direct `.pkpass` | Google save flow (signed JWT link; Google account required) | Samsung web button or link (eligible Galaxy, market and account) | One extra hop to the provider's own UI is fine. A failed save never shows "Added." |
| Updates after edits and connector syncs | APNs push; device fetches in seconds | Object PATCH queued after commit | Card update queued after commit | Propagation lag up to 15 min (§2). Admin sees desired vs applied revision. The holder never sees a value older than the last applied revision mixed with a newer one. |
| Messages and broadcasts | `changeMessage` lock-screen notification | Message added to object; Google notifies within its own rate limit | Card field update; no notification guarantee | Notification reach differs. The outcome ledger shows per provider: `notified`, `updated only`, `skipped (no instance)`. Content is the same text. |
| Void and remove | Void = update + server deny; remote remove | Object state set inactive/expired; server deny | Card state update; server deny | Server-side denial commits first for all wallets. The provider's own visual state may lag (§2). PassBook never claims a copy was erased from a device. |
| Holder transfer | Old credential retired; new holder re-adds | Old object retired; new object on first add by the new holder | Old card ref retired; new ref | Old copy may remain visible offline. It must fail at the door. |
| Scanning at the door | Barcode (any supported format) → server verify | QR with the same message | QR with the same message | Format may be QR only. The message, server verification and admission state are identical. NFC: none for any wallet in this release. |
| Bundles | `.pkpasses`, `Add all` badge | One save link carrying every eligible object | No multi-add: per-pass list of Samsung badges | Bundle UX may degrade to a list. Each item names its pass. |
| Test mode and sandbox | Test mode signs with the test identity; sandbox org | Test-mode Google account (issuer in demo mode); test inbox shows the Google action | Test-mode Samsung account (card in test status) | Live and Test never share an account, instance or callback. Test data is never projected to a Live account. |
| Provider accounts and readiness | Apple identities page | Org → Wallet accounts: Not set up / Configured / Approved by Google / Revoked / Failing | Same, plus market list | Readiness has more steps because provider approval is external. Admin sees each step and who acts next. |
| Status and health | Signing identity, APNs | Per account: last successful call, queue depth, failed operations (24 h), callback freshness | Same | New rows on `/admin/status`, tenant-scoped on org pages. Health covers the provider API, not device installs. |
| Audit | Pass, identity, release events | Account configure/revoke, readiness change, projection approval, per-pass retire/void fan-out, callback rejections | Same | Same event shape and codes, prefixed `wallet.google.*` / `wallet.samsung.*`. No credentials, tokens or provider object IDs in plain text. |

## 2. What 1.5 may and may not weaken

**May be weaker**

| Aspect | Bound |
| --- | --- |
| Visual fidelity | Title + ≤9 fields, provider layout, QR only, reviewed logo/hero. No back-of-pass, no colour/strip/thumbnail parity, no upcoming events, no locations or beacons. |
| Card types | Google: Generic only. Samsung: `loyalty/others` only. A boarding pass or event ticket projects as a generic/loyalty card. |
| Barcode format | QR only. Allowed only when the barcode message is identical and PassBook's scanner reads QR. A template that marks a non-QR format as required (third-party reader) blocks that provider. |
| NFC, Smart Tap, VAS, rotating barcodes | Not offered. |
| Update lag | Applied within 15 min p95 after commit. A failed operation retries, then shows `Failing` to admin within 1 h. Apple stays seconds. |
| Notifications | Best effort, inside provider rate limits. Apple keeps lock-screen messages. |
| Install evidence | Only what the provider reports. Otherwise "Unknown." |
| Availability | Org needs its own approved provider account. Samsung needs an eligible market and device. |
| Bundles | Samsung: per-pass list. |
| Localisation of badges | Provider-supplied locales only; en-US fallback. |

**Never weaker**

- **Security:** credentials envelope-encrypted, never returned or logged. Save JWTs and Samsung CData minted at click time, single purpose, short-lived. Callbacks verified (Google signature, Samsung certificate) and replay-fenced. Offer URLs are capability URLs with the same rules as `/p`.
- **Tenant and mode isolation:** an account, instance, callback or projection belongs to one org and one mode. A callback for org A can never change org B. Test never reaches Live.
- **Revocation:** void, remove, transfer, keyset rotation, quarantine and deletion deny at the door at the same instant for every wallet. Provider fan-out happens after the denial commits. A stale provider copy never admits.
- **Holder correctness:** every visible field is from an approved release and the pass's current or immediately prior applied revision. There is no field the holder sees on Google that the audience policy hides on Apple. Status (void, expired) is never shown as active once the provider has applied the update.
- **Accessibility:** official badges with `alt` text, 48 px minimum target, keyboard-reachable, plain-text equivalents in email, requirement text outside the badge, WCAG 2.2 AA on every new PassBook surface.
- **Outcome truth:** queued, provider accepted, saved and installed are distinct labels. A click is not a save.
- **Provider branding rules:** official artwork, unmodified, aspect preserved, theme variant per ground.

## 3. Defaults and states

### Wallet offered first

| Device (UA plus client hints) | Recommended | Others listed |
| --- | --- | --- |
| iPhone, iPod | Apple | Google, Samsung if eligible, under "Other wallets" |
| Mac | Apple (badge + QR) | Others |
| Samsung Galaxy (`SM-`, SamsungBrowser) | Samsung if eligible for the pass and market, else Google | Remaining eligible ones, Apple QR |
| Other Android | Google | Samsung if eligible, Apple QR |
| iPad, desktop, unknown | None recommended | All eligible, in fixed order Apple, Google, Samsung, plus QR to open on phone |
| In-app browser | As above, plus `Open in your browser to add.` | |

Detection only reorders. It never hides an eligible wallet. Email has no recommendation.
`device.ts` gains `android` and `galaxy` classes. Existing Apple rules in `ux-principles.md` stay.

### Org without Google or Samsung account

- Holder: that wallet is absent. No greyed badge, no "coming soon." If no wallet is eligible: `No wallet available for this pass.` plus `Show barcode`.
- Admin: Org → Wallet accounts shows `Not set up` with `Set up` (platform admin). Template Presentations shows the projection as `Off: no Google account`. Not a blocker for Apple release.

### Template that cannot be projected

- Release review lists per provider: `Ready`, `Ready with omissions (n)` (each omission named, approval required), or `Blocked: <reason>` (for example `Barcode must be PDF417`).
- A blocked provider is off for that release. Apple publishes. Holders see no badge for that provider.
- Admin pass detail: `Google: not offered (template)`.

### Holder states

| State | Copy |
| --- | --- |
| Offer ready | Badge + one requirement line (`Google account required.`) |
| Preparing (click minted, provider pending) | Provider's own UI. On return without callback: nothing changes |
| Save failed or provider error | `Couldn't add to Google Wallet. Try again or use another wallet.` |
| Account revoked or provider down | Badge hidden. Barcode and other wallets remain |
| Pass void, expired or removed | No badges. Existing state copy |
| Transfer pending | No badges. `This pass is being transferred.` |
| Unsupported device or market | Samsung hidden on non-eligible devices. Others shown |

### Admin states

Per pass, per provider: `Not offered` (reason), `Offered`, `Saved` (callback), `Update queued`, `Applied r12`, `Failing` (code, last try, `Retry`), `Retired`. Per account: `Not set up`, `Configured`, `Approved`, `Failing`, `Revoked`. All with time and actor in audit.

### Copy

- Terse. One sentence for errors: what happened and what to do.
- Provider names in full: `Google Wallet`, `Samsung Wallet`. Never "Wallet" alone near a badge.
- No disclaimers, no "beta", no "limited support", no fidelity apology. Omissions are admin facts, not holder copy.
- Requirement lines only: `Google account required.` / `Galaxy phone and Samsung account required.`

## 4. Out of scope (this release)

| Item | Reason |
| --- | --- |
| Per-wallet free authoring and raw provider JSON | Breaks one-template rule and audience policy. |
| Google classes other than Generic (event ticket, boarding, transit, loyalty) | One adapter first; type mapping per class multiplies review. |
| Samsung types other than loyalty/others | Partner card templates are per type and need separate approval. |
| NFC / Smart Tap / Samsung NFC / VAS | Apple NFC is still off pending approval; Smart Tap needs certified terminals. |
| Rotating barcodes | Needs scanner and credential changes for every wallet. |
| Android SDK / in-app save | PassBook has no Android holder app; the reader app is staff-only. |
| Locations, beacons, upcoming events on Google/Samsung | Not in projection contract; Apple-only behaviours. |
| Provider install state without a callback | Not knowable; never inferred. |
| Remote erase from device | No provider guarantees it. |
| Wallet Orders, Google/Samsung boarding passes | Not in the platform scope. |
| Self-serve provider onboarding by tenant managers | Credentials are platform-admin only until tenant RBAC exists. |

## 5. Acceptance journeys

### Browser e2e (Playwright, provider APIs stubbed at `fetch`)

Fixtures: org `harbor` Live with approved Google and Samsung accounts; org `north` Live with none; template `membership` released with both projections (one approved omission: `secondaryFields.notes` on Samsung).

1. As platform admin open Org `harbor` → Wallet accounts. See Google `Approved`, Samsung `Approved`. Open `north`: both `Not set up`.
2. Open template `membership` → Releases. See Apple `Ready`, Google `Ready`, Samsung `Ready with omissions (1)` naming `notes`. Edit the Samsung mapping; see `Approval no longer matches this revision.` Re-approve; publish.
3. Issue a pass via the admin form to `holder@example.test`. Pass detail shows Apple `Issued`, Google `Not saved`, Samsung `Not saved`.
4. Open the test inbox. The email shows badges for Apple, Google and Samsung in that order, each with one requirement line, with no recommendation. Each link is a PassBook URL; no JWT in the HTML.
5. Open `/p/{token}` with an Android UA. Google badge first, labelled `Recommended`. Samsung under Other wallets. Apple QR present.
6. Same with a Galaxy UA: Samsung first. iPhone UA: Apple first, others under Other wallets. Desktop UA: no recommendation, fixed order.
7. Click Google. The stub receives one object insert scoped to `harbor`'s issuer; the browser is redirected to `pay.google.com/gp/v/save/<jwt>` (asserted, not followed). Pass detail: Google `Offered`, never `Saved`.
8. Post a signed Google save callback. Pass detail: Google `Saved`. Post the same callback again: no change, audit has one event. Post one signed for `north`: `403`, no state change.
9. Edit a field. Pass detail: Google `Update queued` then `Applied r2` after the queue drains; the stub received a PATCH with the new value. Samsung likewise.
10. Void the pass. Scan its barcode on `/scan` (fake scanner): denied at once. Then the stubs receive Google inactive and Samsung state updates. `/p` shows the void state with no badges.
11. Open a `north` pass on `/p` with an Android UA: no Google or Samsung badge, Apple QR and `Show barcode` only.
12. Make the Google stub return 500 for 1 h of fake clock. Pass detail: `Failing` with code and `Retry`. `/admin/status`: Google `Failing` for `harbor`. Holder `/p`: badge still shown for new adds or hidden if the account is `Failing` (per §6 Q6), never a fake success.
13. Revoke Samsung for `harbor`. `/p` and new emails drop the Samsung badge. Audit shows `wallet.samsung.account_revoked` with the actor.
14. Test mode: issue in Test; the stub sees only the Test account's issuer. Switching to Live shows none of those instances.
15. Run axe on `/p`, portal detail, email HTML and Wallet accounts: no violations. Badges have alt text and ≥48 px height.

### Device test (manual, recorded, one run per release candidate)

Devices: iPhone (current iOS), Pixel (current Android, Google account), Galaxy in a Samsung Wallet market (Samsung account), iPad.

1. Issue one pass in Live from `harbor`; send to an inbox opened on each phone.
2. iPhone: open the email, tap Apple badge, add. Pass detail shows `In Apple Wallet`.
3. Pixel: open the email, tap Google badge, save in Google Wallet. Card shows the title and mapped fields; QR scans on `/scan` as admitted. Pass detail shows Google `Saved`.
4. Galaxy: open `/p`; Samsung is recommended. Add to Samsung Wallet. Card shows mapped fields minus the approved omission; QR admits.
5. iPad: `/p` shows no recommendation, QR to open on phone, all three wallets listed.
6. Edit a mapped field in admin. Within 15 min each wallet shows the new value. Record times.
7. Send a broadcast. Record: iPhone notification, Pixel notification or update only, Galaxy update only. Ledger matches.
8. Transfer the pass to a second holder. Old copies on all three phones fail at `/scan`. The new holder adds on Pixel; it admits.
9. Void. All three copies fail at `/scan` immediately. Within 15 min each wallet shows the pass as void or expired.
10. With TalkBack and VoiceOver, reach and activate each badge on `/p`; requirement lines are read.

## 6. Open questions for the owner

1. **Accounts:** keep per-org, per-mode Google issuer and Samsung partner accounts (as built), or one PassBook platform account issuing on behalf of all orgs (one approval, faster onboarding, shared reputation and quota)? Decides onboarding, branding on the card and who signs Google/Samsung terms.
2. **Issuance gate:** `instance-policy.ts` blocks both until "verified publishing/replay guarantee" (Google) and "recipient-market capability" (Samsung). What proof do you accept: Google issuer approved for publishing plus a signed callback round-trip; Samsung partner card status `Active` plus a declared market list?
3. **Release order:** ship Google first and Samsung after its partner approval, or hold both?
4. **Lazy vs eager:** create provider objects only when a holder clicks (default), or at issue for orgs that want provider-side counts?
5. **Update lag:** is 15 min p95 acceptable for Google/Samsung field updates and void visuals (door denial is immediate regardless)?
6. **Failing account:** hide the badge for a `Failing` account, or keep it and let the provider error show?
7. **Samsung for tickets:** accept loyalty/others for event and ticket templates, or block Samsung for those templates until a ticket type is approved?
8. **Galaxy default:** on Galaxy with both eligible, recommend Samsung (proposed) or Google?
9. **Apple badge on Android:** keep Apple as a QR-only "open on iPhone" option on Android pages (proposed), or hide it?
10. **Who configures accounts:** platform admin only (proposed) or tenant org admins once RBAC lands?
11. **Scope doc:** retire "Google Wallet" from the out-of-scope list in `platform-architecture.md`, and add Samsung?
12. **Badges:** Apple's licensed kit still needs your acceptance (`public/apple/README.md`); Google and Samsung assets are ready. Approve shipping them as recorded in `wallet-badges/README.md`?

## Owner direction: typed pass types (2026-11-11)

Project by Apple pass style, not Generic-only. The Generic-only recommendation in google-wallet.md §1 followed the existing projection code, not the product.

| Apple style | Google | Samsung (confirm against samsung-wallet.md) |
| --- | --- | --- |
| `eventTicket` | Event ticket | Event ticket |
| `storeCard` | Loyalty, or Gift card for balance cards | Loyalty or Gift card |
| `coupon` | Offer | Coupon |
| `generic` | Generic | Generic card |
| `boardingPass` | Generic until real carrier or transit data exists (Flight and Transit need it) | Boarding pass only with real data, else Generic |

The projection editor needs a per-style mapping with that type's required fields and validation. A template that lacks a type's required fields falls back to `Ready with omissions` or `Blocked`, never silently to Generic.

## Owner direction: cross-wallet templates (2026-11-11)

The goal is generic cross-wallet templates. A template is created on the fly in the designer, or imported from a `.pkpasstemplate`, and produces the matching pass in Apple, Google and Samsung Wallet. Put another way: a real conversion system that preserves as much functionality as possible on every platform, not a title-plus-nine-fields projection.

This supersedes the "native projection limited to a title plus 9 fields" baseline above where they conflict. The parity rules ("never weaker" list, honest omission labels, a blocked provider never blocks Apple) still hold.
