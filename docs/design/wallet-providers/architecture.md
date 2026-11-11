# Cross-wallet templates and conversion

Status: proposed, 2026-11-11. Separate track: branch off `main` after the release that ships Google and Samsung dark behind one policy gate. Reads with `product.md` (its two owner-direction sections win over its earlier text), `current-state.md`, `google-wallet.md`, `samsung-wallet.md`. Authority: `docs/design/authority-epochs.md` (not in the tree on 2026-11-11; this design consumes its revision epochs and per-batch grant rows and re-designs nothing there).

**Recommendation.** The Apple `.pkpasstemplate` plus `wallet.template.json` stays the only source of truth. Google and Samsung passes are compiled from the *materialized Apple pass* (the output of `planPass`, `src/passkit/build.ts:217`) plus one optional manifest extension, `wallets`, for the few things Apple's model cannot say. No parallel model is stored. Compilers are pure, versioned and shared by worker, designer and tests. Each compiler declares its capabilities; a generated matrix and a deterministic per-template fidelity report come from those declarations. Apple output stays byte-stable because the Apple build key ignores the extension.

## 1. Source of truth

| | (a) Apple package + manifest, converters out | (b) Neutral model, compiled to all three |
| --- | --- | --- |
| Apple fidelity | Exact by construction; every PassKit key in `src/passkit/schema/` keeps working | Only what the model covers; every new iOS key needs model work first |
| Existing packages, baked templates, releases, live passes | Unchanged | Every version re-expressed; Apple output must be proven identical per template |
| Import/export | `.pkpasstemplate` is the storage format; nothing to round-trip | Lossless import/export is a second compiler pair to keep in sync |
| Google/Samsung gaps | Need a small extension for non-Apple facts | Native |
| Designer | Already edits `{passJson, manifest, assets}` (`src/web/admin/templates/designer/model.ts:19`) | Rewrite |

**Decision: (a).** In practice (b) is (a) with an extra stored layer: a pkpasstemplate is already a semantic document (styles, field groups, `semantics` tags, barcodes, relevance, expiry), and the converters in (b) would read the same keys. Apple's model cannot express a handful of facts a cross-wallet template needs; those go into `wallet.template.json` under `wallets` (section 2.3). That is the only addition.

**In-memory IR, not a stored model.** Compilers share one intermediate view, `WalletPassView` (section 2.1), built per compile from the materialized pass. It is never persisted, hashed into a template version, or edited. If it disappeared, nothing stored would change.

### Migration (nothing issued breaks)

| Item | What happens | Proof |
| --- | --- | --- |
| Template packages (uploaded) | Unchanged. No `wallets` block means compile with inferred roles (section 2.2). Authors add the block only to override. | Version hash unchanged until the author edits |
| Apple build key | `buildKey` (`src/worker/modules/templates/package/hash.ts:63`) drops `manifest.wallets` and every `wallets/**` asset, as it already drops `description`, `previewOnlyAssets` and `scan.display`. `classifyAsset` (`src/passkit/template/package.ts:47`) returns `null` for `wallets/**`, so those files never enter a `.pkpass`. | Golden: for every baked template and starter, `contentHash` from `buildPass` is equal with and without a `wallets` block and `wallets/` art |
| Baked templates | `templates/*/wallet.template.json` gain a `wallets` block and `wallets/` art (a2). New template version; stale-reissue runs, finds `previousHash === contentHash` (`build.ts:300`), signs nothing and pushes nothing. | Same golden; plus a test that BulkReissue over a baked version change reports 0 rebuilt |
| Apple releases | Untouched. The Apple candidate digest is computed over the Apple build key (`release-content.ts` gains `appleCandidateContent` excluding `wallets`). A version that differs only in `wallets` is an Apple no-op: the active Apple release re-points with `source: 'system'` (already in `TemplateReleaseSchema`), no new approval. | Release test: wallets-only edit leaves Apple approval valid, invalidates Google/Samsung approvals |
| Google/Samsung projection candidates and releases (schema 1, `projection-contract.ts`) | No instance was ever issued (issuance denied: `instance-policy.ts:5`). Schema 1 rows stay readable history; publish of schema 1 is refused. New candidates use schema 2 (section 4.3). | Migration test: schema 1 rows list as `Superseded`, no instance references them |
| Live passes | Apple: no change (above). Google/Samsung: none exist. | `SELECT count(*) FROM wallet_provider_instances` is 0 in Live before the first schema 2 release; the enablement runbook checks it |

## 2. The model

### 2.1 `WalletPassView` (in-memory)

Built by `resolveWalletView(plan, manifest, ctx)` from `PlannedPass.passJson` (bindings, behaviours, local-time and normalization already applied), the shipped asset list, `.lproj` strings and the `wallets` block evaluated in the same expression scope (`input`, `lookups`, `pass`). Pure; `ctx` carries `now`, locale list and an asset URL resolver.

