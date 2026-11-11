## Decision

Keep **Apple full-fidelity primary**, with **real, deliberately narrower Google/Samsung adapters**. Do not make Apple `pass.json` the future authored contract or relabel the Apple preview for other wallets.

Use **one authored model → one domain entitlement → multiple provider outputs and wallet installations**. Choosing another wallet must not replace an existing installation.

## Repository evidence

- **Designer is Apple-native.** The route is `/admin/templates/:id/design` (`src/web/routes/admin/templates/$templateId_.design.tsx:9-11`). `DesignDoc` contains `passJson`, manifest and assets (`designer/model.ts:19-23`); its structure exposes Apple field groups (`designer/outline.tsx:90-127`).
- **Preview targets are Apple-only.** `normalize()` consumes `PassJson` and creates `ios27`/`legacy` layouts (`src/shared/pass-view/normalize.ts:26-47`; `types.ts:3-4`). Designer fixes the target to `ios27`; only semantic/poster layouts receive its visible Approximate badge (`designer/preview.tsx:55-95`). It retains the last successful build while validation fails (`designer/api.ts:37-58`).
- **Create already has a useful wizard:** organization → template → details → holder → review. Its payload omits template-version pinning and provider selection (`src/web/admin/passes/new-pass-page.tsx:51-84,109-119`). Empty required inputs borrow sample values; disclosure is muted appearance, and the “dealt” state remains after the form was valid once (`new-pass-preview.tsx:19-71,92-104`).
- **Edit preserves conflicts, but preview/form versioning differs.** Preview uses the pass’s stored template version (`detail/detail-page.tsx:113-131`), while Fields receives the active template schema (`detail/pass-tabs.tsx:46-52`). Saving uses `If-Match` and preserves edits on conflicts (`detail/fields-tab.tsx:127-174`).
- **Validation is not provider readiness.** Template dry-run uses the platform signer and can report unsigned signing as a warning (`src/worker/modules/templates/build-check.ts:78-114`). Actual issuance resolves tenant/default identities separately (`identities/db-resolver.ts:104-121`). Preserve the existing useful Save version/Activate distinction (`designer/saved-callout.tsx:30-35`).
- **Current labels conflate Wallet with Apple.** Member photos have one “Include photo in Wallet pass” checkbox (`detail/member-photo-card.tsx:79-100`). An Apple registration-derived `inWallet` flag suppresses another Add action (`src/web/portal/my-passes-page.tsx:113-127`).

Designer paths above are under `src/web/admin/templates/`; pass-flow paths are under `src/web/admin/passes/`.

## Recommended merchant interaction

### 1. Content first; wallet presentation second

Use three understandable areas: **Content**, **Wallet previews**, **Review & publish**.

Content should describe business meaning: holder, membership/ticket identifier, balance, validity, links, brand artwork, personal photo, redemption requirements and contextual suggestions. Retain typed values, localization and stable field identities.

Keep provider presentation settings separate. Apple may expose its full styles, semantics and assets; Google/Samsung expose only implemented native profiles. This avoids both duplicated independent designers and lowest-common-denominator authoring.

Distinguish:

- **Required to create:** merchant must supply this value.
- **Required in this wallet:** the adapter must represent the information.
- **Required security behavior:** authentication, credential strength, transfer restrictions or independent revocation cannot disappear.

A required input is not proof that its value will appear in every wallet.

### 2. Nonexclusive wallet selection

Offer a checkbox group, not a provider radio button:

- Apple Wallet — Ready
- Google Wallet — Needs account setup
- Samsung Wallet — Awaiting template approval

Separate **implemented by PassBook**, **ready for this tenant/template/environment**, and **eligible on the customer’s device**. “Not available in PassBook” is different from “Your administrator needs to configure it.”

For shared templates, provide **Preview for organization**. A platform-signer validation result must not imply every tenant can issue.

Unavailable targets must have an explanation and permitted setup action—not an apparently functional Add button. Saving a draft should remain possible without accounts; publishing requires current server-side readiness.

### 3. Accurate preview and comparison

Each preview must derive from that adapter’s **actual proposed native output**, using the same complete revision that issuance will consume: content, overrides, photos, branding, locale, timezone, template version and policy.

Show:

- Provider, native pass type, device/form factor and supported OS variant.
- **Sample values**, **Unsaved changes**, or **Published revision** explicitly.
- **Checking**, **Current**, **Last successful preview—not current**, and **Cannot preview** states.
- Provider-specific fields placed on the face, in details, omitted or transformed.

Never substitute an Apple drawing when another renderer is unavailable. Label native-layout approximation honestly; browser rendering cannot guarantee Wallet-controlled typography, truncation or system behavior.

