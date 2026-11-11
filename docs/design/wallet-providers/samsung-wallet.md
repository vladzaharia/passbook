# Samsung Wallet: partner integration (researched 2026-11-11)

Scope: what Samsung requires for PassBook to issue Samsung Wallet cards next to Apple. Sources are Samsung's own docs; `[U]` marks anything not confirmed in them (conflicting or missing). Samsung's docs contradict themselves in many places (listed in section 11); verify against the Partner Portal test tool before shipping.

Source keys (all under `https://developer.samsung.com/wallet/`):

- `S-card` = `api/wallet-cards.html` (card attribute tables)
- `S-api` = `addtosamsungwallet/apiguidelines.html` (links, server APIs)
- `S-atw` = `api/add-to-wallet-interface.html`
- `S-tok` = `securityauthentication/carddatatoken.html`
- `S-auth` = `securityauthentication/restapiauthorizationtoken.html`
- `S-key` = `securityauthentication/keycertificatelifecycle.html`
- `S-ops` = `securityauthentication/operationalsecuritycontrols.html`
- `S-sec` = `api/security.html` (older page, examples conflict with S-tok)
- `S-mgr` = `addtosamsungwallet/managewalletcard.html`
- `S-onb` = `api_new/getting/guide.html`
- `S-btn` = `addtosamsungwallet/implementingatwbutton.html`
- `S-img` = `references/imageresources.html`
- `S-dev` = `references/checkserviceavailabledevices.html`
- `S-tmpl` = `businesssupportforspecialpurposes/cardtemplatemanagement.html`
- `S-init` = `businesssupportforspecialpurposes/initiatedaddingwalletcard.html`
- `S-ov` = `addtosamsungwallet/overview.html`
- `S-code` = `codelabandtesttools/codelabexerciseforaddtowallet.html`
- `S-bar` = `addtosamsungwallet/barcodeqrcodepresentation.html`
- `S-fmt` = `references/datastructureandformat.html`

## 1. Decision summary

- Use the **Data Fetch Link** (`pdata`) as the primary flow. It keeps PII and pass data out of the URL, matches the existing Worker design (Samsung calls our Get Card Data), and works for email/SMS. Add the **Data Transmit Link** (`cdata`) only for the web button, where a fresh token is minted per click (30 s TTL).
- Ship **loyalty/others** first (the only type the code supports), then **ticket** and **generic**, then **coupon** and **giftcard**. Skip boarding pass, digital ID, digital key, pay-as-you-go in v1.
- One partner account and one signing keypair for the platform. One **card (template) per card type x tenant brand** is the unit Samsung approves; plan the tenant model around that (section 8).
- Block on owner prerequisites (section 12): nothing can be tested end-to-end without a Samsung partner account, CSR-signed certificate, and an approved card.

## 2. Card types and fit

Source for every row: S-card unless noted. Max 6 `card.data[]` objects per request. Common required per item: `refId` (<=32 in token/Get Card Data; S-ov says 128 [U]), `createdAt`, `updatedAt` (epoch ms UTC), `language` (<=8), `attributes`; optional `localization[]`.