| Part | Source in the Apple pass |
| --- | --- |
| `style` | The style key (`generic`, `posterGeneric`, `storeCard`, `coupon`, `eventTicket`, `boardingPass`) plus `preferredStyleSchemes` (PET, SBP) |
| `org`, `description` | `organizationName`, `description` |
| `fields[]` | Every field: `group` (header, primary, secondary, auxiliary, additionalInfo, footer, back), `key`, `label`, `value`, `attributedValue` links, `dateStyle`/`timeStyle`/`numberStyle`/`currencyCode`, `changeMessage`, field `semantics`, front order |
| `roles` | Section 2.2 |
| `barcodes[]` | `barcodes` in Apple's fallback order; message, format, encoding, `altText` |
| `colors` | `backgroundColor`, `foregroundColor`, `labelColor`, `footerBackgroundColor` |
| `images` | Slot -> files per scale and locale, with pixel size; `wallets/**` overrides |
| `relevance` | `relevantDates[]`, `locations[]` (with `relevantText`), `beacons[]`, `maxDistance` |
| `validity` | `expirationDate`, `voided` |
| `links` | `featuredActions`, `attributedValue` links on back fields, event-guide URLs, `appLaunchURL` |
| `events` | `upcomingPassInformation` (from the `upcoming-events` behaviour) |
| `localization` | `pass.strings` per locale; localized images |
| `sharing`, `nfc`, `personalization` | `sharingProhibited`, `nfc`, `personalization.json` |
| `messaging` | `manifest.messaging.input` and every field with `changeMessage` |

### 2.2 Semantic roles

A role names a fact a target has a native slot for. Resolution order, first hit wins, fully deterministic:

1. `wallets.roles.<role>` in the manifest: a field key (`{ "field": "points" }`), an expression (`{ "value": "{{input.tier}}" }`), or `false` (role deliberately absent).
2. Apple `semantics`, root or field level (catalog section 11). A field carrying the tag supplies the label too.
3. Style rules (table below, column "Style default").
4. None. Never a guess from field keys or labels. The designer may *propose* a role from key names, but a proposal becomes real only when saved into `wallets.roles`.

| Role | Apple semantics | Style default | Type |
| --- | --- | --- | --- |
| `title` | none | `primaryFields[0]` | text |
| `subtitle` | none | `secondaryFields[0]` | text |
| `eventName` | `eventName` | eventTicket: `primaryFields[0]` | text |
| `eventStart`, `eventEnd`, `doorsOpen` | `eventStartDate`/`eventStartDateInfo`, `eventEndDate`, `venueDoorsOpenDate` | first `relevantDates[]` entry | date |
| `venueName`, `venueAddress`, `venueLocation` | `venueName`, `venueRoom`/`venueRegionName`, `venueLocation` | `locations[0]` for `venueLocation` | text, text, lat/long |
| `seat`, `row`, `section`, `gate` | `seats[0].seatNumber/seatRow/seatSection`, `venueEntranceGate` | none | text |
| `ticketHolder`, `ticketNumber`, `confirmationCode` | `attendeeName`, none, `confirmationNumber` | none | text |
| `eventId` | none | none (needed for Samsung event-wide cancel) | text |
| `memberId` | `membershipProgramNumber` | storeCard: barcode `altText` | text |
| `memberName` | `passengerName`/`attendeeName` | none | text |
| `tier` | `membershipProgramStatus` | none | text |
| `points`, `pointsLabel` | none | none | number or text |
| `balance` | `balance` (CurrencyAmount, storeCard) | none | money |
| `giftCardNumber`, `giftCardPin` | none | none | text |
| `offerTitle`, `offerDetails`, `finePrint` | none | coupon: `primaryFields[0]`, back fields, none | text |
| `redemptionChannel` | none | coupon: `both` | enum online/instore/both |
| `validFrom`, `validUntil` | none | `relevantDates[0].startDate`, `expirationDate` | date |
| `appLink` (Samsung `appLinkLogo/Name/Data`) | none | org logo, org name, org website setting; never a `/p` capability URL | url |
| `support` (phone, email, web) | none | back-field `tel:`/`mailto:`/`https:` links | links |

`title` always exists (falls back to `organizationName`). Identity roles (`memberId`, `giftCardNumber`, barcode message) are never truncated (section 3.3).

### 2.3 `wallets` manifest extension

Optional block in `wallet.template.json`. Validated by `walletsManifestIssues` from `validateManifest` (`src/passkit/template/manifest.ts:95`). Expressions use the existing language (`expr.ts`): no new evaluator.

```json
"wallets": {
  "schema": 1,
  "roles": { "points": { "field": "points" }, "tier": { "value": "{{input.level}}" }, "eventId": { "value": "{{input.event_code}}" } },
  "required": ["barcode.format", "type"],
  "google":  { "type": "loyalty", "classKey": "{{input.event_code}}", "omit": ["backFields.terms"], "images": { "logo": "wallets/google/logo.png", "hero": "wallets/google/hero.png" } },
  "samsung": { "type": "loyalty", "subType": "others", "omit": [], "images": { "main": "wallets/samsung/main.png" } }
}
```

