# Cross-Platform Wallet Support Audit

**Inspected boundaries:** Apple pass generation and storage; signing identities and Apple Wallet web service; public, portal, email, and bundle delivery; shared pass contracts/views and template designer. Source search found no Google Wallet or Samsung Wallet integration references under `src/` or `android/`; an alternate search for their API endpoints across the repository also found none.

## Summary

Current issuance is end-to-end Apple-specific: templates are Apple `pass.json`, each pass is signed and stored as a `.pkpass`, and installation and “in wallet” status use Apple-only routes and UI. This is an architectural gap for the requested cross-platform support, not a defect in the existing Apple flow.

**Recommended shape:** keep the pass’s stable ID, template version, personalization, and lifecycle as the domain record. Add provider-specific template mappings, accounts/readiness, and issuance state. Apple’s `.pkpass` remains one provider artifact; Google and Samsung require their own provider resources and add flows. Share domain features only where their meaning matches. Mark template features as required or optional: block issuance when a required capability is unavailable; permit optional degradation only with an explicit mapping or warning.

## Files

- `src/worker/modules/passes/builder.ts:26-61,202-267` — Build request and artifact types; resolves a template, signs, and packages the pass.
- `src/passkit/build.ts:24-27,254-260` — Apple identity and server fields written into `pass.json`.
- `migrations/0001_platform.sql:130-148,264-288,325-332,367-406` — Apple signing identities, pass artifact columns, pass versions, device registrations, and push/email outbox.
- `src/passkit/template/package.ts:87-92` — `.pkpasstemplate` inputs require `wallet.template.json` and Apple `pass.json`.
- `src/shared/pass-view/normalize.ts:26-38` and `src/shared/pass-view/types.ts:3-4,127-131` — Preview renderer consumes `PassJson` and targets iOS 27 versus legacy iOS.
- `src/web/portal/my-passes-page.tsx:126-127,154-158`, `src/shared/device.ts:5,19-30`, `src/worker/modules/me/service.ts:70` — Holder badge, device classification, and registration-derived wallet status.

## Findings

### 1. P1 · confirmed-source — Domain passes and Apple artifacts are coupled

`buildArtifact` returns a single byte array plus `passJson`; the pipeline builds, signs, and packages it as an Apple pass (`src/worker/modules/passes/builder.ts:54-61,202-267`). `BuildRequest` requires Apple `authToken`, `webServiceUrl`, and `identityId` (`:26-35`); `passkit/build.ts:254-260` writes Apple identifiers and web-service credentials into `pass.json`. The `passes` row stores one identity, auth token, web-service URL, and object key (`migrations/0001_platform.sql:264-288`).

**Impact:** adding another wallet output at this seam would entangle provider issuance with pass creation, persistence, and republishing. A Google object or Samsung card is not another `.pkpass` byte array.

**Recommendation:** make the canonical domain revision provider-neutral; store each provider’s artifact or remote-resource identifiers, published revision, state, and add URL separately. **Acceptance:** one domain revision can produce independently tracked Apple, Google, and Samsung outputs; republishing one does not overwrite or mislabel the others.

### 2. P1 · confirmed-source — “Identity” is specifically an Apple signing identity

The identity table requires a unique `pass_type_identifier`, team ID, certificate, APNs fields, and Apple NFC flag (`migrations/0001_platform.sql:130-148`). `IdentityResolver` returns `PassIdentity` plus Apple signing material and APNs binding (`src/worker/modules/identities/env-identity.ts:8-20,24-46`). Passes reference that identity directly (`migrations/0001_platform.sql:264-271`).