| Type (`type`/`subType`) | Fit | Required attributes (length) | Notes |
| --- | --- | --- | --- |
| Loyalty (`loyalty`/`others`) | Best (current code) | `title`(32), `providerName`(32), `appLinkLogo`(256), `appLinkName`(32), `appLinkData`(256) | Optional `logoImage`(+`darkUrl`/`lightUrl`), `bgImage`, `bgColor`, `fontColor`, `startDate`, `endDate`, `noticeDesc`(5000), `csInfo`, `locations`(1024), `amount`/`balance`(32), `summaryUrl`, `barcode.*` |
| Event ticket (`ticket`/`performances,sports,movies,entrances,others`) | Good, v2 | `title`, `mainImg`(<=512 KB), `logoImage`(+dark/light), `providerName`, `issueDate`, `reservationNumber`(32), `startDate`, `noticeDesc`(5000), `appLinkLogo`/`Name`/`Data` | `endDate` null: expires 10 h after start. `eventId`(32) enables event-wide Cancel. `reactivatableYn`, `noNetworkSupportYn`, `privacyModeYn`, `preventCaptureYn`, `groupingId`. Maps to Apple event ticket. |
| Coupon (`coupon`/`others`) | Good | `title`, `mainImg`(<=512 KB), `expiry`, `issueDate`, `editableYn`, `deletableYn`, `displayRedeemButtonYn`, `notificationYn`, `appLink*` | Data removed after `expiry`. `redeemDate`/`redeemUrl`. Dual barcodes (`value2`). No Update Notification restriction stated. |
| Gift card (`giftcard`/`others`) | Possible | `title`, `providerName`, `appLink*` | **No Update Notification** (S-ov). `amount`/`balance` display only. `barcode.pin`(16). |
| Generic (`generic`/`others`) | Good for "anything else" | `title`, `providerName`, `startDate`, `mainImg`, `noticeDesc`(1024), `appLink*` | Up to 15 `text{n}`(64), 5 `image{n}`, 2 `serial{n}`. **No Update Notification** (S-ov) though S-api documents `fields` for generic only [U]. Closest to Apple generic. |
| Boarding pass (`boardingpass`/`airlines,train,buses,others`) | Out of scope | many airline-conditional fields | Cancel needs `vehicleNumber`. |
| Digital ID (`idcard`) | Out of scope | `holderName`, `identifier`, `issueDate`, `csInfo`, `providerName`, `title` | Likely needs Samsung approval for the use case [U]. |
| Also listed | Out of scope | Digital Keys, Pay As You Go, Clip, Reservation | Not researched. |

Images (S-card): logos <=256 KB; `mainImg`, `coverImage`, `bgImage`, `seatLayoutImage` <=512 KB; recommended card background 888 x 555 px; `idPhoto` <=128 KB base64 (ID) or 200000 chars (ticket). Images are **HTTPS URLs that Samsung fetches and caches**; change the URL path to force a refresh (`addtosamsungwallet/walletcards/overview.html`). Allowed formats are not stated [U]; use PNG/JPEG. Pass Apple-style embedded images cannot be used; every image needs a stable public URL (R2 + immutable path).

Barcodes (S-bar): `barcode.serialType` SERIALNUMBER, BARCODE, QRCODE (+ SHIPPING, CALLORDER, URL online-only); `ptFormat` BARCODE, BARCODESERIAL, SERIAL, DUALSERIAL, DUALBARCODE, DUALBARCODESERIAL, BARCODEPIN, QRCODE, QRCODESERIAL; `ptSubFormat` 1D (CODABAR, CODE_39, CODE_93, CODE_128, EAN_8, EAN_13, ITF, RSS_14, RSS_EXPANDED, UPC_A, UPC_E) and 2D (QR_CODE, AZTEC, DATA_MATRIX, MAXICODE, PDF_417); `value` <=4096; `errorCorrectionLevel` L/M/Q/H; `barcode.interval` (seconds) only for Dynamic QR, which must be enabled in the portal. Apple's PKBarcodeFormat QR/PDF417/Aztec/Code128 all have equivalents.

## 3. Add to Samsung Wallet

Links (S-atw, S-api):

| Flow | URL | When |
| --- | --- | --- |
| Data Fetch Link (formerly "slim") | `https://a.swallet.link/atw/v3/{certificateId}/{cardId}#Clip?pdata={refId}` | Default. Link carries only an opaque ref; Samsung then calls our Get Card Data. Works in email/SMS/static pages. `certificateId` 4 alnum; `cardId` <=32; `#Clip` case-sensitive. |
| Data Transmit Link (formerly "typical") | `https://a.swallet.link/atw/v3/{cardId}#Clip?cdata={cdata}` | Web/app button; card data embedded as JWT. Older MMS example uses `/atw/v1/{cardId}` (S-btn). |
| Data Action Link | `.../{certificateId}/{cardId}#Clip?adata=user_auth` | Authentication-bound flows. Not needed. Table says `pdata`, URL says `adata` [U]. |
| Server-initiated Add (Register Card API) | `POST /atw/v1/cards/{cardId}` | Needs admin-granted permission and a resolvable Samsung account (`email`/`phoneNumber`); confirms via Send Card State ADDED (S-init). Not for v1. |