| Key | Meaning |
| --- | --- |
| `roles` | Section 2.2, step 1 |
| `required` | Capability ids (section 4.1) that must be `native` on a target or that target is `Blocked`. Product rule: a required non-QR barcode blocks a QR-only target. |
| `<target>.type` | Override the style default type (section 3.1). Absent = default. `off` disables the target for this template. |
| `<target>.omit` | Author-chosen omissions by field key or capability id; shown in the report as chosen, still approved at release |
| `<target>.images` | Per-wallet art in `wallets/<target>/` (PNG, checked at upload for the target's size rules) |
| `google.classKey` | Expression that partitions Google classes (event tickets: one class per event). Default `"default"` |

Provider JSON is never accepted (product rule, kept). Unknown keys are errors.

### 2.4 Styling, images, barcode, localization, bindings, behaviours

- **Colours:** `backgroundColor` -> Google `hexBackgroundColor`, Samsung `bgColor`; `foregroundColor` -> Samsung `fontColor`; Google picks text colour (difference, not omission).
- **Images:** override in `wallets/<target>/` wins; else derive from Apple art by crop or downscale only, never upscale (Cloudflare Images `transform`, cached by source SHA-256 + recipe). Below the target minimum: logo falls back to Google's initial letter, other slots are omitted. Personal images (`member_photos`, per-pass `assetOverrides`) are never sent to a provider (Google: personal images unsupported; Samsung: no stated rule; PassBook rule: no PII to providers). Served from immutable public URLs `/w/i/<sha256>.png` holding template art only.
- **Barcode:** first Apple barcode whose format the target supports, in Apple's order. Message and encoding are copied byte for byte (scanner parity). `altText` -> Google `alternateText`, Samsung `*SERIAL` `ptFormat`.
- **Localization:** labels and values via `pass.strings` -> Google `LocalizedString.translatedValues`, Samsung `localization[]`. Localized images: default image only (difference).
- **Bindings and behaviours:** run once, on the Apple side, by `planPass`. Compilers read their output (`locations` from `venue-locations`, `relevantDates` from `relevance-window`, `expirationDate` from `expiry-from-input`, `upcomingPassInformation` from `upcoming-events`, `beacons` from `beacons`). No behaviour knows about providers.

## 3. Compilers

`src/passkit/wallets/<target>/<type>.ts`, one per (target, type). Signature: `compile(view: WalletPassView, opts): CompileResult`, where `CompileResult = { classBody, objectBody | cardData, items: FidelityItem[] }`. Pure, no I/O, no clock beyond `opts.now`, safe in the browser. `COMPILER_REVISION` per target joins the release candidate digest.

### 3.1 Type selection

| Apple style | Google | Samsung | Rule when the type cannot be satisfied |
| --- | --- | --- | --- |
| `eventTicket`, PET | Event ticket | `ticket/others` (subtype from `eventType`: performances, sports, movies, entrances) | Needs `eventName` and `eventStart`. Missing: type falls back to Generic / `loyalty/others` as an omission (`type`), or `Blocked` if `type` is in `required` |
| `storeCard` | Loyalty; Gift card when `balance` or `giftCardNumber` resolves and `memberId`/`points` do not | Loyalty `loyalty/others`; gift card see note | Google Loyalty needs `programName` (= `organizationName`) and a program logo (derived from `icon`/`logo` or override); Gift card needs `giftCardNumber` |
| `coupon` | Offer | `coupon/others` | Offer needs `offerTitle`, `redemptionChannel`; Samsung coupon needs `mainImg` and `validUntil` |
| `generic`, `posterGeneric` | Generic | Generic, see note | none |
| `boardingPass` | Generic (Flight/Transit later, needs carrier data and Google class review) | Generic, see note | Owner direction table; typed later behind a question |

Note: Samsung documents no Update Notification for `generic` and `giftcard` (`samsung-wallet.md` section 2, marked unconfirmed). PassBook passes always need updates (void, expiry, connection syncs). Until Samsung confirms, both compile to `loyalty/others` with omission `type`. Each Samsung type needs its own approved card id per account (section 6.4).

### 3.2 Role mapping

Cells: native target slot; `text` = labelled Google `textModulesData` / Samsung `text{n}` (generic) or `noticeDesc` line (others); `-` = omitted.

| Role / feature | Google Generic | Google Event | Google Loyalty | Google Gift | Google Offer | Samsung loyalty | Samsung ticket | Samsung coupon |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `org` | `cardTitle` | class `issuerName` | class `issuerName`, `programName` | class `issuerName`, `merchantName` | class `issuerName`, `provider` | `providerName` | `providerName` | `providerName`? (unconfirmed) |
| `title` | `header` | class `eventName` | `accountName` or text | text | class `title` | `title` | `title` | `title` |
| `subtitle` | `subheader` | text | text | text | `details` | `subtitle1`? (verify) | text | text |
| `eventStart/End`, `doorsOpen` | `validTimeInterval` + text | class `dateTime.start/end/doorsOpen` | text | text | text | `startDate`/`endDate` | `startDate`/`endDate` | `issueDate` |
| `venue*` | text | class `venue.name/address` | text | text | text | text | text (location attrs, verify) | text |
| `seat/row/section/gate` | text | `seatInfo.*` | text | text | text | text | seat attributes (verify list) | - |
| `ticketHolder`, `ticketNumber`, `confirmationCode` | text | `ticketHolderName`, `ticketNumber`, `reservationInfo.confirmationCode` | text | text | text | text | `reservationNumber` | text |
| `memberId`, `memberName` | text | text | `accountId`, `accountName` | text | text | text | text | text |
| `tier` | text | text | class `rewardsTier` | text | text | text | text | text |
| `points` | text | text | `loyaltyPoints.balance` + label | text | text | `amount`/`balance` (text) | text | text |
| `balance` | text | text | `secondaryLoyaltyPoints` (money) | `balance` (Money) | text | `balance` | text | text |
| `giftCardNumber`, `giftCardPin` | text | text | text | `cardNumber`, `pin` | text | text | text | `barcode.pin`? |
| `offerTitle`, `finePrint` | text | text | text | text | `title`, `finePrint` | text | text | `title`, `noticeDesc` |
| Other front fields | `textModulesData` (row order) | same | same | same | same | `noticeDesc` | `noticeDesc` | `noticeDesc` |
| Back fields | `textModulesData`, then `linksModuleData` for links | same | same | same | same | `noticeDesc` (5000), `csInfo` for tel/mail/web | same | same |
| Barcode | `barcode` (formats: QR, PDF417, Aztec, Code 128; others verify) | same | same | same | same | `barcode.*` (all Apple formats) | same | same |
| `validUntil` / `expirationDate` | `validTimeInterval.end` | same | same | same | same | `endDate` | `endDate` | `expiry` |
| `voided` | `state: INACTIVE` + barcode removed (6.2) | same | same | same | same | state `CANCELED` via Update Notification | same | same |
| `locations` (<= 10) | `merchantLocations` | same | same | same | same | `locations` | `locations` | - |
| `relevantDates` | `notifications.upcomingNotification` | same + `dateTime` | - | - | `validTimeInterval.start` | `startDate` | `startDate` | - |
| `beacons`, `maxDistance` | - | - | - | - | - | - | - | - |
| Upcoming events (multi-event) | next event in `validTimeInterval` + text list | next event in class `dateTime`; rest as text | - | - | - | next event | next event | - |
| `featuredActions`, event-guide URLs | `linksModuleData` | same | same | same | same | `appLinkData` (first), rest `noticeDesc` | same | same |
| `changeMessage` / `messaging` | `addMessage` (6.3) | same | same | same | same | `noticeDesc` update | same | same |
| Colours | `hexBackgroundColor` | same | same | same | same | `bgColor`, `fontColor` | same | same |
| Logo / icon | `logo` (>= 660 sq) | class `logo` | class `programLogo` | class `programLogo` | class `titleImage` | `logoImage` (+dark/light) | `logoImage` | - |
| Strip / artwork / background | `heroImage` | class `heroImage` | `heroImage` | `heroImage` | `heroImage` | `bgImage` | `mainImg` | `mainImg` |
| Thumbnail | `imageModulesData` (template art only) | same | same | same | same | - | - | - |
| `sharingProhibited` | class `multipleDevicesAndHoldersAllowedStatus` (one user; enum verify) | same | same | same | same | - | `privacyModeYn`? (verify) | - |
| NFC, personalization | - | - | - | - | - | - | - | - |
| `appLink` | - | - | - | - | - | `appLinkLogo/Name/Data` (required) | same | same |

Every "verify" cell is pinned by a recorded-fixture contract test (section 7) before the compiler ships; until then the cell compiles to `text`.

### 3.3 Fallback rules (in order)

1. **Native** slot exists: use it.
2. **Text:** the target has a labelled free-text slot with room: emit `label: value` there, in Apple front-to-back order (header, primary, secondary, auxiliary, additionalInfo, footer, back). Google: at most 10 object modules (class modules reserved for template-constant text). Samsung `noticeDesc` up to the byte limit.
3. **Omit** and record a `FidelityItem` with the capability id and the field key.
4. **Type fallback** when the selected type's required roles are missing (3.1).
5. **Length:** display text over a target limit is cut at a grapheme boundary with `…` and reported once per field at template level (via schema `maxLength`; unbounded input = "may be shortened"). Identity values (barcode message, `memberId`, `giftCardNumber`, `ticketNumber`) are never cut: a pass whose identity value does not fit is `Not offered (value too long)` for that target only.
6. **Required:** anything in `wallets.required` that ends at step 3, 4 or 5 makes the target `Blocked`. Apple is never blocked by a provider (product rule).

No markup, control characters or HTML pass through (the `plain` check in `render-projection.ts:30` moves into the shared text sanitizer).

## 4. Fidelity

### 4.1 Capability matrix

Each compiler exports `CAPABILITIES: Record<CapabilityId, Support>` where `Support = 'native' | 'text' | 'difference' | 'omitted' | 'unsupported'`. Capability ids are stable strings: `field.header`, `field.back`, `role.points`, `barcode.format.pdf417`, `relevance.beacons`, `image.strip`, `messaging.notify`, `updates.push`, `void.visual`, `upcoming.multi`, `nfc`, `type`, and so on.

- `npm run gen` writes `src/generated/wallet-capabilities.ts` and `docs/design/wallet-providers/capabilities.md` (feature x target x type). CI fails if either drifts.
- The table is the contract: a compiler test asserts that compiling the starter fixtures produces exactly the declared support level per capability (no undeclared loss).

### 4.2 Per-template report

`fidelityReport(version, target, compilerRevision) -> { status, type, items[] }`:

- Input: the template version, its `sample` (plus every `x-examples` value when present), the `wallets` block. Compile with `now` fixed to the version's creation time. Deterministic: same input, same report, canonical order (capability id, then field key).
- `items[]`: `{ capability, path, support, severity: 'difference' | 'omission' | 'blocked', chosen: boolean, message }`.
- Status: `Ready` (no omissions), `Ready with omissions (n)` (each named, approval required), `Blocked: <reason>`. Differences (Google picks text colour, localized images use default) are listed, not approved.
- Shown at three places from one function: designer Wallets tab (live), import report, release review.
- Runtime per pass: the same compiler runs at sync; a pass-level failure (identity value too long, required role empty for this input) sets the instance to `blocked` with the code, shown as `Not offered (<reason>)` on pass detail. It never falls back silently.

### 4.3 Release binding (schema 2 projection)

A Google or Samsung candidate stores `projection = { schema: 2, target, type, compilerRevision, wallets: <hash of manifest.wallets>, report: <hash>, approvedOmissions: [capability+path] }`, bound to the Apple source release as today (`sourceReleaseId/generation/hash`, `projection-source.ts`) and to account id and revision. Two-person approval stays. Any change to the Apple source, the `wallets` block, the compiler revision, the account, or the report re-opens review for that target only.

Compiler upgrades: CI snapshot tests make every fidelity change visible in the PR. On deploy, an active release whose report changes gets `Review needed`: if the change only removes omissions it carries forward (`source: 'system'`); if it adds one, new offers for that target pause until re-approval, while state changes (void, expiry, removal, barcode) keep flowing to existing instances.

## 5. Authoring

- **Designer (on the fly):** saves the same `{passJson, manifest, assets}` version it saves today (`designer/save-flow.ts`). New Wallets tab: target on/off, type, role table (resolved source per role: manifest / semantics / style default / none, with key-name proposals the author can accept), per-target images, `required`, `omit`, and the live report.
- **Import:** `.pkpasstemplate` with or without `wallet.template.json` (generated when absent, as today) goes through `TemplateImport`; `wallets/**` is allowed by `names.ts` and checked for PNG and per-target size. The upload report adds the per-target fidelity report. Export (`GET /templates/{id}/package`, `routes-more.ts`) includes `wallets/**` and the block.
- **Previews:** the designer runs the real compilers in the browser and renders the compiled JSON with `src/web/wallet-previews/{google,samsung}/` (approximate, labelled "Preview", per product copy rules). Apple keeps `PassCard`. One preview switcher: Apple, Google, Samsung (the mockup frame in `other-surfaces.html`, "Wallet preview · Provider"). A gated target shows its report and no card.
- Matches the mockups: one pass definition, separate wallet projections, provider readiness per release (`admin-interfaces.html` "Provider readiness").

## 6. Lifecycle parity

Reuses instances, desired-state operations, dirty triggers, sync drain, callbacks and tombstones (`current-state.md` section 1). Changes: the operation body comes from the compiler at claim time; instances pin the pass epoch, account epoch and release generation from `authority-epochs.md` instead of the column-equality fences (`current-state.md` section 5). Fence replacement belongs to that track; packages CW9-CW11 consume it.

### 6.1 Propagation

| Event | Apple | Google | Samsung |
| --- | --- | --- | --- |
| Field edit, connection sync, reissue | APNs push | `upsert`: PATCH object (and class when class content changed) with full arrays | `upsert`: Update Notification `UPDATED`; Samsung pulls Get Card Data |
| Message / broadcast | `changeMessage` | `addMessage` `TEXT_AND_NOTIFY`, oldest dropped past 10 | `noticeDesc` updated; ledger `updated only` |
| Expiry | `expirationDate` | `validTimeInterval.end`; Google moves it to Expired | `endDate`/`expiry`; `EXPIRED` state at the date |
| Void | `voided` + server deny | deny first, then PUT object `state: INACTIVE`, barcode removed, message `This pass is no longer valid.` | deny first, then state `CANCELED` |
| Unvoid | `voided: false` | PUT `ACTIVE` with barcode | `ACTIVE` |
| Admin remove / delete | remote remove | as void (Google cannot delete) | `DELETED` |
| Transfer | new credential generation | new object id (generation is in the id, `google-ids.ts`); old one as void | old ref `DELETED` + tombstone; new ref for the new holder |
| Keyset rotation, quarantine | deny | as void | as void |
| Upcoming events roll over | Wallet handles | scheduled recompile at each event boundary (`lifecycle-instance-schedule.ts`) | same |

Denial at the door always commits before provider fan-out (product rule). Bundles: Google one save JWT with every eligible object; Samsung a list.

### 6.2 Google blockers (`google-wallet.md` section 10)

- **G1 token caching:** per-isolate cache keyed by account id + credential revision; reuse until 80 % of `expires_in`; drop on 401 and on revision change. Never persisted, never logged.
- **G2/G4 artwork and expiry:** come from the compilers (3.2): `hexBackgroundColor`, `heroImage`, `wideLogo`, `subheader`, `validTimeInterval`, `merchantLocations`. G16: images are PassBook-hosted, checked at upload, so `logoUrl` free input goes away.
- **G5 revocation leaves the barcode:** revoke is PUT (full compiled object, no `barcode`, `state: INACTIVE`, one message), then GET to confirm. This also gives Google retirement its replay boundary: a replayed save JWT can only add an inactive, barcode-less object, so retirement settles once the GET confirms (removes `sync-operation-retirement.ts:44`).
- Also: callback root-key cache until earliest `keyExpiration`, refetch on verify failure (G8); tolerate unknown envelope keys (G10); separate callback rate limit (G12); 10 s timeouts and `Retry-After` (G13, `current-state` item 20); PATCH after first success (G14); first tap builds the object synchronously within the timeout, else an error page, never a 404 (`current-state` item 5); idempotent redelivery returns 200 (item 11).

### 6.3 Messages

`addMessage` per changed `changeMessage` field and per broadcast, message id = operation id (idempotent). Notification rate per object is Google's (unconfirmed); the outcome ledger records `notified` only when `TEXT_AND_NOTIFY` was accepted, else `updated only`.

### 6.4 Samsung blockers (`samsung-wallet.md` section 10)

- **B1 refs never promoted:** first Get Card Data reads with `requirePromoted = false` inside `samsungInitialWindowSql`; the verified Send Card State `ADDED` promotes atomically (`UPDATE ... SET promoted_at = ? WHERE promoted_at IS NULL AND <epoch fence>`) and stores its `cc2` as the ref's market. `cc2` from `ADDED` is the market evidence the issuance gate asked for.
- **R1 inbound path:** accept a signed `API.path` equal to the full pathname or to the `/cards/{cardId}/{refId}` suffix; method, card id and ref id must still match.
- **R2 token age:** 300 s window (plus 5 s skew), replay keys kept for the window. Confirm with Samsung; the constant lives in one place.
- **R4 Send Card State events ignored:** parse `event`. `ADDED`: promote, instance `saved`, persist `cc2`. `DELETED`: record holder removal (instance stays; no claim of erasure). `UPDATED`, `PROVISIONED`: record. Each is an idempotent receipt keyed by token hash + `x-request-id`.
- Also: R5 return 200 for authenticated unknown refs; R7 timeouts; R10 replace `extendedFields` with documented attributes (`noticeDesc`, `text{n}`) and set `updatedAt` to the pass revision time; `UPDATED` purpose for upserts (`current-state` item 4); mode-aware template probe (item 9); evidence out of queue predicates (item 8); `MIGRATED` added to the state union (N1).
- **Card ids per type:** a Samsung account holds one approved `cardId` per type (`loyalty`, `ticket`, `coupon`, later `generic`, `giftcard`); a template whose type has no active card id is `Blocked: Samsung <type> card not approved`.

### 6.5 Common

`uncertain` gets a reconciler: after the lease, GET the provider state (Google object; Samsung has no read, so re-send the idempotent state set) and settle (`current-state` item 6). `ctx.ids`/`ctx.clock` everywhere (items 18-19). Logged, classified catches (item 12).

## 7. Testing

| Suite | What | Where |
| --- | --- | --- |
| Apple stability golden | Every baked template and starter: `contentHash` equal with and without `wallets`; BulkReissue over a wallets-only version rebuilds 0 | `src/passkit/wallets/apple-stability.test.ts` |
| Package round trip | `.pkpasstemplate` (+ manifest, + `wallets/`) -> import -> stored version -> export -> import: same `contentVersion`, same build key, canonical `pass.json` equal, asset bytes equal. Zip bytes are not compared | `src/worker/modules/templates/package/round-trip.test.ts` |
| Compiler snapshots | Each (target, type) over starter fixtures + edge fixtures (long values, missing roles, all barcode formats, 10+ fields, localized strings, upcoming events): compiled JSON snapshot | `src/passkit/wallets/<target>/*.test.ts` |
| Capability truth | Compiling fixtures yields exactly the declared support per capability; generated matrix has no drift | `src/passkit/wallets/capabilities.test.ts` |
| Fidelity report | Fixed report per fixture; order, status and hash stable; `required` blocks; wallets-only change re-opens only provider approval | `src/passkit/wallets/fidelity.test.ts`, `releases.test.ts` |
| Scan parity | Barcode message from every compiler equals the Apple message for every fixture | `src/passkit/wallets/barcode.test.ts` |
| Provider contract | Recorded request/response fixtures (Google REST per type, OAuth, callback envelope; Samsung token, Get Card Data, Send Card State per event, Update Notification). Requests are compared field by field; fixtures recorded in demo/testing mode by the owner and scrubbed | `test/fixtures/wallets/{google,samsung}/`, worker tests (fetch stubbed per `test/setup/block-network.ts`) |
| Lifecycle | Each row of 6.1 against stubs: deny before fan-out, body content, idempotent replay | `src/worker/modules/wallet-providers/*.test.ts` |
| Browser e2e | Designer: create a storeCard template, set roles, see Google Loyalty and Samsung previews and reports; import a `.pkpasstemplate`; release with one approved omission; issue; `/p` badges; edit -> stubs get PATCH/UPDATED; void -> scan denied, then INACTIVE/CANCELED. Extends `product.md` section 5 journeys | `e2e/2x-wallets-*.spec.ts` |

## 8. Work packages

Each is one branch, one PR, `npm run check` green. Shared-file touches are named; tell the integration agent.

| # | Package | Owns | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| CW1 | `wallets` manifest block | `src/passkit/template/wallets/**`; one-line `wallets?` in `src/passkit/types.ts` (a1, shared); `package/names.ts`, `package/hash.ts` `buildKey`, `src/passkit/template/package.ts` `classifyAsset`; `release-content.ts` Apple candidate content | release merged | Schema + validation codes; `wallets/**` never ships; Apple stability golden green; wallets-only version keeps Apple approval |
| CW2 | View, roles, compiler and fidelity core | `src/passkit/wallets/{view,roles,text,fidelity,types}.ts` | CW1 | `resolveWalletView` over all starters; role resolution table tested row by row; report engine with fixed ordering and hash |
| CW3 | Google compilers | `src/passkit/wallets/google/**` | CW2 | Generic, Event, Loyalty, Gift, Offer; snapshots; capability truth; contract fixtures for typed bodies |
| CW4 | Samsung compilers | `src/passkit/wallets/samsung/**` | CW2 | loyalty, ticket, coupon (generic, giftcard behind Q14); snapshots; byte limits; no `extendedFields` |
| CW5 | Matrix generation | `tools/gen-wallet-capabilities.ts`, `src/generated/wallet-capabilities.ts`, `docs/design/wallet-providers/capabilities.md`, `src/shared/contracts/wallet-fidelity.ts` | CW3, CW4 | `npm run gen` deterministic; drift fails CI |
| CW6 | Provider image hosting | `src/worker/modules/wallet-providers/assets*.ts`, route `/w/i/:sha256` | CW1 | Immutable public PNGs of template art only; derive by crop/downscale; 404 for personal images; cache headers |
| CW7 | Release integration (schema 2) | `wallet-providers/projection-*.ts`, `repo-projection*.ts`, `src/shared/contracts/wallet-providers.ts`, `migrations/00NN_wallet_projection_v2.sql` if needed | CW2, CW5 (contract) | Candidate pins compiler revision, wallets hash, report hash, approved omissions; schema 1 refused for publish; Google publish path open (removes `current-state` items 2 and 10) |
| CW8 | Designer Wallets tab, previews, release UI | `src/web/admin/templates/designer/wallets/**`, `src/web/wallet-previews/**`, `src/web/admin/templates/releases/provider-*` | CW3, CW4, CW7 | Live report as roles change; previews from the real compilers; release shows Ready / omissions / Blocked per target; axe clean |
| CW9a | Google blockers, compiler-independent | `google-{oauth,rest,callback-*,errors}.ts`, `routes-google-callbacks.ts` | release merged | G1, G8, G10, G12, G13, G14, idempotent redelivery; contract fixtures |
| CW9b | Google typed runtime | `runtime-google.ts`, `sync-operation-google.ts`, `google-ids.ts` (class key), `offers*.ts` Google path | CW3, CW7, CW9a, epochs | Per-type class/object upsert from compiler output; PUT revoke + GET confirm; retirement settles; first tap never 404 |
| CW10a | Samsung blockers, compiler-independent | `samsung-token*.ts`, `callbacks-samsung.ts`, `callbacks-ref.ts`, `repo-callbacks*.ts`, `routes-callbacks.ts`, `samsung.ts` | release merged | B1 promotion on `ADDED`, R1, R2, R4 events, R5, R7, `UPDATED` purpose, `MIGRATED` |
| CW10b | Samsung typed runtime | `runtime-samsung.ts`, `sync-operation-samsung.ts`, `samsung-template.ts`, account card ids per type (`samsung-credentials.ts`, migration) | CW4, CW7, CW10a, epochs | Per-type Get Card Data from compiler; mode-aware probe; evidence outside queue predicates |
| CW11 | Lifecycle parity | `lifecycle*.ts`, `sync*.ts`, `instance*.ts`, `repo-instance*.ts`; hooks in `modules/broadcasts/**` (n7, shared) and `modules/passes/remove*.ts` (n1, shared) | CW9b, CW10b, epochs | Every row of 6.1 tested; `uncertain` reconciler; outcome ledger labels |
| CW12 | E2E and device runbook | `e2e/2x-wallets-*.spec.ts`, `test/fixtures/wallets/**` | CW8, CW11 | Section 7 e2e green; device runbook from `product.md` section 5 extended per type |

Parallel lanes: {CW9a, CW10a} start at once; CW1 -> CW2 -> {CW3, CW4, CW6} -> CW5 -> {CW7 -> CW8}; {CW9b, CW10b} after epochs land; CW11; CW12. The issuance gate stays closed throughout; lifting it is an owner action per account (Q2).

## 9. Owner questions

Merged from `product.md` section 6, `google-wallet.md` section 11, `samsung-wallet.md` sections 8 and 12, plus this design. "Blocks" names the package that cannot finish without the answer.

| # | Question | Proposed | Blocks |
| --- | --- | --- | --- |
| Q1 | Accounts: per org and mode (as built) or one PassBook issuer (Google) and one partner (Samsung) for all orgs? Both research docs lean platform-wide; Samsung allows one business account per company. | Platform-wide for both, per-org only as an enterprise option | CW9b, CW10b (class and card ownership) |
| Q2 | Issuance gate proof: Google publishing access approved + one signed callback round trip; Samsung card `Active` per type + `ADDED` with `cc2` observed in Test? | Yes | Go-live (gate lift), not a package |
| Q3 | Ship Google first, Samsung after its card approvals, or hold both? | Google first | Rollout order |
| Q4 | Create provider objects lazily on first click, or eagerly at issue when an org opts in? | Lazy | CW11 |
| Q5 | 15 min p95 for provider updates and void visuals (door denial is immediate)? | Yes | CW11 acceptance |
| Q6 | Account `Failing`: hide the badge or keep it? | Hide | CW11 (offers) |
| Q7 | Galaxy with both eligible: recommend Samsung or Google? | Samsung | Delivery surfaces (outside this track) |
| Q8 | Apple badge on Android: QR-only "open on iPhone", or hide? | QR-only | Delivery surfaces |
| Q9 | Who configures provider accounts: platform admin, or org admins once RBAC lands? | Platform admin | CW10b account card ids UI |
| Q10 | Retire "Google Wallet" from the out-of-scope list in `platform-architecture.md` and add Samsung? | Yes | Docs only |
| Q11 | Ship the badges as recorded in `wallet-badges/README.md`, and accept Apple's licensed kit (`public/apple/README.md`)? | Yes | CW12 |
| Q12 | Do the owner prerequisites: Google issuer, business profile, Cloud project, service account, test accounts, publishing access, separate test project (`google-wallet.md` section 11); Samsung business account, CSR, card per type, testing mode, launch (`samsung-wallet.md` section 12). | Needed | CW9a/CW10a contract fixtures (recorded in demo/testing mode), CW12 devices |
| Q13 | Ask Samsung: one card for many tenant brands; platform issuing ticket and coupon; inbound AUTH token lifetime and signed path; supported countries; Samsung certificate rotation; `extendedFields`; Update Notification for `generic` and `giftcard`. | Send as one support ticket | CW10a (R1, R2 constants), CW4 (type list) |
| Q14 | Until Samsung confirms updates for `generic`/`giftcard`, compile those templates as `loyalty/others` with an approved `type` omission? | Yes | CW4 |
| Q15 | `boardingPass` stays Generic on both until carrier data and Google Flight/Transit class review exist? | Yes | none now; a later package |
| Q16 | Google typed classes (Loyalty, Event, Offer, Gift) go through Google class review (`reviewStatus`); accept that latency before a typed release goes live, with Generic meanwhile only if the author approves the `type` omission? | Yes | CW9b go-live |
| Q17 | Google event tickets: one class per event (`classKey`), so class count grows with events. OK? | Yes | CW9b |
| Q18 | Personal images (member photo, per-pass thumbnails) never go to Google or Samsung; shown as an omission. | Yes | CW6 |
| Q19 | Template art served from public immutable URLs (`/w/i/<sha256>.png`, guessable only by hash) because providers fetch images. | Yes | CW6 |
| Q20 | Display text over a provider limit is shortened with `…` and reported; identity values are never shortened and block that pass for that provider. | Yes | CW2 |
| Q21 | A compiler update that adds an omission pauses new offers for affected releases until re-approval; state changes keep flowing. | Yes | CW7 |
| Q22 | Samsung `appLink*` (required) defaults to the org logo, name and website setting; orgs without a website get the holder portal URL (sign-in, not a capability link). | Yes | CW4 |

## Owner answers (2026-11-11)

1. Accounts: one platform-wide Google issuer and one Samsung partner account issue for every org, with each org's branding on the card.
2. Rollout: Google first; Samsung follows once partner approval and the support questions are settled.
3. On a Galaxy where both are eligible, recommend Samsung Wallet first; Google stays visible.
4. One unified pass page serves all three wallets and recommends the right one for the device. Every eligible wallet stays reachable, and the browser barcode remains available for holders without a wallet. This replaces the separate "Apple on Android as a QR option" question.

The remaining questions in section 9 take the proposed defaults unless the owner says otherwise. Console setup (Google issuer, Samsung partner account, certificates) and the Samsung support ticket stay owner tasks.
