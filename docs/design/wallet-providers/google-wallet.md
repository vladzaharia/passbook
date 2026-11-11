# Google Wallet: API research and gap check

Researched 2026-11-11 against developers.google.com/wallet. "UNCONFIRMED" = not stated on any official page I could fetch; verify before relying on it. Official docs gave no change after 2025-10 that affects this design (release notes: https://developers.google.com/wallet/docs/release-notes; latest entry 2026-09-15 "Android Expressive Passes", layout refresh for Generic, Event, Boarding, Loyalty).

## Decisions

1. Use the **Generic** pass type for everything. Typed verticals (loyalty, event, offer, gift card) add semantics PassBook does not model (points, seat, balance) and each has its own review surface. Revisit loyalty only if a tenant needs points/tier.
2. Pre-create class and object over REST, then issue a **skinny JWT** (object id only). The existing code already does this.
3. Sign with the service-account key (RS256, WebCrypto). Exchange the same key for an OAuth token (JWT-bearer). Cache the token.
4. One PassBook-owned issuer, one class per (org, template release), one object per pass instance. Per-org issuers only if a tenant demands their own brand/billing (see section 6).
5. Revocation = PATCH `state: INACTIVE` (plus clear the barcode). Google cannot delete objects.
6. Defer: Smart Tap, linked offers, rotating barcodes, grouping, Generic Private.

## 1. Pass types and fit

| Type | Fit | Notes |
| --- | --- | --- |
| Generic (`genericClass`/`genericObject`) | Use | Free-form cards; no dedicated type needed. https://developers.google.com/wallet/generic/resources/terminology |
| Generic Private | Defer | Sensitive data only (health, IDs); requires Google approval and verification documents; self-contained JWT, no server objects; supports add/delete callbacks. https://developers.google.com/wallet/generic-private-pass |
| Loyalty, Event ticket, Offer, Gift card | Not now | Same JWT/REST model, typed payload arrays (`loyaltyObjects`, `eventTicketObjects`, `offerObjects`, `giftCardObjects`). https://developers.google.com/wallet/reference/rest/v1/Jwt |

Model: Class = shared template (styling, callbacks, Smart Tap); Object = one issued pass. Ids are `issuerId.identifier`, alphanumeric plus `.` `_` `-`; object id must be unique across the issuer; the object's class must exist ("existing, approved class"). https://developers.google.com/wallet/generic/rest/v1/genericobject , https://developers.google.com/wallet/generic/rest/v1/genericclass

### GenericObject required and optional fields

Source: https://developers.google.com/wallet/generic/rest/v1/genericobject

- Required: `id`, `classId`, `cardTitle` (LocalizedString; first letter becomes the logo if none), `header` (LocalizedString, the pass title).
- Optional: `subheader`, `logo`, `wideLogo`, `heroImage`, `hexBackgroundColor`, `barcode`, `rotatingBarcode`, `state` (default ACTIVE), `validTimeInterval`, `genericType`, `textModulesData[]`, `linksModuleData`, `imageModulesData[]`, `appLinkData`, `messages[]`, `valueAddedModuleData[]`, `merchantLocations[]`, `linkedObjectIds[]`, `passConstraints`, `saveRestrictions` (checked only at save), `groupingInfo`, `notifications`, `smartTapRedemptionValue`.
- Limits stated: `textModulesData` and `linksModuleData`: 10 shown from class and 10 from object. `messages`, `valueAddedModuleData`, `merchantLocations`: max 10 (merchantLocations extras are rejected). `notifications`: only one of `expiryNotification` (2 days before end) or `upcomingNotification` (1 day before start); expiry wins if both set.
- Class-level extras: `callbackOptions`, `enableSmartTap`, `redemptionIssuers`, `multipleDevicesAndHoldersAllowedStatus` (enum values not listed on the page), `viewUnlockRequirement`, `securityAnimation`, `classTemplateInfo`. https://developers.google.com/wallet/generic/rest/v1/genericclass
- Hard text-length limits per field: UNCONFIRMED in the REST reference. Only design guidance exists (below).

### Display guidance (soft, English, "less than")

Source: https://developers.google.com/wallet/generic/resources/brand-guidelines

- Title < 47 chars; subtitle < 88; field label < 20; field value < 15. At most 2 fields per row, 3 rows. Notification title < 29, collapsed body < 40, expanded body < 80.
- Background: `hexBackgroundColor`; avoid neon; if unset Google derives from the logo. Palette suggestions on the same page.
- Logo: PNG, >= 660x660, 1:1, keep content inside the 840x840 safe area (15% margin), do not pre-mask to a circle (Google masks it).
- Wide logo: transparent PNG, 1280x400 recommended, min height 400, 16:5. Hero image: PNG, 1032x812 recommended (about 5:4), 20 dp top/bottom padding. Extra image (`imageModulesData.mainImage`): PNG, min width 1860.
- Images must be public HTTPS, reliably available, no redirects (redirects cause 404s); personal images are not supported. https://developers.google.com/wallet/generic/resources/faq
- Image file-size limit: UNCONFIRMED. Image object fields are `sourceUri.uri` (must have a scheme) and localized `contentDescription`. https://developers.google.com/wallet/generic/rest/v1/Image
- Barcode: fields `type`, `renderEncoding`, `value`, `alternateText`, `showCodeText`; no value-length limit stated. https://developers.google.com/wallet/reference/rest/v1/Barcode . Type values QR_CODE, PDF_417, AZTEC, CODE_128 (and TEXT_ONLY) are from a third party only (https://www.walletwallet.dev/blog/anatomy-of-a-google-wallet-pass/); the official enum page was not fetchable. Rotating barcodes: QR_CODE and PDF_417 only (third party; official reference https://developers.google.com/pay-wallet/products/wallet/reference/rest/v1/RotatingBarcode).
- Localization: `LocalizedString` = `defaultValue` + `translatedValues[]`, each `{language, value}` (the existing code uses `defaultValue`). Reference: https://developers.google.com/wallet/generic/rest/v1/genericobject (LocalizedString type page not fetched; field shape UNCONFIRMED beyond use in existing code).

## 2. Issuance

- Link: `https://pay.google.com/gp/v/save/<signed_jwt>`; works on web, email, SMS; initiating a save needs a logged-in Google identity. https://developers.google.com/wallet/generic/web
- JWT claims (all required): `iss` = service-account email, `aud` = `google`, `typ` = `savetowallet`, `iat` (seconds), `origins` (array), `payload`. https://developers.google.com/wallet/reference/rest/v1/Jwt . `exp` is not a documented claim; Google does not document enforcement, so link expiry must be enforced by PassBook's own endpoint.
- `origins`: domains allowed to host the button; without it the button does not render (X-Frame-Options errors). Docs' example lists both http and https forms of a host. Plain link clicks (email) do not render a frame; whether `origins` matters for them is UNCONFIRMED. Set it to the PassBook holder origin(s) regardless.
- Size: keep the encoded JWT under 1800 characters; longer URLs may be truncated by browsers. https://developers.google.com/wallet/generic/web , https://developers.google.com/wallet/generic/resources/faq
- Skinny JWT: payload holds only `{ "genericObjects": [{ "id": "ISSUER.OBJECT" }] }`; objects must pre-exist. https://developers.google.com/wallet/generic/use-cases/save-multiple-pass-types . Fat JWT (full class/object in payload) creates them at save time but hits the 1800-char limit quickly. Max objects per token: UNCONFIRMED. Decision: skinny only.
- Signing: RS256 with the service-account private key (`RSASSA-PKCS1-v1_5`/SHA-256, PKCS8 DER from the JSON key's PEM). Pure WebCrypto; no SDK. https://developers.google.com/wallet/generic/use-cases/jwt
- REST auth: scope `https://www.googleapis.com/auth/wallet_object.issuer`. Token exchange is the standard service-account JWT bearer flow: sign `{iss, scope, aud: https://oauth2.googleapis.com/token, iat, exp}` (exp at most 1 h after iat), POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=...`. https://developers.google.com/identity/protocols/oauth2/service-account#httprest . The Wallet page itself does not describe scopes or exchange (https://developers.google.com/wallet/generic/getting-started/auth/rest).
- Token caching: the response carries `expires_in` (normally 3600 s). Cache per service account in memory (isolate) with a short per-isolate TTL, or in KV/DO keyed by account id; refresh at about 80% of lifetime; drop on 401. Quota note: no documented token-endpoint limit for this flow; caching avoids 2 exchanges per sync op.
- Batching/latency: recommended client timeout 10 s (p99 about 5 s); PATCH partial updates and batch requests are the recommended performance levers. https://developers.google.com/wallet/generic/resources/faq

## 3. Updates and lifecycle

- REST base `https://walletobjects.googleapis.com/walletobjects/v1/`: `genericClass`, `genericObject` with insert (POST), get, patch (PATCH), update (PUT), `addMessage` (POST `.../genericObject/{id}/addMessage`). https://developers.google.com/wallet/generic/rest/v1/genericobject/patch , https://developers.google.com/wallet/generic/rest/v1/genericobject/update , https://developers.google.com/wallet/generic/rest/v1/genericobject/addmessage
- PATCH merge semantics for arrays: UNCONFIRMED on the method page. Treat arrays (`textModulesData`, `messages`) as replaced wholesale; send the full array.
- Update propagation latency to devices: UNCONFIRMED (not documented). No SLA. https://developers.google.com/wallet/generic/resources/faq
- addMessage: body `AddMessageRequest` (fields not shown; use `{message: {header, body, id, messageType, displayInterval}}`). `messageType` TEXT (default, card detail only) or `TEXT_AND_NOTIFY` (also an Android notification); max 10 messages per object/class. https://developers.google.com/wallet/reference/rest/v1/Message . Notification rate limits: UNCONFIRMED.
- States: ACTIVE, COMPLETED, EXPIRED (validTimeInterval passed), INACTIVE; inactive objects move to the expired section. https://developers.google.com/wallet/generic/rest/v1/State , https://developers.google.com/wallet/generic/rest/v1/genericobject
- `validTimeInterval {start,end}` (DateTime; same offset rule on both bounds). After end the object is treated as expired. https://developers.google.com/wallet/generic/rest/v1/TimeInterval
- Voiding/revoking: PATCH `state: INACTIVE`. The pass stays in the holder's wallet (expired section); also remove `barcode` and add a message so it cannot be presented as valid (barcode behavior of INACTIVE objects UNCONFIRMED).
- Deleting: "you cannot delete classes or objects from Google Wallet"; holders can unlink them. https://developers.google.com/wallet/generic/resources/faq . Plan on INACTIVE plus id never reused (credentialGeneration in the id already does this).

## 4. Callbacks (save and delete)

Source for all of this section: https://developers.google.com/wallet/generic/use-cases/use-callbacks-for-saves-and-deletions , https://developers.google.com/wallet/reference/rest/v1/CallbackOptions

- Configure per class: `callbackOptions.url` (HTTPS; robots.txt must allow Googlebot on that path). `updateRequestUrl` is deprecated.
- Request: POST, `Content-Type: application/json`, `User-Agent` contains `Googlebot` or `Google-Valuables` (substring match; do not rely on it for auth).
- Body: `{protocolVersion: "ECv2SigningOnly", intermediateSigningKey: {signedKey, signatures[]}, signature, signedMessage}`. Protocol `ECv2SigningOnly`; sender id `GooglePayPasses`; recipient id = your issuer id; root keys at `https://pay.google.com/gp/m/issuer/keys`. Docs recommend Tink `PaymentMethodTokenRecipient.unseal`.
- Worker verification (no Tink): fetch keys, keep entries with `protocolVersion == ECv2SigningOnly` and unexpired `keyExpiration`; verify an intermediate signature over length-prefixed (UTF-8, uint32 LE length) `[sender, protocol, signedKey]`; check intermediate `keyExpiration`; verify `signature` over `[sender, recipient(issuerId), protocol, signedMessage]` with the intermediate P-256 key (ECDSA/SHA-256, DER); then parse `signedMessage`. The length-value layout is from Tink's `PaymentMethodTokenUtil` (https://github.com/tink-crypto/tink-java, not re-fetched; matches the existing code). ECDSA signatures are DER; WebCrypto wants raw r||s, so convert or use `node:crypto` (see gap G9).
- Payload: `classId`, `objectId` (fully qualified), `expTimeMillis`, `eventType` = `save` | `del`, `nonce`. Reject after `expTimeMillis`.
- Retries: best effort, backoff while your endpoint fails. Duplicates possible; dedupe on `nonce`. Ordering: not specified; do not assume (a `del` can arrive before the `save` it follows; use object state, not arrival order).
- Respond 2xx quickly; 5xx only for transient failure.
- The callback fires on each save or delete by an end user, per class.

## 5. Holder experience

- Button: only Google's assets, never custom. Two styles (primary, condensed), black only; min height 48 dp, at least as large as other buttons, keep proportions; 8 dp clear space; allowed in apps, websites, email. Assets (Android XML, SVG, PNG; plus a "View in Google Wallet" deep-link button SVG/PNG) and localized variants are downloaded from the brand guidelines page; fallback to English; RU users get the generic "Save to phone" button because Wallet is not live there. https://developers.google.com/wallet/generic/resources/brand-guidelines . Light/dark variants: none documented.
- In email, use the button image linking to the save URL (mail clients do not run JS). https://developers.google.com/wallet/generic/web
- Android: link opens the Wallet save sheet. Web/desktop: sign-in with Google, then save. iOS: iOS is not mentioned on the issuing pages; behavior of the save link on iOS is UNCONFIRMED (assume it opens a browser sign-in flow; test on device). https://developers.google.com/wallet/generic/overview/add-to-google-wallet-flow
- Deep link to an already-saved pass: the "View in Google Wallet" button exists (brand guidelines); its URL scheme is UNCONFIRMED. Do not hardcode.
- Unavailable country/device: the API does not say. Supported countries are listed at https://support.google.com/wallet/answer/12060037 (some are "passes only"); the developer release notes list launches and Generic Private expansion. Design: always offer Apple/other fallback, detect nothing server-side (do not infer from IP), show the Google option based on user agent/choice, and keep a plain "Add to Google Wallet" link even where it fails gracefully.
- Test builds show "[TEST ONLY]" in demo mode (section 6).

## 6. Account, publishing, quotas, tenancy

- Issuer account: Google Pay & Wallet console (https://pay.google.com/business/console , short link goo.gle/wallet-console), sign in with the Google account that becomes Admin; accept the Wallet API ToS. https://developers.google.com/wallet/generic/getting-started/issuer-onboarding
- Demo mode: new issuers start here; passes only to Admin/Developer users and test accounts (Console > Google Wallet API > Manage > "Set up test accounts"); titles get "[TEST ONLY]"; same features as production. https://developers.google.com/wallet/generic/test-and-go-live/request-publishing-access
- Publishing access: complete the Business Profile (business info, payments profile), create at least one class, then Console > Google Wallet API > "Request publishing access". Manual review by the Wallet team; screenshots no longer required; "[TEST ONLY]" disappears from saved passes after approval without reissue. Review duration: UNCONFIRMED.
- Quota: "rate limited to 20 requests per second", no SLA (https://developers.google.com/wallet/generic/resources/faq). Per-issuer vs per-project scope and daily caps: UNCONFIRMED. 429 maps to retry with backoff (already classified in `google-errors.ts:42`).
- Multi-tenant: one issuer for all orgs is allowed (an issuer may be an "aggregator working on behalf of others", https://developers.google.com/wallet/generic/resources/terminology) and is the simplest; every pass shows the org's `cardTitle`/logo, so no brand leak. Per-org issuers need each org to onboard, pass publishing review, and hand over a service-account key: only offer as an enterprise option. The existing per-account credential model supports both.
- Namespacing: the existing HMAC ids (`issuer.c_<hmac>`/`issuer.o_<hmac>`) are opaque, tenant-bound, stable across key rotation, and within the allowed charset. Keep the HMAC secret out of Google's key lifecycle. Id length limit: UNCONFIRMED.
- Test vs prod: use a separate Cloud project/service account (and issuer) for test mode (suggested by https://developers.google.com/wallet/generic/resources/faq).

## 7. Security

- Save link: contains only issuer-side object id, service-account email, origins, iat. Never put PII, barcode values, capability/holder tokens, pass secrets or personalization in the JWT or in the object id. Fat JWTs would embed full pass data: do not use.
- A skinny save link is a bearer: whoever opens it while signed into Google can add that object. Mitigate with a short-lived, single-use PassBook URL that mints the JWT on demand (existing 900 s lifetime in `google-offer.ts:51`) and class `multipleDevicesAndHoldersAllowedStatus` set to one holder (enum value names UNCONFIRMED for Generic; verify against https://developers.google.com/wallet/generic/rest/v1/genericclass).
- Token lifetime: OAuth assertion exp = iat + 300 s is fine (max 3600); access token about 3600 s. Scope: only `wallet_object.issuer` (the code enforces exactly one scope).
- Key rotation: Cloud console > IAM > Service accounts > Keys, add a new JSON key, deploy, then delete the old one. Keep the object-id HMAC secret independent. Google callback keys rotate at the keys URL; refetch on verify failure.
- Callback: verify signature before any DB work; bound the body; never trust `User-Agent`.

## 8. Extras (defer)

| Feature | Verdict | Source |
| --- | --- | --- |
| Smart Tap NFC | Defer. Needs Smart Tap keys per issuer, `enableSmartTap`, `redemptionIssuers`, partner enablement ("available only to Smart Tap enabled partners") | https://developers.google.com/wallet/generic/rest/v1/genericclass |
| Linked offers / `linkedObjectIds` | Defer. Same issuer only, cannot unlink | genericobject page |
| Grouping (`groupingInfo`) | Defer | genericobject page |
| Location notifications | Cheap later: up to 10 `merchantLocations`; maps to Apple `locations` | https://developers.google.com/wallet/docs/release-notes (2025-10-14) |
| Time notifications | `validTimeInterval` + `notifications.expiryNotification/upcomingNotification` | genericobject page |
| Rotating barcodes | Defer. TOTP/valuePattern; scanners must understand it | RotatingBarcode reference |

## 9. Apple pkpass to Google mapping

| Apple | Google | Gap |
| --- | --- | --- |
| `organizationName` | `cardTitle` | Apple 35-char guard in code is fine |
| primary/header/secondary/auxiliary/back fields | `header` (title), `subheader`, `textModulesData[]` (id, header, body); max 10 shown per level | No row/placement control; Apple's field groups collapse to one list; > 10 fields dropped |
| `description` | none (accessibility only on Apple) | Code puts it as a text module; consider omitting |
| `barcode(s)` | `barcode` (type, value, alternateText, renderEncoding) | Google has one barcode; PKBarcodeFormat mapping QR/PDF417/Aztec/Code128 is direct |
| `backgroundColor`/`foregroundColor`/`labelColor` | `hexBackgroundColor` only | No foreground/label color; Google picks text contrast |
| icon/logo/strip/thumbnail | `logo`, `wideLogo`, `heroImage`, `imageModulesData` as public HTTPS URLs | PassBook must host and serve PNGs publicly; Apple's `@2x/@3x` multiples do not apply; strip maps to hero |
| `relevantDate` | `validTimeInterval` (start) + `notifications.upcomingNotification` | Not equivalent: no lock-screen surfacing |
| `expirationDate` | `validTimeInterval.end` | |
| `voided` | `state: INACTIVE` (or EXPIRED) | Cannot delete; pass remains listed |
| `locations` | `merchantLocations` (max 10) | Radius is set by Google |
| `webServiceURL`/`authenticationToken` | none; updates are pushed by PATCH | No pull model; holder device never calls PassBook |
| change messages | `addMessage` (TEXT_AND_NOTIFY) | Only Apple has the `%@` change template |
| NFC | Smart Tap | deferred |
| `userInfo`, `sharingProhibited` | `saveRestrictions`, `passConstraints` | not mapped |

## 10. Gap check: existing code vs API and guidelines

Files: `src/worker/modules/wallet-providers/`.

| # | Where | Finding | Fix |
| --- | --- | --- | --- |
| G1 | `runtime-google.ts:139-146`, `google-oauth.ts:21-71` | A new OAuth token is minted for every REST operation (class upsert and object upsert in one sync op = 2 exchanges); `expiresAt` is returned but never used | Cache by account id until about 80% of `expires_in`; invalidate on 401 |
| G2 | `render-projection.ts:173-184` | Object omits `hexBackgroundColor`, `heroImage`, `wideLogo`, `subheader`, `validTimeInterval`, `merchantLocations`; logo is the only artwork; no brand color from the template | Add through the reviewed projection schema (`projection-contract.ts:55-58` is a strict object, so extend it plus `GOOGLE_PROJECTION_POLICY.adapterCapabilities` `projection-contract.ts:8`) |
| G3 | `render-projection.ts:60,61,89,162-167` | Limits are 35/500/500 chars, far above Google's design guidance (title < 47, label < 20, value < 15) and no cap of 10 text modules; `projection-contract.ts` allows up to 9 fields plus the description module is added (10 total, at the limit; do not add more) | Keep as-is for hard limits; add soft-length warning in the projection review UI; keep total modules <= 10 |
| G4 | `render-projection.ts:175` | `state` is always `ACTIVE`; expiry never sent as `validTimeInterval.end`/`EXPIRED` | Map Apple `expirationDate` to `validTimeInterval.end` |
| G5 | `google-rest.ts:150-161` | Revocation only patches `state: INACTIVE`; barcode and text remain on the holder's device. Google cannot delete | Also patch `barcode` removal and a message; confirm INACTIVE hides the barcode (UNCONFIRMED) |
| G6 | `sync-operation-google.ts:105-110`, `google-callback-binding.ts:110` | Class carries only `callbackOptions` (`classProjection` is `{}`, `render-projection.ts:186`); no `multipleDevicesAndHoldersAllowedStatus`, no `viewUnlockRequirement` | Set one-holder status on the class |
| G7 | `google-offer.ts:63-64` | `exp` claim is sent but Google documents no `exp` enforcement (the code comment `:57` says so); `iat` is correct; claims otherwise match the JWT reference | No change; keep app-level expiry. `origins` accepts http: (`:23-24`); require https in production |
| G8 | `google-callback-crypto.ts:150` | Root keys are fetched on every callback with no cache; one extra outbound request per delivery, and a Google keys-endpoint outage rejects valid callbacks | Cache until the earliest `keyExpiration`; refetch on signature failure |
| G9 | `google-callback-crypto.ts:2,112-121,137-143` | Uses `node:crypto` (`createPublicKey`, `verify`) instead of WebCrypto; works only under the `nodejs_compat` flag. This is deliberate for DER ECDSA signatures | Acceptable; if WebCrypto-only is required, convert DER to raw r\|\|s before `crypto.subtle.verify` |
| G10 | `google-callback-crypto.ts:195,198` | `exactKeys` rejects any envelope with extra fields; Google adding a field (not documented as frozen) would reject every callback | Allow unknown keys; require the known ones |
| G11 | `google-callback-crypto.ts:232-237` | Class/object ids must match `^ISSUER\.c_[A-Za-z0-9_-]{43}$`; correct for PassBook-created ids only, and rejects any manual or legacy id | Fine; keep |
| G12 | `routes-google-callbacks.ts:10-12` | Callbacks are rate limited with `RL_APPLE_IP` per client IP; Google sends from a small crawler IP pool and could be throttled | Use a separate binding with a high limit, or exempt verified Google IPs after signature check |
| G13 | `google-rest.ts:24-49` | No `Retry-After`/backoff in the client; relies on `sync-errors.ts` classification (not reviewed here) for 429 (20 rps documented) | Verify backoff and a global concurrency cap of about 15 rps per issuer |
| G14 | `google-rest.ts:77-97` | Create-then-409-then-PATCH costs 3 requests on updates (POST, GET, PATCH) | After the first success, PATCH directly; use `GET` only when POST conflicts |
| G15 | `google-rest.ts` (whole) | No `addMessage` call, no PUT, no GET-by-id for state reconciliation beyond `verifyIdentity` | Add `addMessage` for change notifications (Apple change-message parity) |
| G16 | `projection-contract.ts:44`, `render-projection.ts:178-181` | `logoUrl` is any HTTPS URL up to 256 chars; no check that it is a public PNG >= 660x660 without redirect | Validate at projection review time (fetch, content type, dimensions) |
| G17 | `google-credentials.ts:20` | Issuer id regex `[0-9]{1,32}`; real issuer ids are numeric (length UNCONFIRMED), fine | none |
| G18 | `public/robots.txt` | Googlebot and Google-Valuables are allowed on `/wallet/v1/google/` as required | none (satisfies the robots.txt rule) |

Agree with API: REST base URL (`google-rest.ts:12`), scope (`google-credentials.ts:3`), JWT-bearer grant and `exp` of 300 s (`google-oauth.ts:28-40`), `ECv2SigningOnly`/`GooglePayPasses`/keys URL (`google-callback-crypto.ts:7,10-11`), skinny JWT payload (`google-offer.ts:56`), `callbackOptions.url` (`google-callback-binding.ts:110`), nonce dedupe (`google-callback-handler.ts:127`), QR_CODE+UTF_8 barcode (`render-projection.ts:170`).

## 11. Prerequisites for the owner

| # | Item | Exact step |
| --- | --- | --- |
| 1 | Issuer account | https://pay.google.com/business/console (goo.gle/wallet-console) > sign in with the Admin Google account > Google Wallet API > accept ToS. Copy the Issuer ID (numeric) from the Wallet API dashboard |
| 2 | Business Profile | Same console > Business profile > business info and payments profile (needed before publishing access) |
| 3 | Cloud project and API | https://console.cloud.google.com > select/create project > Marketplace "Google Wallet API" > Enable |
| 4 | Service account and key | Cloud console > IAM & Admin > Service Accounts > Create > Keys > Add key > Create new key > JSON. Store as a Worker secret; never commit. PEM must be PKCS8 (`BEGIN PRIVATE KEY`), which Google JSON keys are |
| 5 | Authorize the service account | Wallet console > Users > Invite a user > paste the service-account email > Access level "Developer" > Invite |
| 6 | Test accounts | Wallet console > Google Wallet API > Manage > "Set up test accounts" > one email per line > Update testers |
| 7 | One class | Required before publishing access; PassBook creates it on first sync (or create in the console's "Build your first pass") |
| 8 | Publishing access | Wallet console > Google Wallet API > "Get publishing access" > "Request publishing access" |
| 9 | Separate test and prod | A second Cloud project and service account (optionally a second issuer) for test mode |
| 10 | Button assets | Download Add to Google Wallet and View in Google Wallet buttons from https://developers.google.com/wallet/generic/resources/brand-guidelines and host localized copies |
| 11 | Callback host | Public HTTPS origin whose robots.txt allows Googlebot on `/wallet/v1/google/` (already in `public/robots.txt`) |
| 12 | Public image hosting | Logos/hero as public HTTPS PNGs, no redirects |
| 13 | Generic Private (only if wanted) | Request via Google Pay & Wallet Console support with verification documents; not needed now |

## Unconfirmed list (verify before building)

Barcode enum values from the official page; text length hard limits; image file size; PATCH array merge; update propagation latency; whether INACTIVE hides the barcode; save-link behavior on iOS; `multipleDevicesAndHoldersAllowedStatus` enum values for Generic; publishing review time; per-issuer quota scope and daily caps; token-endpoint limits; callback key cache headers; deep link URL for "View in Google Wallet"; whether `origins` affects plain-link saves.