Limits: `pdata` max is **2048** (S-api card guidelines), **128** (S-api), **256** (S-ops). Use 32 chars (192-bit base64url); fits all. `cdata` in Get Card Data response <=4096 chars. Total link-length limit: not stated [U]; keep `cdata` links to the web button only. Pdata must be non-inferable, no PII (S-ops).

Card data token (S-tok; applies to `cdata` in links, in Get Card Data responses, and Register Card):

- Order: build card JSON, **encrypt to a JWE, then sign the JWE as the payload of a JWS** (outer JWS, inner JWE). Compact serialization at both layers.
- Inner JWE header: `alg` = `RSA1_5` (documented example), `enc` = `A128GCM`. Encrypt to **Samsung's public certificate** (sent by email after CSR signing) (S-code: Samsung certificate "used to encrypt card data and validate authentication tokens"). Other `alg`/`enc` values are not documented [U]. S-sec's example shows `kid: WLT.PUBKEY` but no table lists `kid` [U].
- Outer JWS header: `alg` `RS256`, `cty` `CARD`, `ver` `3`, `certificateId` (4 chars), `partnerId`, `utc` (epoch ms). Signed with the **partner private key** whose CSR was submitted. S-sec's example shows `ver:1`, `cty:PASS`, `kid:PTN.PRIKEY` (stale page).
- `ver` is `String(4)` in S-tok but the example is numeric `3` [U]; Samsung presumably accepts either.
- Lifetime: `utc` is the anti-replay time check; the exact window is not documented [U]. Portal docs state a **30 s TTL** for `cdata` (S-mgr, S-btn). Generate at click time, never at page render (S-tok); regenerate on retry (S-ops).
- Auth token for REST calls (S-auth): JWS header same as above with `cty` `AUTH`; payload `{API:{method,path}, refId?, authentication?, updatedAt?}`; sent as `Authorization: Bearer <JWS>` (<=1024 chars; verifiers should accept a bare token). `path` excludes scheme, host, query. Whether `path` includes the partner base path or the `cc2` prefix is unclear [U] (examples show `/cards/...` and `/wltex/cards/12584806754/notification`).

Worker implementation (WebCrypto only):