Google instead requires an Issuer account and registered service-account credentials for its REST/JWT issuance flow ([Google onboarding and REST authentication](https://developers.google.com/wallet/generic/getting-started/onboarding-guide)). Samsung requires partner onboarding, card/template identifiers, and partner-issued security credentials; its docs describe one partner account per company ([Samsung onboarding](https://developer.samsung.com/wallet/api_new/getting/guide.html)).

**Recommendation:** model provider accounts and credential references separately from Apple signer identities, including whether each account is configured, approved, or blocked. **Acceptance:** a missing or pending provider account produces an actionable readiness failure for that provider without preventing issuance to a ready provider; tenant/account scoping is verified.

### 3. P1 · confirmed-source — Holder installation and device status are Apple-only

The device model is `iphone | mac | other` (`src/shared/device.ts:5,19-30`). The portal renders an Apple badge for any active, unregistered pass (`src/web/portal/my-passes-page.tsx:126-127`); the shared holder view also builds an Apple badge (`src/web/portal/holder-pass-view.tsx:62-66`). Public delivery exposes `pass.pkpass` (`src/worker/modules/public/routes.ts:104,131-134`); email links and attachments are Apple-specific (`src/worker/modules/delivery/email.ts:72-74,115-118`). `inWallet` comes from Apple registration state (`src/worker/modules/me/service.ts:70`; registrations table: `migrations/0001_platform.sql:376-381`).

**Impact:** there is no provider selection, Google/Samsung add destination, or provider-qualified installed state. The existing QR opens the public pass page; it does not create a Google or Samsung artifact.

**Recommendation:** expose only eligible, ready provider actions and track installation/state per provider. **Acceptance:** exercise Apple, Google, Samsung, unsupported-device, and in-app-browser states; confirm each visible button reaches its own add flow and one provider’s registration never marks another as installed.

**Official platform limits:** Google supports REST and Android SDK flows; its web flow is a signed JWT link and requires a logged-in Google identity ([web issuance](https://developers.google.com/wallet/generic/web), [Android SDK eligibility and fallback](https://developers.google.com/wallet/generic/android)). The Android SDK checks device/API availability; Google documents a web-link fallback. Samsung’s web button is shown only on supported devices and requires partner permissions; its CData token expires after 30 seconds, so generate it at click time ([Samsung button integration](https://developer.samsung.com/wallet/api_new/addto/button.html)). The Samsung docs reviewed describe web, Android/app, and email/MMS flows, not a general iOS SDK. **[INFERENCE]** Treat iOS as a web-link surface unless Samsung confirms otherwise for the intended market.

### 4. P1 · confirmed-source — Template and preview features need explicit provider mappings

Templates are Apple `pass.json`; the designer edits Apple styles and barcode formats (`src/passkit/template/package.ts:87-92`; `src/web/admin/templates/designer/section-style.tsx:1-18,29-53`; `section-barcode.tsx:1,28-32`). The shared preview still maps Apple `PassJson`, Apple barcode enums, and iOS-generation layouts (`src/shared/pass-view/normalize.ts:26`; `src/shared/pass-view/barcode.ts:11-19`; `types.ts:3-4`). Apple-specific features include `nfc`, `featuredActions`, and `upcomingPassInformation` (`src/passkit/schema/pass-types.ts:272-277`).

Google’s Generic Object has its own class/object schema, barcode, text, image, location, Smart Tap, and rotating-barcode capabilities; Smart Tap also needs correctly configured class issuers and certified terminals ([Generic Object reference](https://developers.google.com/wallet/reference/rest/v1/genericobject)). Samsung uses partner-defined card templates and type-specific `attributes` in encrypted card data ([API guidelines](https://developer.samsung.com/wallet/api_new/purposes/guidelines.html)). These features are not a lossless field-for-field translation.

**Recommendation:** define shared domain fields (stable field keys, localized text, images, validity/state, barcode value/type, links) and explicit provider mappings for presentation and provider features. Give each template’s features required/optional status; fail before issuance for unsupported required features, and report visible degradation for optional ones. **Acceptance:** test a common membership/ticket mapping and required versus optional cases, including Apple NFC, poster layout, unknown barcode, Google Smart Tap, and Samsung template/account readiness; verify no required field silently disappears.

## Strengths, limitations, and checks

Immutable template versions, stable pass IDs, personalization, and existing Apple lifecycle handling provide useful foundations. The current Apple renderer has legacy/iOS 27 fallback logic, and the public QR is a useful Apple add path; neither is a cross-provider mapping.

This is a source and official-documentation audit only: no builds, tests, provider accounts, production calls, device tests, or regional eligibility checks were performed. Provider approval, supported markets/devices, and complete Samsung card-type field requirements remain unverified for this product. Before release, verify provider creation, update, void/removal, reissue, add-link expiry, unsupported-device handling, and provider-specific installed state on eligible and ineligible devices.