**Compare wallets** should synchronize revision/sample/locale while preserving each platform’s native hierarchy. Include a readable coverage table; do not require merchants to discover missing information visually. Phone comparison can switch panels rather than shrinking three cards.

### 4. Review what will actually be delivered

Create should add a wallet/readiness review before **Create** or **Create and send**. Pin the reviewed template/content revision; recheck if it changes.

Review should show each destination’s native preview, blocking requirements, optional omissions and recipient-facing delivery.

Public/customer web should recommend the likely appropriate wallet, with other eligible wallets in an accessible secondary accordion. Device detection is a hint—not proof of installation or grounds to hide valid alternatives.

Email preview must show **all eligible provider-specific Add buttons**, using compliant branded assets and precise account/eligibility instructions.

## Capability and security semantics

- **Unsupported required capability:** block that provider’s issuance. Unknown support also blocks. No acknowledgement checkbox may bypass a required security property. Optional presentation omissions require explicit, persisted policy and visible per-provider explanation.
- **NFC:** expose provider-specific tap capabilities, prerequisites and reader compatibility. Apple entitlement, Google Smart Tap configuration and Samsung approval are distinct; a generic NFC switch must not imply interoperability.
- **Barcodes:** disclose actual format, encoding, fallback and credential behavior. Never turn required rotating/authenticated credentials into static codes. Designer specimens must not mint redeemable credentials or expose secrets/add-capability URLs.
- **Relevance:** separate validity from suggestions/reminders. Location/date/beacon configuration must not promise equivalent Lock Screen appearance, notifications or guaranteed timing.
- **Photos:** separate staff-only personal photos from brand artwork and per-provider distribution. Show native crop/placement. Never silently move a prohibited personal photo into another image slot.
- **Multiple devices:** distinguish same-holder installations from transferable credentials. Promise “Revoke this installation” only when independently enforceable; unregistering a device is not necessarily credential revocation.

**Platform-reference boundary:** repository-recorded research documents Google’s personal-image restriction and sharing policies, separate Smart Tap prerequisites, and approval-dependent Samsung NFC (`docs/audits/2026-11-07/reviews/28-wallet-feature-research.md:11-16`; [Google FAQ](https://developers.google.com/wallet/generic/resources/faq), [Smart Tap](https://developers.google.com/wallet/smart-tap/introduction/pass-configuration), [Samsung NFC](https://developer.samsung.com/wallet/addtosamsungwallet/nfccapabilities.html)). These references were not re-fetched here. Product approvals, markets, device/watch eligibility and provider-specific revocation guarantees remain unverified.

## Save, update and accessibility

Keep **draft saved**, **version activated**, **provider published**, **notification queued**, **device fetched**, and **installation observed/unknown** distinct. Current create queues email (`passes/create.ts:179-192`); publication queues push and dispatches asynchronously (`passes/publish.ts:245-270`). Neither means delivery completed.

Show provider/installation-specific revision and failure state; retry one destination without recreating the entitlement. Aggregate status must not turn one Apple registration into “installed everywhere.”

Reuse existing conflict preservation, issue-to-field focus and hidden-face `inert` behavior. Provider checkboxes, preview selectors, comparison and warning explanations must work by keyboard. Announce settled validation summaries politely, provide full-text previews, retain visible focus and reduced motion, and never communicate omissions only through color.

## Observable acceptance matrix

| Scenario | Required result |
|---|---|
| Missing required input | Explicit sample label; creation blocked; no sample mistaken for recipient data. |
| Required NFC/authentication unsupported | Provider blocked before issuance; no weaker fallback. |
| Optional personal photo | Staff copy retained; provider omission/policy visible; prohibited upload never occurs. |
| Preview request fails | Last successful revision clearly stale; sending cannot use it as current approval. |
| Template activates during review | Revision mismatch detected; review refreshed before creation. |
| Apple succeeds, another provider fails | Separate statuses/retry; no “all wallets updated” claim. |
| Same entitlement on several phones/wallets | Existing installs retained; shared redemption state; truthful per-instance observations. |
| Public recommendation/email | Alternatives remain keyboard-discoverable; email includes every eligible branded action. |
| Keyboard/screen reader comparison | Every control operable; provider differences readable without inspecting pictures. |

**Migration:** introduce the neutral authored schema; import existing content while preserving Apple-specific configuration; retain the Apple renderer behind its adapter; add declared native subset profiles and diagnostics; cut designer/create/edit/delivery over to revision-bound adapter outputs. Preserve existing issued Apple identifiers and lifecycle continuity.

Source-only audit: no edits, builds, checks, network, account, device or assistive-technology sessions.