- RS256 signing: `crypto.subtle` `RSASSA-PKCS1-v1_5` + SHA-256, key imported as PKCS#8. Fine (the repo uses `jose` `CompactSign`).
- A128GCM: `crypto.subtle` AES-GCM, 128-bit key, 96-bit IV, 128-bit tag, AAD = ASCII of the base64url protected header. Fine.
- **RSA1_5 is not in WebCrypto** (only RSA-OAEP/RSASSA/RSA-PSS). Options: (a) `node:crypto` `publicEncrypt` with `RSA_PKCS1_PADDING` under `nodejs_compat` (the repo's choice, `samsung-token.ts:151-155`), (b) hand-roll PKCS#1 v1.5 encryption with `crypto.subtle` raw RSA, not recommended, (c) ask Samsung whether `RSA-OAEP` is accepted [U]. Keep (a) and pin a test with a Node-generated token. Samsung's developer guidance says use a standard JOSE library rather than hand-built JWE (`securityauthentication/developerguidance.html`).
- Certificates: Samsung cert (public, from email) and the signed partner certificate are PEM X.509; parse with pkijs (done) and check validity dates.

## 4. Server-to-server

Partner server URL is set per card in the portal (General Information: "Partner Get card data URL", "Partner Send card state URL"; both optional) (S-mgr). Samsung appends `/cards/{cardId}/{refId}`.

Samsung calls us (S-api):

| Call | Request | We must return |
| --- | --- | --- |
| Get Card Data | `GET {url}/cards/{cardId}/{refId}?fields=a,b` (fields <=128, optional); headers `Authorization` (JWS `AUTH`), `x-request-id` | `200` with `{cdata}` (JWS(JWE), <=4096) or `{card:{...}}` plain (Samsung recommends `cdata` for sensitive data); `204` card does not exist; `401` invalid token; `400`/`500`/`503`. Each `data[]` carries `state`. |
| Send Card State | `POST {url}/cards/{cardId}/{refId}?cc2=US&event=ADDED`; optional body `{callback}` (<=1024, Samsung server URL) | `200` empty. Events: ADDED, UPDATED, DELETED, PROVISIONED. Documented codes: 200/401/500/503 (no 204). |
| Request Action | `POST .../requestAction` | Only for transfer/refund flows. Skip. |

We call Samsung (S-api): public host `https://tsapi-card.walletsvc.samsung.com` (needs `cc2`, no IP registration) or the private `callback` host from Send Card State (for IP-allow-listed setups); Samsung server IPs are listed per card in the portal (S-ops).

- Update Notification: `POST /{cc2}/wltex/cards/{cardId}/updates`, headers `Authorization`, `x-smcs-partner-id`, `x-request-id`; body `{card:{type,data:[{refId,state}]}}`. States: ACTIVE, UPDATED, EXPIRED, REDEEMED, HELD, DELETED, SUSPENDED, MIGRATED (needs `atwLink`, `oldRefId`). `204` = card does not exist. Samsung then calls Get Card Data to pull the content. `cc2` must equal the `cc2` from that card's ADDED event (S-ov), so persist per-ref country from Send Card State.
- Batch Update: `/batch/updates` by `eventId` (S-api).
- Cancel Notification: `/{cc2}/wltex/cards/{cardId}/cancels`; ticket needs `eventId`, boarding pass `vehicleNumber`. Event-wide, all holders.
- Authentication: Samsung -> us uses the same `AUTH` JWS, signed with **Samsung's key**; verify with the Samsung certificate received at onboarding (S-code: used to "validate authentication tokens in server API headers"). Bind check: `API.method`/`API.path` must match the request (S-auth "MUST"). Which Samsung certificate to trust and rotation of it are not documented [U].
- Retries and idempotency: **not documented** (S-api, S-ops: "on retry, generate a fresh token"). `x-request-id` is only a trace id (<=32 in tables, <=64 in S-ops; UUID preferred). Treat Update/Cancel as idempotent state sets, dedupe inbound by token hash + `x-request-id`, and treat 5xx/timeouts as ambiguous. Token lifetime and skew tolerance for inbound Samsung tokens are not documented [U].

## 5. Lifecycle

- **Update**: change data, then Update Notification `UPDATED`; Samsung pulls via Get Card Data. `updatedAt` should reflect the real change time (Samsung uses it; `S-auth` carries `updatedAt`). Gift and generic cards do not support Update Notification (S-ov) [U on generic: S-api shows generic-only `fields`].
- **Expiry**: ticket `endDate` (default start+10 h); coupon/ID `expiry` removes data after expiry; set `state` `EXPIRED` via notification for others. Holder-visible rendering per state is **not documented** (S-ov, card overview pages) [U].
- **Void/cancel**: per-card `CANCELED`/`SUSPENDED`/`HELD`/`REDEEMED` via Update Notification (Get Card Data may also return those states); whole-event `CANCELED` via Cancel Notification (ticket `eventId`).
- **Delete**: `DELETED` via Update Notification removes the card; user deletion reports `DELETED` via Send Card State. 204 from Samsung = unknown ref; it does not prove a device removal.
- **Re-issue**: `MIGRATED` state with `atwLink` and `oldRefId` moves a card to a new ref.
- Push to the device is done by Samsung after notification; delivery latency and guarantees are not documented [U].

## 6. Holder experience

- Button (S-btn, S-img): web script `https://us-cdn-gpp.mcsvc.samsung.com/lib/wallet-card.js` with `<samsung:wallet>` tag (required: `cardid`, `cdata` or `pdata`, `partnercode`, `buttonid`, `rdclickurl`, `rdimpressionurl`; optional `certificateid`, `buttontype` btnSW/btnATSW/qrcode, `mediatheme` default/inversion/lightonly/darkonly, `showforced`, `model`). Copy the script from the portal.
- Assets (S-img): btnSW `wallet-card(.png|-dark|-ver|-ver-dark)`, btnATSW `add-to-samsung-wallet_[dark_][ver_]en-us.png`, base `https://us-cdn-gpp.mcsvc.samsung.com/lib/v2`. Logo asset and toolkit v2025_2.0 (2025-01-15) hold clear-space and sizing rules (download only; not readable here). Other locales "to be provided" [U]. Pixel sizes and email rules [U].
- Email/SMS: plain anchor around the button image to the ATW URL plus a 1x1 impression pixel (RD impression URL); **no device gating possible** (S-btn). The `a.swallet.link` link opens Samsung Wallet on supported Galaxy devices; behavior elsewhere [U]. Use a PassBook landing page that detects the device and shows Apple/Google/Samsung options; email links go to that page, not straight to `a.swallet.link`.
- Device/country: Samsung Wallet runs on Samsung Galaxy phones (device pages list only Samsung models; `references/devicecompatibility.html`). No country list for cards is published [U]; availability depends on the device model/region. Detect with the web tag's built-in model check (shows the button only on supported devices; shown if UA gives no model, so pass `model` or check server-side), or the server API `GET https://api-us3.mpay.samsung.com/wallet/cmn/v2.0/device/available?modelName=...&serviceType=WALLET` with header `partnerCode` (S-dev). UA contains `SM-xxxx` model for Galaxy browsers; detection logic is ours [U].
- Unsupported device: web tag hides the button (unless `showforced`); our landing page should fall back to Apple/Google/PDF/QR.

## 7. Security rules

- Never put in a link: PII, names, emails, pass data, predictable ids, secrets, partner keys. Link = `pdata` only: 192-bit random ref (S-ops).
- `pdata` is a bearer capability: Samsung reuses it for later refreshes (existing code comment, `samsung.ts:39`), so revoke by retiring the ref, and rate-limit Get Card Data.
- `cdata`: generate on user action, 30 s TTL, never cache or log; include `utc` (S-tok, S-mgr).
- Keys: RSA >= 2048 (S-onb: `openssl genpkey` RSA 2048); private key in Workers secret/Secrets Store, envelope-encrypted at rest; signing key never leaves the Worker; CSR CN must equal the FQDN of the partner domain (S-key).
- Replay: record hash of each inbound token (+ `x-request-id`), reject duplicates, check `utc` freshness (S-ops: NTP-synced clocks).
- Allow-list: Samsung IPs from the portal if the origin is IP-restricted (Cloudflare Workers cannot rely on that; verify the JWS instead).
- Rotation (S-key): generate new key + CSR, register while the old one is active, start issuing with the new `certificateId`, retire the old key. Multiple CSRs are allowed. Compromise: stop issuing, new credentials.

## 8. Partner onboarding

Steps (S-onb, S-mgr), portal `https://partner.walletsvc.samsung.com`:

1. Create a Samsung Account, sign in at the Wallet Partners Portal, "Get started" to register a Business Account (one account per company).
2. Samsung runs "Wallet partner onboarding"; a welcome email arrives with the CSR info. Approval timeline [U].
3. Encryption setting: choose "End to End Encryption (CSR)" or "None (Upload later)"; upload a `.csr`. Samsung returns the **Samsung Public Key (certificate) and Signed Certificate** by email. After signing, the fields are locked (My Account > Wallet Partner Management / Encryption Setting Management).
4. Manage Wallet Card > create card: Folder, Testing mode, name, **Wallet Card ID**, partner app package, Template (type/subtype; default or flexible layout), **Get card data URL**, **Send card state URL**, language/messages (S-mgr).
5. Statuses: Draft -> Launch (irreversible) -> Verifying (Samsung review) -> Active or Rejected (reason emailed). Templates API shows VERIFYING/ACTIVE/BLOCKED (S-tmpl). Layout cannot change after activation.
6. **Testing mode** is on by default; test data is periodically deleted; Test Tool at `https://partner.walletsvc.samsung.com/addToWalletTest` (upload private key, edit card JSON, preview, adds a card; "Playground" works without a card) (S-code). Turn testing mode OFF before release. Separate Card IDs for test and production (S-ops).
7. Multi-tenant: **a single partner/CSR for many orgs is the model Samsung's single-account rule implies**, but whether one card can show different tenant branding (logo/colors per pass via attributes) or each brand needs its own approved card is not documented [U]. Plan: one card per type, tenant branding via attributes (`logoImage`, `bgColor`, `providerName`), and confirm with Samsung before launch. Samsung reviews content/brand impersonation risk; platform-as-issuer may need a statement of use [U].
8. Quotas/rate limits: not documented [U]. Max 6 data objects per request.

## 9. Apple pkpass -> Samsung mapping

| Apple | Samsung | Gap |
| --- | --- | --- |
| Signed `.pkpass` zip downloaded | Link, Samsung fetches JSON + images | No offline file; needs public image URLs and our server up at add and refresh time |
| `passTypeIdentifier` + cert | `cardId` + `partnerId` + `certificateId` | Per card type, not per tenant |
| `serialNumber` | `refId` (<=32, random, bearer) | refId is also the capability |
| Pass types (eventTicket, coupon, storeCard, generic, boardingPass) | `ticket`, `coupon`, `loyalty`, `generic`, `giftcard`, `boardingpass` | No 1:1 structure; fields are flat attributes, free text in `noticeDesc` |
| `fields` (header/primary/secondary/auxiliary/back) | Fixed named attributes + `text{n}` (generic) | Layout is the template, not per-pass |
| `barcodes` | `barcode.*` | Equivalent; Samsung adds dynamic QR |
| `relevantDate`, locations, beacons | `startDate`, `locations` (<=10), no beacons [U] | Beacons missing |
| `webServiceURL` + APNs push | Update Notification + Get Card Data pull | Samsung owns delivery; no device registration list for us (no Apple-style register/unregister), only Send Card State events |
| `voided`, `expirationDate` | State `CANCELED`/`EXPIRED`, `expiry`/`endDate` | State rendering undocumented |
| Strip/thumbnail/icon/logo images | `mainImg`, `logoImage`(light/dark), `bgImage`, `coverImage` | Different sizes; Apple `icon` has no analogue |
| Locale `.lproj` | `localization[]` | Replaces attributes per language |
| Update via pass re-fetch | `updatedAt` + notification | `fields` partial fetch generic only |
| NFC passes | NFC via digital key/ID types | Out of scope |

## 10. Gap check against the code

Files: `/Users/vlad/Repos/wallet/src/worker/modules/wallet-providers/` (relative below). Severity: **B** blocker, **R** risk, **N** note.

**B1. Refs are never promoted, so every Samsung callback is rejected (confirmed).**
- `callbacks-samsung.ts:53-59` calls `findSamsungFetchSnapshot(..., requirePromoted = true)`, which at `repo-callbacks.ts:175` requires `r.promoted_at IS NOT NULL`.
- A repo-wide search finds no production statement that sets `promoted_at` (only the column in `migrations/0037_wallet_providers.sql:447`, reads in `repo-callbacks.ts:62,170,175`, `repo-callbacks-events.ts:34,113`, `repo-accounts.ts:172`, and test fixtures).
- Result: a new ref has `promoted_at NULL`, so the first Get Card Data (Samsung's fetch right after "Add") finds no snapshot; line 60-69 then returns 401. Add to Wallet never succeeds.
- `repo-callbacks-events.ts:57` states "never promotes a ref without independently verified market eligibility", and `samsungInitialWindowSql` (`repo-callbacks.ts:62-68`) exists for the pre-promotion window, but the one caller passes `true`. Fix: call with `false` for the first GET (using the initial window), and promote atomically in the first verified claim once eligibility evidence exists (section 10 B3), or promote on verified ADDED.

**R1. Inbound path binding may reject genuine Samsung tokens.** `samsung-token-inbound.ts:78-79,94` requires signed `API.path` to equal the full request pathname (`/wallet/v1/samsung/cards/{cardId}/{refId}`). Samsung builds the path from the configured partner URL; S-auth examples show `/cards/...` [U]. Accept `/cards/{cardId}/{refId}` (suffix) as well, and confirm in the Test Tool.

**R2. Inbound token age 30 s is assumed.** `samsung-token-inbound.ts:10,89-90` rejects `utc` older than 30 s (+5 s skew). Samsung documents 30 s only for partner `cdata`; its own AUTH token lifetime is not documented [U]. Retries/queued deliveries over 30 s will 401 and be treated as hostile. Widen (e.g. 5 min) and rely on the replay store.

**R3. Outbound auth-token path may be wrong.** `samsung.ts:184-189` signs `API.path = /{cc2}/wltex/cards/{cardId}/{action}`. S-auth's example path is `/wltex/cards/{cardId}/notification` (no `cc2`; also `notification` vs `updates`) [U]. Verify with a real 401 in testing mode; keep `cc2` only in the URL if Samsung rejects.

**R4. Send Card State `event` is ignored; DELETED/UPDATED never acted on.** `callbacks-samsung.ts:49,197-209` reads only `cc2` and stores the raw encrypted body; `event` (ADDED/DELETED/UPDATED/PROVISIONED) is never parsed. Receipts are stored (`repo-callbacks-events.ts:68-130`) but the only other reader of the receipt table is the retirement SQL (`repo-instance-retirement-sql.ts`). Consequences: holder deletions are not recorded, per-ref `cc2` is only a hint stored on a receipt, and `ADDED` never marks the pass installed. Parse and persist `event` + `cc2` per ref (needed for Update Notification, section 4).

**R5. POST "missing" returns 204.** `callbacks-samsung.ts:204-206` and `routes-callbacks.ts:26`: Send Card State documents only 200/401/500/503 (S-api). Return 200 for unknown but authenticated refs.

**R6. Template probe may never succeed.** `samsung-template.ts:185-186` requires `state === 'ACTIVE'` and `testingModeOff === 'Y'`. S-tmpl says `testingModeOff` is "only available when updating templates", though its GET example shows `Y` [U]; documented states are VERIFYING/ACTIVE/BLOCKED, so ACTIVE is right. Confirm the GET returns `testingModeOff` for Active cards; otherwise `not_eligible` forever.

**R7. No timeout on Update/Cancel requests.** `samsung.ts:192-202` has no `AbortSignal.timeout` (the template probe has one at `samsung-template.ts:161`). A hung fetch holds the operation claim.

**R8. Notifications always use the public host.** `samsung.ts:28,192` ignores the `callback` URL from Send Card State (S-api private host for IP-allow-listed partners). Fine for the public host; note it, no action.

**R9. Only one card type; strict type literal.** `projection-contract.ts:62-63` allows only `loyalty`/`others`; `samsung.ts:228-247` allows no `generic`/`giftcard` updates (correct per S-ov). Ticket/coupon need new projection variants, `eventId` for Cancel (`samsung.ts:276-300` already supports `ticket` Cancel), and image URL rules.

**R10. Unverified attribute `extendedFields`.** `render-projection.ts:206-214,261` sends `extendedFields` (JSON string, <=1024 bytes). It is not in the loyalty table in S-card (it is called a "JSON-encoded string" only in the code comment at line 224) [U]. If Samsung ignores unknown attributes the card shows no pass fields; if it rejects them the add fails. Replace with documented fields (`noticeDesc`, `subtitle1`, `amount`/`balance`, `csInfo`) or ask Samsung. Also `render-projection.ts:251` sets `updatedAt: now` on every fetch, so Samsung sees every pull as a content change; use the pass's real update time.

**R11. `ver` type.** `samsung-token.ts:51` sends `ver` as the string `'3'`; S-tok's table says `String(4)` but its example uses numeric `3` [U]; inbound accepts both (`samsung-token-inbound.ts:83`). Low risk; test both.

**N1. Card-state union omits `MIGRATED`.** `samsung-token.ts:22-31` and `samsung.ts:228-238` (S-api lists MIGRATED with `atwLink`/`oldRefId`). Needed only for re-issue.

**N2. Credentials require both certificates unexpired.** `samsung-credentials.ts:176-177` caps validity at the earlier of partner and Samsung certificate. Cert validity periods are not documented [U]; track expiry with an alert and a rotation runbook (S-key rotation steps).

**N3. refId is exactly 32 chars everywhere.** `routes-callbacks.ts:16`, `callbacks-samsung.ts:40`, `runtime-samsung.ts:72,152`, `samsung.ts:48`. Matches the design (192-bit base64url) and S-api limits for Get Card Data; Send Card State allows 128 [U], only matters if Samsung ever calls with a partner-chosen ref.

**N4. Matches the spec (confirmed).** Link format (`samsung.ts:54`), JWS `AUTH`/`CARD` headers and RS256 (`samsung-token.ts:48-57`), JWE `RSA1_5`/`A128GCM` encrypted to the Samsung certificate then signed (`samsung-token.ts:129-169`), `x-smcs-partner-id` + `x-request-id` headers (`samsung.ts:196-200`), Get Card Data `204` for missing (`routes-callbacks.ts:26`), `fields` filter (`callbacks-fields.ts:8-43`), no Update for generic/giftcard (`samsung.ts:239-246`), template endpoint host/path (`samsung-template.ts:7-8,150`), key size >= 2048 (`samsung-credentials.ts:88-94`).

## 11. Documentation inconsistencies seen (verify in Test Tool)

- `pdata` max 2048 / 128 / 256 across pages; `refId` 32 vs 128.
- Update Notification example path `/notification` vs `/updates`; Batch `/batch/notification` vs `/batch/updates`; Cancel example uses `refId` not `eventId`.
- Get Card Data `fields` vs example `select`.
- Data Action Link `adata` vs `pdata`.
- `x-smcs-cc2` header vs `x-request-cc2` in the Register Card example.
- JWT `ver` 3 vs 1, `cty` CARD vs PASS, `kid` present in examples only (S-sec vs S-tok).
- `testingModeOff` in Get Template.
- Digital ID `barcode.interval` String(4) with a 6-char example.
- Old doc paths (`/wallet/api/...`, `/api_new/...`) coexist with `/wallet/securityauthentication/...` (current navigation, `references/technicalsupport.html`); prefer the latter.

## 12. Owner prerequisites (exact portal steps)

1. **Samsung Account + Business Account**: `https://partner.walletsvc.samsung.com` > Sign In > Create account > "Get started" > Business Account > submit business info (one per company). Then wait for Samsung's onboarding email.
2. **Generate keys and CSR** on a secure machine: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out partner.key`; `openssl req -new -key partner.key -out partner.csr` with Common Name = exact FQDN of the Worker domain used for Samsung callbacks (`passbook.mobile` or the chosen host; confirm which, S-key). Do not share the key. (S-onb)
3. **Upload CSR**: sign-up step "Set encryption information" or later My Account > Encryption Setting Management > Encryption Type "End to End Encryption (CSR)" > upload `.csr` > Done. Samsung emails the **Samsung Public Key (certificate)** and the **signed partner certificate**. Record `partnerId` (partnerCode) and `certificateId` (4 chars) from the portal. These feed the account service (`samsungCertificatePem`, `partnerCertificatePem`, key, ids).
4. **Create the wallet card**: Manage Wallet Card > new card > General Information: name, **Wallet Card ID**, Template (start with Loyalty/others), partner app package (required field name, may be blank if no app [U]), **Get card data URL** = `https://<host>/wallet/v1/samsung`, **Send card state URL** = same, Testing mode ON, support languages. Copy `cardId`.
5. **Test**: Test Tool `https://partner.walletsvc.samsung.com/addToWalletTest` (upload `partner.key`, pick card, Add to Samsung Wallet) and a Galaxy phone with a Samsung Account in a supported country; confirm Get Card Data and Send Card State hit the Worker.
6. **Launch**: General Information > turn Testing mode OFF > Launch (irreversible) > wait for Verifying review; rejection reason is emailed. State becomes Active.
7. **Button assets and script**: Image Resources page toolkit v2025_2.0 (Logo Toolkit) for brand rules; copy the Add to Wallet script (with `rdclickurl`/`rdimpressionurl`) from the card's detail page.
8. **Ask Samsung Support** (`https://developer.samsung.com/dashboard/support/wallet`) to confirm: multi-tenant branding on one card; allowed ticket/coupon issuance for a platform; inbound AUTH token lifetime and path format; Samsung server IPs if needed; supported countries; rotation of the Samsung certificate; extension attribute `extendedFields`.
9. Secrets to provide to the platform (never in git): partner private key PEM, partner signed certificate PEM, Samsung certificate PEM, `partnerId`, `certificateId`, `cardId`. Cert expiry dates for monitoring.
