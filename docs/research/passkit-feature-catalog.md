# Apple Wallet pass (PassKit / Wallet Passes) feature catalog

Status: current as of **2026-10-31** (iOS/watchOS 27.x shipping, macOS 27). Written for a pass platform that wants to claim "supports all pass features". Every non-obvious claim has a source; anything not confirmed by Apple or by a device test is marked **UNVERIFIED** or **(RE)** (reverse-engineered or field-tested by a third party, not Apple-documented).

How this was researched: I walked the full Apple DocC tree (`https://developer.apple.com/tutorials/data/documentation/walletpasses.json`, 63 pages, crawled 2026-10-31), and read the HIG Wallet page (updated 2026-06-08), the WWDC24, WWDC25 and WWDC26 Wallet session transcripts and code, the archived *Wallet Developer Guide* and *PassKit Package Format Reference*, Apple's open-source **Pass Builder** (`apple/pass-builder` @ `6138535`, 2026-10-22), and the **passkit-generator** repo (v3.7.0 plus commits up to 2026-10-17, including its iOS 18, 26 and 27 investigation threads). I also read Apple Developer Forums DTS answers. Source IDs like **[S12]** resolve in §24.

---

## 0. Read this first: corrections and big-ticket facts

1. **Version naming.** Apple's year-based OS numbers mean iOS 26 shipped in 2025 (WWDC25) and **iOS 27 in 2026 (WWDC26)**. The brief says "iOS 26 added poster generic passes, featured actions, new barcode formats such as Code 39". That is **wrong by one version**. All three are **iOS 27 / watchOS 27** features [S30][S16][S5]. iOS 26 brought semantic airline boarding passes, multi-event "upcoming events", airline service URLs, the background-add-passes API, and the `relevantDates[].date` key [S31][S19][S27].
2. **Apple's `Pass` reference metadata is unreliable for minimum OS.** It lists `introducedVersion 6.0` for almost every top-level key, including iOS 18 keys like `bagPolicyURL` [S2]. The minimum OS values in this catalog come from WWDC sessions, the archived reference, and dated changelogs.
3. **Apple's `Pass` reference does not list `posterGeneric`, `featuredActions`, `footerFields`, `businessChatIdentifier`, `stripColor` or `logoSymbolName`.** They are documented elsewhere (guides, WWDC, Pass Builder) or not at all. A validator that is generated only from the `Pass` reference page will reject valid iOS 27 passes.
4. **Lock-screen location relevance still exists on iOS 27.** It is passive (a suggestion, not an alert). The radius for `generic`, `posterGeneric`, `storeCard` and `coupon` is small: "on the order of a hundred meters", about 100 m (RE). The user controls it with the per-pass **"Suggest on Lock Screen"** toggle [S39][S33][S49]. You cannot increase the radius. `maxDistance` can only shrink it, and the top-level `maxDistance` that Apple documents is reportedly **ignored** (RE, per-location `maxDistance` works instead) [S49]. Details are in §8.
5. **Manifest hashing is still SHA-1.** Apple's own Pass Builder (Oct 2026) emits SHA-1 manifests and a CMS/PKCS#7 detached signature with the WWDR **G4** intermediate [S23][S37][S44].

---

## 1. Feature timeline (what arrived when)

| OS | Wallet-pass features added or changed | Sources |
|---|---|---|
| iOS 6 | Passbook: 5 styles (`boardingPass`, `coupon`, `eventTicket`, `generic`, `storeCard`), `barcode` (QR/PDF417/Aztec), `locations`, `relevantDate`, web service, `changeMessage`, localization | [S33][S36] |
| iOS 7 | `beacons`, `maxDistance`, `expirationDate`, `voided`, `groupingIdentifier`, `userInfo`, `attributedValue`, `ignoresTimeZone`; strip shine removed (`suppressStripShine` became a no-op) | [S36] |
| iOS 9 / watchOS 2 | `barcodes[]` array with fallbacks, `PKBarcodeFormatCode128` (not on watchOS), `nfc` (VAS, entitlement required) | [S36][S6][S10] |
| iOS 10 / watchOS 3 | Rewards enrollment / personalization (`personalization.json`, `/personalize`), web-service endpoint docs re-based to iOS 10 | [S35][S28][S26] |
| iOS 11 | `sharingProhibited` | [S2] |
| iOS 12 / watchOS 5 | `semantics` (semantic tags), Siri suggestions (Do Not Disturb, and so on) | [S13][S15] |
| iOS 13.1 | `nfc.requiresAuthentication` | [S10] |
| iOS 18 / watchOS 11 | Poster event tickets (`preferredStyleSchemes: ["posterEventTicket","eventTicket"]`; NFC entitlement required), `relevantDates[]` (`relevantDate` deprecated), `additionalInfoFields`, `artwork`/`primaryLogo`/`secondaryLogo` images, event-guide URL keys, `footerBackgroundColor`, `useAutomaticColors`, `suppressHeaderDarkening`, `auxiliaryStoreIdentifiers`, many event semantics, `EventDateInfo`, `seatSectionColor`, Live Activities for event tickets | [S32][S20][S9][S54] |
| iOS 18.1 | `eventLogoText`, `EventDateInfo.unannounced` and `undetermined` | [S55] |
| iOS 26 / watchOS 26 | Semantic ("upgraded") airline boarding passes (`semanticBoardingPass`), flight tracking and Live Activity, badges, SSR codes, airline-services URLs, footer image for airline passes, `upcomingPassInformation` (multi-event), `relevantDates[].date` replaces `relevantDates[].relevantDate`, `PKPassLibrary` `backgroundAddPasses` capability | [S31][S19][S27][S53][S24] |
| iOS 26.1 | `trackBagsURL` | [S2] |
| iOS 27 / watchOS 27 / macOS 27 | **`posterGeneric` style** with `footerFields`; **`featuredActions`** (≤2, all styles); **barcodes Code 39, Codabar, EAN-13, ITF (I2of5)**; Pass Designer (Mac) and Pass Builder (Swift/Linux, `buildpass` CLI, protobuf schema); (RE) poster event tickets may use barcodes without NFC; (RE) issuer certificate shown in pass details | [S30][S16][S17][S5][S37][S38][S51] |

---

## 2. Pass package (bundle) format

| Item | Rule | Source |
|---|---|---|
| Bundle | Directory (source dir named `*.pass`), zipped, extension `.pkpass`, MIME `application/vnd.apple.pkpass` | [S22][S23][S26] |
| `pass.json` | Required. UTF-8 JSON. | [S23] |
| Images | PNG, `name.png`, `name@2x.png`, `name@3x.png`. See §12. Each `.lproj` must contain the same number of resolutions for a localized image. | [S29][S22] |
| Localization | `xx[-YY].lproj/pass.strings` and localized images. See §13. | [S22] |
| `manifest.json` | JSON object mapping each file's relative path to its **SHA-1** hex digest. Must list every file except `manifest.json` and `signature`, including files in subdirectories. Exclude `.DS_Store` and other junk. | [S23][S37] |
| `signature` | **PKCS#7 / CMS detached** signature over `manifest.json`, made with the Pass Type ID certificate's private key and including the **Apple WWDR G4** intermediate. Pass Builder also adds a signing-time attribute and accepts EC or RSA keys. | [S23][S37][S44] |
| `personalization.json` + `personalizationLogo*.png` | Only for personalizable (rewards-enrollment, NFC) passes. See §16. | [S35] |
| `tooling.json` | Written by Pass Designer and Pass Builder (`designerVersion`, `builderVersion`, `automaticallyGenerateCompatiblePass`). It is included in the manifest and Wallet tolerates it. | [S37] |
| `_id` keys | Pass Designer stamps a UUID `_id` on fields, barcodes and actions. Pass Builder keeps them in signed passes, so Wallet ignores them. An engine may strip them. | [S37] (template in this repo) |
| `.pkpasstemplate` | Pass Designer document: a plain directory package that holds a pass source. Pass Builder personalizes it, using the Swift API or `buildpass personalize --protobuf`. | [S30][S37] |
| Multi-pass bundle | Zip of `.pkpass` files renamed to **`.pkpasses`**, MIME **`application/vnd.apple.pkpasses`**, **≤10 passes or 150 MB** | [S24] |
| Pass identity | `passTypeIdentifier` + `serialNumber`. Re-adding the same pair replaces the pass. `serialNumber` and `authenticationToken` must never change in updates. | [S23][S25][S34] |

---

## 3. Top-level `pass.json` keys

Legend for **Styles**: `ALL`, or the list of styles where the key has an effect. `PET` = poster event ticket (eventTicket + `posterEventTicket` scheme). `SBP` = semantic boarding pass (boardingPass + `semanticBoardingPass` + `PKTransitTypeAir`). `PG` = posterGeneric.

### 3.1 Standard (required) keys

| Key | Type | Rules | Since |
|---|---|---|---|
| `formatVersion` | integer | **Required**, must be `1`. (RE: `formatVersion: 2` exists internally; Wallet refuses non-Apple passes that use it with `sharing` [S50].) | iOS 6 |
| `passTypeIdentifier` | string | **Required**. Must match the signing certificate. Reverse-DNS form starting `pass.` | iOS 6 |
| `serialNumber` | string | **Required**. Unique per `passTypeIdentifier`, immutable | iOS 6 |
| `teamIdentifier` | string | **Required**. Must match the certificate's team | iOS 6 |
| `organizationName` | localizable string | **Required**. Shown on the Lock Screen and in Mail | iOS 6 |
| `description` | localizable string | **Required**. Accessibility description ("enough detail to distinguish passes of the same type") | iOS 6 |

### 3.2 Style keys

Provide exactly one legacy style key. Since iOS 27 you may also add `posterGeneric` alongside a legacy key for fallback [S16][S30].

| Key | Value | Notes | Since |
|---|---|---|---|
| `boardingPass` | PassFields + **`transitType`** (required) | `PKTransitTypeAir`, `PKTransitTypeBoat`, `PKTransitTypeBus`, `PKTransitTypeGeneric`, `PKTransitTypeTrain` [S11] | iOS 6 |
| `coupon` | PassFields | | iOS 6 |
| `eventTicket` | PassFields | `auxiliaryFields[].row` allowed | iOS 6 |
| `generic` | PassFields | | iOS 6 |
| `storeCard` | PassFields | (Apple metadata says iOS 10, but store cards existed in iOS 6) | iOS 6 |
| `posterGeneric` | PassFields (header/primary/footer/back/additionalInfo) | Wallet prefers `posterGeneric` when present. Pair it with `generic`, `storeCard`, `coupon` or `eventTicket` for iOS ≤26. Does **not** use `preferredStyleSchemes` [S16][S51]. | **iOS/watchOS 27** |
| `preferredStyleSchemes` | [string] | Ordered schemes, each validated in turn, then fallback to the style key. Known values: `posterEventTicket`, `eventTicket` (iOS 18), `semanticBoardingPass`, `boardingPass` (iOS 26) [S20][S19][S37] | iOS 18 |

### 3.3 Visual appearance

| Key | Type | Styles | Notes | Since |
|---|---|---|---|---|
| `backgroundColor` | CSS `rgb(r, g, b)` string | ALL | Ignored when a background image is present (archive) [S33]. Pass Builder and passkit-generator also accept `#RRGGBB`, but **emit `rgb()`** (Apple documents only `rgb()`). | iOS 6 |
| `foregroundColor` | rgb string | ALL | Field values | iOS 6 |
| `labelColor` | rgb string | ALL | Field labels. System chooses when omitted. | iOS 6 |
| `stripColor` | rgb string | strip styles | **Undocumented**: color of primary-field values over a strip [S48][S37]. UNVERIFIED on iOS 27. | ? |
| `footerBackgroundColor` | rgb string | PET (the HIG implies PG too) | Footer material strip color [S2][S29] | iOS 18 |
| `useAutomaticColors` | bool | PET | Derives colors from artwork and ignores fg/label colors [S2] | iOS 18 |
| `suppressHeaderDarkening` | bool | PET, PG (RE) | Default `false` [S2][S51] | iOS 18 (PG 27) |
| `logoText` | localizable string | ALL except PET | Text next to the logo | iOS 6 |
| `eventLogoText` | localizable string | PET | | iOS 18.1 |
| `logoSymbolName` | string | ? | **Pass Builder only**: "An SF Symbol to display as a logo image" [S37]. UNVERIFIED on device. | ? |
| `suppressStripShine` | bool | strip styles | Obsolete since iOS 7 (no shine is ever drawn) [S36]. Apple's page still documents it with default `true`. | iOS 6 |
| `groupingIdentifier` | string | `boardingPass`, `eventTicket` only | Groups passes with the same type ID, style and identifier [S2][S36] | iOS 7 |
| `barcode` | Barcode dict | ALL | **Deprecated** (iOS ≤8 only, QR/PDF417/Aztec) [S6] | iOS 6, deprecated iOS 9 |
| `barcodes` | [Barcode] | ALL | First displayable entry wins. See §7. | iOS 9 |

### 3.4 Relevance

Full behavior is in §8.

| Key | Type | Limits | Since |
|---|---|---|---|
| `locations` | [Location] | **≤10** | iOS 6 |
| `maxDistance` | number (meters, must be a JSON number) | `min(maxDistance, styleDefault)` per docs. (RE) root key ignored, per-location key honored [S49]. | iOS 7 |
| `beacons` | [Beacon] | **≤10** UUIDs. Use major/minor to cover more beacons [S12]. | iOS 7 |
| `relevantDate` | W3C/ISO 8601 date-time string | **Deprecated** in iOS 18. Still needed for iOS ≤17. | iOS 6 |
| `relevantDates` | [RelevantDate] | Each interval ≤ ~24 h (RE) [S54] | iOS 18 / watchOS 11 |

### 3.5 Expiration

| Key | Type | Notes | Since |
|---|---|---|---|
| `expirationDate` | ISO 8601 date-time string (must include hours and minutes) | After this date the pass is marked expired and auto-hidden to "Expired" [S29][S36] | iOS 7 |
| `voided` | bool | `true` means void (for example a redeemed coupon), hidden as expired [S2][S36] | iOS 7 |

Field note: Wallet may also hide event tickets as expired about 24 h after `relevantDate`, even when `expirationDate` is later (reports on iOS 15.6.1 to 17.6.1) [S43]. Apple's poster generic guide: "Generic passes don't auto-expire based on the signing date. Use `expirationDate` … to explicitly control the expiration date" [S16].

### 3.6 Web service

| Key | Type | Rules | Since |
|---|---|---|---|
| `webServiceURL` | string (HTTPS, optional port) | HTTP only works with the iOS Developer setting "Allow HTTP Services". Requires `authenticationToken`. [S25][S36] | iOS 6 |
| `authenticationToken` | string | **≥16 characters** (archive), immutable across updates. Sent as `Authorization: ApplePass <token>` [S36][S34] | iOS 6 |

### 3.7 Associated app, companion app, sharing

| Key | Type | Styles | Notes | Since |
|---|---|---|---|---|
| `associatedStoreIdentifiers` | [number] (App Store Adam IDs) | ALL (not watchOS) | First compatible app is used. For SBP, listing your app also **suppresses Wallet's own Live Activity** [S19]. | iOS 6 |
| `appLaunchURL` | string | ALL | Passed to the associated app. Requires `associatedStoreIdentifiers` [S36]. passkit-generator allows non-http schemes [S55]. | iOS 6 |
| `auxiliaryStoreIdentifiers` | [number] | PET (and upcoming entries) | Apps shown in the event guide [S2] | iOS 18 |
| `userInfo` | any JSON | ALL | Hidden data for companion apps | iOS 7 |
| `sharingProhibited` | bool | ALL | Removes the Share button. Does not prevent other sharing. | iOS 11 |
| `sharing` | `{method, url?, text?}` | ALL | **Undocumented (RE, tested iOS 27.2)**: `method` is `PKPassSharingMethodPass` (default), `PKPassSharingMethodURL` (needs `url`; `text` optional) or `PKPassSharingMethodDisabled`. Ignored when `sharingProhibited` is set [S50]. | ? |

### 3.8 NFC and semantics

| Key | Type | Notes | Since |
|---|---|---|---|
| `nfc` | `{message, encryptionPublicKey, requiresAuthentication?}` | Needs an NFC-enabled Pass Type ID certificate (entitlement). See §15. | iOS 9 |
| `semantics` | SemanticTags | Also allowed inside any field dictionary. See §11. | iOS 12 |

### 3.9 Featured actions (iOS 27)

| Key | Type | Notes |
|---|---|---|
| `featuredActions` | [Action], **max 2**, in priority order | Shown as cards below the pass. Applies to all styles **except** PET and SBP, where the semantic URLs drive the buttons (RE) [S30][S51]. See §14. |

### 3.10 Poster event ticket "event guide" and menu URLs (iOS 18)

All are strings and are documented as "works only for poster event tickets" [S2]. The same keys exist per upcoming event in `upcomingPassInformation[].URLs` (iOS 26) [S27].

`accessibilityURL`, `addOnURL`, `bagPolicyURL`, `contactVenueEmail`, `contactVenuePhoneNumber`, `contactVenueWebsite`, `directionsInformationURL`, `merchandiseURL`, `orderFoodURL`, `parkingInformationURL`, `purchaseParkingURL`, `transitInformationURL` populate the event-guide buttons. Apple: "minimum of one and up to four quick action buttons" [S20]. (RE) at least two are needed for the guide buttons to show [S48]. `sellURL` and `transferURL` appear in the pass menu next to Share (RE) [S48].

### 3.11 Semantic boarding pass "airline and services" keys (iOS 26)

These are strings, effective on SBP [S2][S19]:

`changeSeatURL`, `entertainmentURL`, `managementURL`, `orderFoodURL` (meal ordering), `purchaseAdditionalBaggageURL`, `purchaseLoungeAccessURL`, `purchaseWifiURL`, `registerServiceAnimalURL`, `reportLostBagURL`, `requestWheelchairURL`, `upgradeURL`, `transitProviderEmail`, `transitProviderPhoneNumber`, `transitProviderWebsiteURL`, **`trackBagsURL` (iOS 26.1)**, and **`businessChatIdentifier`** (Messages for Business). `businessChatIdentifier` appears in Apple's SBP guide table but not on the `Pass` page [S19][S55].

### 3.12 Multi-event

| Key | Type | Notes | Since |
|---|---|---|---|
| `upcomingPassInformation` | [UpcomingPassInformationEntry] | Ordered list of upcoming events on a PET. See §17. | iOS 26 |

---

## 4. Pass styles, field groups and display limits

"Max displayed" is what the front of the pass shows. Extra fields are not shown on the face, but they still appear in pass details [S18]. Text length can reduce the counts further [S21]. The archive warns not to rely on hidden extra fields, because layouts change [S33].

| Style | Header | Primary | Secondary | Auxiliary | Footer | Back | Additional Info | Images used | Location radius | Date relevance |
|---|---|---|---|---|---|---|---|---|---|---|
| `boardingPass` (legacy) | ≤3 | ≤2 (origin/destination) | ≤4 | ≤5 (rendered above secondary) | — | unlimited | — | icon, logo, footer | large (~1 km doc; 1500 m RE) | recommended |
| SBP (iOS 26, air only) | semantic layout | semantic | semantic | semantic | — | yes | — | icon, primaryLogo, footer (airline) | large | via semantics and `relevantDates` |
| `coupon` | ≤3 | 1 (over strip) | ≤4 secondary+aux combined | (combined) | — | unlimited | — | icon, logo, strip | small (~100 m) | **not supported** |
| `eventTicket` (legacy) | ≤3 | 1 | ≤4 | ≤4 per row; `row: 1` adds a second row of ≤4 | — | unlimited | — | icon, logo, strip **or** background+thumbnail | large | recommended |
| PET (iOS 18) | semantic | semantic | semantic | semantic | seat/admission footer (auto) | yes | **yes** | icon, artwork **or** background, primaryLogo, secondaryLogo, venueMap (undocumented) | large | `relevantDates` drive the Live Activity |
| `generic` | ≤3 | 1 | ≤4 | ≤4 (4+4 = 8 with a rectangular barcode); **≤4 combined with a square barcode** | — | unlimited | — | icon, logo, thumbnail | small (~100 m) | optional (date **and** location must match) |
| `storeCard` | ≤3 | 1 (over strip) | ≤4 secondary+aux combined, one row | (combined) | — | unlimited | — | icon, logo, strip | small (~100 m) | **not supported** |
| **`posterGeneric` (iOS 27)** | **1** | **≤4** (first one with no `label` renders as a bold title) | not shown | not shown | **1 shown** (docs say two; WWDC: "only the first will be displayed") | unlimited | **yes** | icon, **artwork** (or background, UNVERIFIED precedence), **primaryLogo**; `logo` for fallback | small (100 m RE) | as generic (UNVERIFIED) |

Sources: [S33] (archive limits, relevance table), [S21], [S16], [S17], [S30], [S20], [S19], [S49] (radius RE), [S51].

Field-group dictionaries (`PassFields`) [S3][S37]:

| Key | Type | Since | Notes |
|---|---|---|---|
| `headerFields` | [Field] | 6 | Visible when the pass is collapsed in the stack |
| `primaryFields` | [Field] | 6 | `textAlignment` not allowed |
| `secondaryFields` | [Field] | 6 | |
| `auxiliaryFields` | [Field + `row` 0/1] | 6 | `row` is for event tickets only |
| `backFields` | [Field] | 6 | Pass details. Data detectors apply here. Shown on watchOS 7+. `textAlignment` not allowed. |
| `additionalInfoFields` | [Field] | 18 | "Only poster event ticket passes support the Additional Info section" [S3]. The poster generic guide lists it for PG too [S16]. |
| `footerFields` | [Field] | **27** | PG only. Not on the Apple `PassFields` page; documented in the PG guide, WWDC26 and Pass Builder [S16][S30][S37]. |
| `transitType` | string | 6 | `boardingPass` only, required |

Apple Watch: no strip, no thumbnail, and on older watchOS no back fields [S16][S33].

---

## 5. Field dictionary (`PassFieldContent`) keys

| Key | Type | Allowed values / rules | Since | Notes |
|---|---|---|---|---|
| `key` | string | **Required**. Archive: "must be unique within the scope of the entire pass" [S36] | 6 | Apple's own WWDC26 sample reuses keys across the `posterGeneric` and `generic` dicts. Keep keys unique **within** a style dict. |
| `label` | localizable string | | 6 | PG: omitting the label on the first primary field gives the bold-title treatment [S30] |
| `value` | localizable string, ISO 8601 date, or number | **Required**. Dates must include a time zone | 6 | |
| `attributedValue` | same types | Only `<a href>` is supported. Overrides `value`. Not used on watchOS. | 7 | (RE, iOS 27) a `changeMessage` on a field with `attributedValue` shows the raw markup [S56] |
| `changeMessage` | localizable format string | Must contain `%@` (the new value) | 6 | See §22. Not used on watchOS. |
| `dataDetectorTypes` | [string] | `PKDataDetectorTypePhoneNumber`, `PKDataDetectorTypeLink`, `PKDataDetectorTypeAddress`, `PKDataDetectorTypeCalendarEvent`. Default: all. `[]` means none. | 6/7 | Back fields only |
| `textAlignment` | string | `PKTextAlignmentLeft`, `PKTextAlignmentCenter`, `PKTextAlignmentRight`, `PKTextAlignmentNatural` (default) | 6 | **Invalid for primary and back fields** |
| `dateStyle` / `timeStyle` | string | `PKDateStyleNone`, `PKDateStyleShort`, `PKDateStyleMedium`, `PKDateStyleLong`, `PKDateStyleFull` | 6 | Their presence makes the value a date. The archive says to give both or neither [S36]. |
| `isRelative` | bool | default false | 6 | Does not affect relevance |
| `ignoresTimeZone` | bool | default false | 7 | Does not affect relevance |
| `currencyCode` | ISO 4217 string | | 6 | Number values only. **Mutually exclusive** with `numberStyle` (archive; Pass Builder warns) [S36][S37] |
| `numberStyle` | string | `PKNumberStyleDecimal`, `PKNumberStylePercent`, `PKNumberStyleScientific`, `PKNumberStyleSpellOut` | 6 | Number values only |
| `row` | number 0/1 | auxiliaryFields in eventTicket | 18 (documented with poster event) | Adds a second auxiliary row |
| `semantics` | SemanticTags | | 12 | Field-level tags behave the same as the root `semantics` [S15] |

Pass Builder's fix-it strips date keys from non-date values and `numberStyle` from non-numbers [S37]. A strict engine should apply the same rules.

---

## 6. Field-level validation rules (quick list)

- `key` and `value` are required. Keep `key` unique within the style dict, and ideally across the pass [S36].
- Date values must be ISO 8601 with a time zone. Use `dateStyle`, `timeStyle`, `isRelative` and `ignoresTimeZone` only on date values [S4][S37].
- Use `numberStyle` or `currencyCode` (one, not both) only on numeric values [S36].
- `textAlignment` is not allowed on primary or back fields [S4].
- `dataDetectorTypes` is meaningful on back fields only. `[]` disables detection [S4].
- `attributedValue` supports only `<a href>`. watchOS shows `value` [S4].
- `changeMessage` must include `%@` [S4].
- `row` is only valid on eventTicket `auxiliaryFields` [S3].

---

## 7. Barcodes

`barcodes[]` objects, `Pass.Barcodes` [S5]:

| Key | Type | Rules |
|---|---|---|
| `format` | string | **Required**. See the table below. |
| `message` | string | **Required** |
| `messageEncoding` | string | **Required** in docs. IANA charset, typically `iso-8859-1` (PassKit supports any NSString encoding) [S33] |
| `altText` | string | Text shown near the barcode. Not shown on watchOS. |

| `PKBarcodeFormat…` | Min iOS | Shape | Watch | Notes |
|---|---|---|---|---|
| `QR` | 6 | square | yes | |
| `PDF417` | 6 | rectangular | yes | |
| `Aztec` | 6 | square | yes | |
| `Code128` | 9 (`barcodes[]` only) | rectangular | **no** (falls back to the next entry; if it is the only entry, no barcode) [S33][S6][S37] | |
| `Code39` | **27** | rectangular | UNVERIFIED | Data: 0–9 A–Z space `-.$/+%` (symbology rule, not Apple-documented). Whether Wallet adds the `*` start/stop and how it treats a check digit is UNVERIFIED, so test with the real scanner. |
| `Codabar` | **27** | rectangular | UNVERIFIED | |
| `EAN13` | **27** | rectangular | UNVERIFIED | 12 or 13 digits (symbology) |
| `I2of5` (ITF) | **27** | rectangular | UNVERIFIED | Even digit count (symbology) |

Rules:
- "The system uses the first displayable barcode for the device" [S2]. On iOS ≤26 a new-format-only pass renders **no barcode**, so lead with the preferred format and fall back (WWDC26) [S30]. If a fallback is impossible, show the credential ID prominently in a header or primary field and train staff for manual entry [S30].
- The legacy `barcode` dict (iOS ≤8) supports only QR, PDF417 and Aztec [S6].
- Styles: all styles accept barcodes. A square barcode reduces the generic, coupon and storeCard secondary+aux budget to 4 combined [S3]. PET: Apple's guide says poster event tickets "aren't compatible with tickets that require a QR code or barcode for entry" [S20], and Pass Builder's validator errors when `nfc` is missing [S37]. (RE, Aug 2026, iOS 27) PET renders with `barcodes` and no NFC [S51]. **Conflict**, so treat barcode-only PET as iOS 27+ and UNVERIFIED by Apple.
- No documented cap on the number of `barcodes[]` entries.

---

## 8. Relevance and the Lock Screen (critical)

### 8.1 Keys

`locations[]` (`Pass.Locations`) [S7]: `latitude` (double, **required**), `longitude` (double, **required**), `altitude` (double, m, optional), `relevantText` (string, optional, shown on the Lock Screen), and **`maxDistance`** (number > 0, **undocumented here, RE**) [S49]. **Max 10 locations** [S2][S12].

`beacons[]` (`Pass.Beacons`) [S8]: `proximityUUID` (string, **required**), `major` and `minor` (UInt16, optional), `relevantText`. Up to 10 UUIDs. The most specific match supplies the text [S33]. Apple's own sample also shows a `name` key, which is not documented as a property [S12]. Requires Bluetooth.

`relevantDates[]` (`Pass.RelevantDates`, iOS 18 / watchOS 11) [S9]: either `{startDate, endDate}` (endDate required with startDate) or `{date}` (a single moment, from which Wallet computes an interval). All values are ISO 8601 with hours and minutes.
- The single-moment key was **`relevantDate` in iOS 18 and `date` from iOS 26 on**. (RE, iOS 26b2) `date` surfaces the pass and `relevantDate` did not [S53]. Emit both for 18 and 26+.
- (RE) each interval must fit within one day (≤24 h). Wallet logs "Dropping relevancy interval…" for multi-day spans [S54].
- Root `relevantDate` is deprecated but still needed for iOS ≤17.

`maxDistance` (root) [S2]: "The system uses the smaller of this distance or the default distance." **(RE, Oct 2026, tested iOS 27.2 plus binary analysis back to iOS 6)**: Wallet "never reads a root `maxDistance`". It reads `maxDistance` **inside each location** instead, and a value ≤0 makes Wallet reject the whole pass [S49]. Either way it can **only shrink** the radius.

### 8.2 How each style interprets relevance

The archived Table 4-2 [S33] is still mirrored by the current docs [S12]:

| Style | relevant date | locations | radius | Rule |
|---|---|---|---|---|
| boardingPass | Recommended | Optional | **large** | date **and** any location. Without a date, location alone |
| eventTicket | Recommended | Optional | **large** | date **and** any location. Without a location, date alone |
| generic | Optional | Required if any relevance is given | **small** | date **and** any location. Without a date, any location |
| coupon | **Not supported** | Required if any relevance is given | small | any location |
| storeCard | **Not supported** | Required if any relevance is given | small | any location |
| posterGeneric | UNVERIFIED (assume as generic) | as generic | small (100 m RE) | as generic (UNVERIFIED) |

Radius numbers. Apple: small is "on the order of a hundred meters or closer", large "on the order of a thousand meters", and "the exact relevance radius is an implementation detail and may change" [S33]. (RE) defaults are **100 m** for coupon, storeCard, generic and posterGeneric, and **1500 m** for eventTicket and boardingPass, **plus up to 100 m of position accuracy** [S49].

### 8.3 What the user actually sees, today

- Relevance is **passive**. It "doesn't present alerts or post notifications" [S33]. On iPhone the relevant pass appears on the Lock Screen as a suggestion (icon, organizationName, relevantText) that the user taps to open. On Apple Watch it appears in Notification Center [S33]. Apple DTS confirms that relevance updates are passive and that only `changeMessage` updates are delivered to the Lock Screen [S41]. Time-based relevance uses system-provided text. Location relevance uses your `relevantText` [S33].
- **It still works on iOS 18 through 27.** Evidence: Apple's iOS 27 iPhone User Guide documents **"Suggest on Lock Screen: The item automatically appears on the Lock Screen based on your time or location"** [S39]. The HIG (June 2026) still says "a gym membership card could appear on the Lock Screen as people enter the gym" [S29]. (RE) per-location `maxDistance` was field-tested on iOS 27.2 [S49]. A June 2025 forum report says "location messages on the Lock Screen do appear" [S42]. I found **no Apple announcement that removes or restricts location relevance** for generic, poster generic or store card passes. There was one unconfirmed iOS 18.0-beta report of missing location suggestions, contradicted by another tester in the same thread [S54].
- iOS 18+ event tickets (PET) with `relevantDates`, `locations` or `beacons` can start a Wallet **Live Activity** [S29][S48]. iOS 26 semantic boarding passes get a flight Live Activity (RE: about 4 h before departure) [S31][S53]. Generic, PG and store cards get **no** Live Activity.
- **User settings that gate it:**
  1. **Per pass**: Wallet > pass > ⋯/ⓘ > **Details** > **Suggest on Lock Screen** (iOS 27 wording). It only appears when the pass has relevance data [S39].
  2. **Location Services for Wallet**: Settings > Privacy & Security > Location Services > Wallet > *While Using the App*. Older Apple guides give the same path under "Privacy" [S40]. **Precise Location** is very likely needed for a 100 m radius (UNVERIFIED; third-party guidance only).
  3. Wallet notifications (Settings > Notifications > Wallet) and Lock Screen access for Wallet (Face ID & Passcode > Allow Access When Locked). The first is documented by Apple [S40]. Their exact effect on relevance suggestions is UNVERIFIED.
  4. Bluetooth for beacons.
  5. Expired or voided passes are hidden and should not surface (inferred from [S29]).
  6. Simulator never shows relevance. Test on a device [S12].
- No "always show" option exists, and iOS may decline to show a relevant pass [S57][S33]. Apple: "Don't try to manipulate the pass's presence on the lock screen by providing inaccurate relevance information" [S33].
- `relevantText` guidance: describe why the pass is relevant here ("Store nearby on 3rd and Main"). **Don't include your organization name** (it is already shown) and **don't include instructions** like "Redeem this pass at XYZ" [S33].

### 8.4 Henry's: what "show up automatically when close to a gym" can mean

Achievable on iOS 27 (posterGeneric) and on iOS 18–26 (generic fallback):
- The pass appears as a Lock Screen suggestion when the member is within about 100 m (plus GPS error) of a listed club. One `locations[]` entry per club the member may use, up to 10. A `relevantText` per club. This depends on the user's "Suggest on Lock Screen", Location Services and probably Precise Location. Nothing to configure server-side beyond the locations.

Not achievable:
- A larger radius. You can't raise the ~100 m default for generic or poster generic. Switching to `eventTicket` or `boardingPass` for the 1–1.5 km radius is misuse: it mis-states the pass, triggers event and date semantics, and risks auto-hiding.
- A guaranteed alert or sound on arrival. Relevance is passive. A changeMessage push is not location-triggered.
- Time-windowed relevance (for example during opening hours) for a generic pass. Adding `relevantDate(s)` to a generic pass makes it relevant **only when the date and a location both match** [S33], which would suppress the gym suggestion outside those windows. It also risks expiry/hiding behavior [S43].

Optional upgrades:
- **iBeacons** at each front desk (`beacons[]` with one UUID and per-club `major`) for reliable in-building triggering. Needs hardware and Bluetooth.
- **NFC (VAS)**, which presents the pass automatically when the phone is held at the reader. Needs the NFC entitlement and VAS-certified readers (§15). Not compatible with today's Code 39 key-tag workflow.

The recommended configuration is in §23.

---

## 9. Live Activities (system-generated, no pass.json "live activity" key)

- **PET (iOS 18+)**: Wallet starts a Live Activity around the event when relevance data is present (`relevantDates`; RE: also `locations` or `beacons`). It shows the seat and section color [S29][S48][S54]. (RE) `semantics.eventLiveMessage` sets its message [S54].
- **SBP (iOS 26+)**: a flight Live Activity driven by Apple's flight service (RE: about 4 h before departure) that can be shared through Messages. List your app in `associatedStoreIdentifiers` to suppress Wallet's own Live Activity when your app runs one [S31][S19][S53].
- Other styles, including PG: none documented.

---

## 10. Style-specific requirements (quick reference)

| Style or variant | Must have | Should have |
|---|---|---|
| boardingPass | `transitType` | `relevantDate(s)`, `groupingIdentifier` for multi-leg trips |
| SBP (iOS 26) | `preferredStyleSchemes` `["semanticBoardingPass","boardingPass"]`, `PKTransitTypeAir`, the 12 required semantics (§11.3), valid legacy fields | airline URLs, `primaryLogo`, `footer` |
| eventTicket | — | `relevantDate(s)`, `groupingIdentifier` |
| PET (iOS 18) | `preferredStyleSchemes` `["posterEventTicket","eventTicket"]`, required semantics (§11.3), `nfc` (docs; RE: barcode OK on iOS 27), artwork or background, valid legacy fields | `relevantDates`, event-guide URLs, `additionalInfoFields`, `secondaryLogo` |
| coupon, storeCard | — | `locations` (no date relevance) |
| generic | — | `locations` |
| posterGeneric (iOS 27) | a legacy style key for iOS ≤26 (Apple "recommends") | `primaryLogo`, `artwork`, ≤2 `featuredActions`, one `footerFields` |

---

## 11. Semantic tags

### 11.1 Where and why

`semantics` may sit at the pass root or inside any field. Placement doesn't change behavior [S15]. The system uses tags for suggestions. Documented examples: Siri Do Not Disturb for movies (`eventType=PKEventTypeMovie`, `silenceRequested`, `eventStartDate`, `eventEndDate`, `venueLocation`) [S15]; Maps directions, weather, Calendar and Siri Suggestions [S38][S32]; Apple Music for `artistIDs`, `albumIDs` and `playlistIDs` (priority playlist > album > artist, RE) [S54]; flight tracking from `airlineCode`, `flightNumber` and `originalDepartureDate` [S31]; badges on SBP [S31]. Tags are **required** for the PET and SBP layouts, and on those styles they drive the layout [S20][S19].

### 11.2 Complete documented list

From `SemanticTags` (104 keys) [S13], grouped. Types: `ls` = localizable string, `date` = ISO 8601 string. The **Since** column comes from Apple's per-property `introducedVersion`, which is reliable for semantics.

**Event / venue (eventTicket, PET, upcoming entries):**

| Key | Type | Since |
|---|---|---|
| eventType | enum `PKEventTypeGeneric`, `PKEventTypeLivePerformance`, `PKEventTypeMovie`, `PKEventTypeSports`, `PKEventTypeConference`, `PKEventTypeConvention`, `PKEventTypeWorkshop`, `PKEventTypeSocialGathering` | 12 |
| eventName, genre, venueName, venueRoom, venueEntrance, venuePhoneNumber | ls | 12 |
| eventStartDate, eventEndDate | date | 12 |
| eventStartDateInfo | EventDateInfo | 12 (object 18) |
| duration | number (s) | 12 |
| venueLocation | Location | 12 |
| performerNames, artistIDs | [ls] | 12 |
| silenceRequested | bool | 12 |
| awayTeamAbbreviation, awayTeamLocation, awayTeamName, homeTeamAbbreviation, homeTeamLocation, homeTeamName, leagueAbbreviation, leagueName, sportName | ls | 12 |
| additionalTicketAttributes, admissionLevel, admissionLevelAbbreviation, attendeeName, entranceDescription, venueEntranceDoor, venueEntranceGate, venueEntrancePortal, venueRegionName | ls | 18 |
| albumIDs, playlistIDs | [ls] | 18 |
| venueBoxOfficeOpenDate, venueCloseDate, venueDoorsOpenDate, venueFanZoneOpenDate, venueGatesOpenDate, venueOpenDate, venueParkingLotsOpenDate | date | 18 |
| tailgatingAllowed | bool | 18 |

**Transit / boarding (boardingPass, SBP):**

| Key | Type | Since |
|---|---|---|
| airlineCode, flightCode | ls | 12 |
| flightNumber | number | 12 |
| boardingGroup, boardingSequenceNumber, carNumber, confirmationNumber, departureAirportCode, departureAirportName, departureGate, departureLocationDescription, departurePlatform, departureStationName, departureTerminal, destinationAirportCode, destinationAirportName, destinationGate, destinationLocationDescription, destinationPlatform, destinationStationName, destinationTerminal, membershipProgramName, membershipProgramNumber, membershipProgramStatus, priorityStatus, securityScreening, transitProvider, transitStatus, transitStatusReason, vehicleName, vehicleNumber, vehicleType | ls | 12 |
| original/current Arrival, Boarding and Departure Date (6 keys) | date | 12 |
| departureLocation, destinationLocation | Location | 12 |
| passengerName | PersonNameComponents | 12 |
| boardingZone, departureCityName, destinationCityName, ticketFareClass, internationalDocumentsVerifiedDeclarationName | ls | 26 |
| departureLocationTimeZone, destinationLocationTimeZone | IANA tz string | 26 |
| departureLocationSecurityPrograms, destinationLocationSecurityPrograms, passengerEligibleSecurityPrograms | [enum `PKTransitSecurityProgram{TSAPreCheck, TSAPreCheckTouchlessID, OSS, ITI, ITD, GlobalEntry, CLEAR}`] | 26 |
| passengerCapabilities | [enum `PKPassengerCapability{Preboarding, PriorityBoarding, Carryon, PersonalItem, LapInfant}`] | 26 |
| passengerAirlineSSRs, passengerInformationSSRs (`INFT`), passengerServiceSSRs (`PETC`, `SVAN`, `UMNR`, `WCBD`, `WCBW`, `WCHC`, `WCHR`, `WCHS`, `WCLB`, `WCMP`, `WCOB`) | [string] | 26 |
| internationalDocumentsAreVerified | bool | 26 |
| loungePlaceIDs | [MapKit Place ID] | 26 |

**Any pass / store card:**

| Key | Type | Since |
|---|---|---|
| seats | [Seat] (boarding and event) | 12 |
| totalPrice | CurrencyAmount (any pass) | 12 |
| balance | CurrencyAmount (**storeCard only**) | 12 |
| wifiAccess | [WifiNetwork] (**any pass type**) | 12 |

**Semantic data types** (`SemanticTagType`) [S14]:

| Type | Fields |
|---|---|
| CurrencyAmount | `amount` (string), `currencyCode` |
| EventDateInfo (18) | `date`, `ignoreTimeComponents`, `timeZone`, `unannounced`, `undetermined` (18.1) |
| Location | `latitude`, `longitude` (both required) |
| PersonNameComponents | `familyName`, `givenName`, `middleName`, `namePrefix`, `nameSuffix`, `nickname`, `phoneticRepresentation` |
| Seat | `seatDescription`, `seatIdentifier`, `seatNumber`, `seatRow`, `seatSection`, `seatType` (12); `seatAisle`, `seatLevel`, `seatSectionColor` (rgb) (18) |
| WifiNetwork | `ssid` and `password` (required); `captiveToken`, `captiveTokenAuthURL` |

### 11.3 Required sets

- **PET** needs `preferredStyleSchemes` containing `posterEventTicket`, plus `eventName`, `venueName`, `venueRegionName` and `venueRoom`. Sports also need `homeTeamAbbreviation` and `awayTeamAbbreviation`. Live performance also needs `performerNames`. Recommended: `eventStartDate` / `eventStartDateInfo`. Legacy fields must still be valid or ingestion fails on every device [S20].
- **SBP** needs `preferredStyleSchemes` `["semanticBoardingPass","boardingPass"]`, `transitType: PKTransitTypeAir`, and `airlineCode`, `flightNumber`, `departureAirportCode`, `departureCityName`, `departureLocationTimeZone`, `destinationAirportCode`, `destinationCityName`, `destinationLocationTimeZone`, `originalArrivalDate`, `originalBoardingDate`, `originalDepartureDate`, `passengerName`. Missing any of them falls back to the legacy layout [S19]. NFC is not required [S53].

### 11.4 Undocumented and conflicting semantic names (an engine should accept both forms)

| Documented | Alternate seen | Evidence |
|---|---|---|
| `departureLocationTimeZone` / `destinationLocationTimeZone` | `departureAirportTimeZone` / `destinationAirportTimeZone` | Pass Builder emits the "Airport" names [S37]. (RE) iOS 26 `passd` accepts both [S53]. Real United passes use the "Location" names [S60]. |
| `departure/destinationLocationSecurityPrograms` | `departure/destinationAirportSecurityPrograms` | Pass Builder [S37] |
| `loungePlaceIDs` ([string]) | `airlineLoungePlaceID` (string) | WWDC25 narration and Pass Builder [S31][S37] |
| — | `venuePlaceID` (string) | WWDC25 narration for upcoming events [S31]. Absent from the `SemanticTags` page. |
| — | `eventLiveMessage` (string, message in the Live Activity) | (RE) [S54][S48] |
| — | `airplay: [{airPlayDeviceGroupToken}]` | (RE) [S54][S48] |

---

## 12. Images

PNG files with `@2x` and `@3x` variants (the HIG says "PNG format in @2x and @3x"). `@1x` is optional on modern devices. Point sizes come from the HIG (2026-06-08) unless noted. Pixel sizes are the pt size multiplied by the scale [S29]. Pass Builder also recognizes `.pdf` image files [S37]. Wallet support for PDF images is UNVERIFIED.

| File | Styles | Size (pt) | @2x px | @3x px | Required? | Since |
|---|---|---|---|---|---|---|
| `icon.png` | **all** (Lock Screen, notifications, Mail) | 38×38 (archive: 29×29) | 76×76 | 114×114 | **Required** (Pass Builder errors without one) [S22][S37] | 6 |
| `logo.png` | legacy boarding, coupon, legacy event, generic, storeCard; PG fallback | h 50, w 50–160 | ≤320×100 | ≤480×150 | optional | 6 |
| `primaryLogo.png` | SBP (26), PET (18), **PG (27)** | h 30, w 30–126 | ≤252×60 | ≤378×90 | optional (also ship `logo` for older OS) [S18][S51] | 18 |
| `secondaryLogo.png` | PET (bottom trailing) | h 12, w 12–135 | ≤270×24 | ≤405×36 | optional | 18 |
| `strip.png` | coupon, storeCard: 375×144. Legacy eventTicket: 375×98 (archive) | 375×144 | 750×288 | 1125×432 | optional | 6 |
| `thumbnail.png` | legacy eventTicket, generic | h 90, w 60–90 (aspect 2:3–3:2) | ≤180×180 | ≤270×270 | optional | 6 |
| `background.png` | legacy eventTicket (blurred); PET alternative (same background on all OS); WWDC26 sets it on a PG pass | 343×503 HIG (Pass Designer/Pass Builder: **345×505**) | 690×1010 | 1035×1515 | optional | 6 |
| `artwork.png` | **PET (18), PG (27)**, unblurred poster art | 358×448 | 716×896 | 1074×1344 | Pass Builder errors on PET without artwork or background [S37]. PG: UNVERIFIED | 18 |
| `footer.png` | boarding pass (archive: all; HIG: airline only) | 268×15 HIG (archive and Pass Builder: 286×15) | 536×30 | 804×45 | optional | 6 |
| `personalizationLogo.png` | personalizable passes (signup sheet) | 150×40 | 300×80 | 450×120 | required for personalization | 10 |
| `venueMap.png` | PET event guide | unknown | ? | ? | **Undocumented (RE)** [S54] | 18 |
| Remote images | `upcomingPassInformation[].images.headerImage` and `venueMap` via `URLs[]` | — | per `scale` | per `scale` | HTTPS, `SHA256`, `size` ≤ **2 MB** [S27] | 26 |

Other image rules: the strip conflicts with background and thumbnail on legacy event tickets [S33]. Localized images go in `.lproj`, and a top-level image of the same name **overrides** localized ones [S22]. watchOS crops white space and drops the strip and thumbnail [S29]. Keep files small [S29]. (Forum report, iOS 18) the notification icon is drawn on a white background, so design `icon.png` with its own opaque background (UNVERIFIED by Apple).

---

## 13. Localization

- Folders: `<language>[-<region>].lproj` (for example `en.lproj`, `zh-Hans.lproj`, `pt_BR`, `es-419` (RE fix in passkit-generator 3.7)) [S22][S55].
- `pass.strings` per folder. Each folder must have the same keys and count. Apple says "Use UTF-16 encoding for non-ASCII characters" [S22]. UTF-8 is widely used (UNVERIFIED as officially supported).
- Localizable values: `description`, `organizationName`, `logoText`, `eventLogoText`, field `label`, `value`, `attributedValue` and `changeMessage`, semantic `ls` values, and upcoming-entry `name` [S2][S4][S13].
- Dates, times and currencies in properly formatted values are localized automatically, even without `.lproj` [S22].
- Localized images may not update after the pass is added [S22].

---

## 14. Featured actions (iOS 27)

Root `featuredActions: [Action]`, **max 2**, in priority order. Wallet draws a card with an SF Symbol and a localized call to action [S30][S17][S16].

| Action key | Type | Rules |
|---|---|---|
| `identifier` | string | Required, unique |
| `type` | string | Required. One of the types below. |
| `url` | string | Required for every type except `place`. For `call`, use a `tel:` URL (RE) [S52][S48] |
| `placeIdentifier` | string (Apple Maps Place ID) | **Required for `place`**, and replaces `url`. Not in Apple's docs or Pass Builder's model. Verified with Pass Designer and an iOS 27 device: a `place` action with a `url` is shown as broken [S52]. Pass Designer itself emits it (see this repo's template). |

| `type` | Purpose (Apple) | Category |
|---|---|---|
| `viewSchedule` | event schedule | Events |
| `watchTrailer` | trailer | Events |
| `listenToMusic` | playlist | Events |
| `call` | phone call | Generic |
| `place` | open Maps to one place | Generic |
| `addToBalance` | load balance | Membership |
| `order` | delivery or pickup | Membership |
| `shop` | e-commerce | Membership |
| `membershipBenefits` | membership benefits, points, tiers | Membership |
| `bookAppointment` | reserve a time slot | Membership |
| `bookCar` | car rental | Membership |
| `bookFlight` | flight booking | Membership |
| `bookStay` | hotel stay | Membership |
| `viewOffersRewards` | offers and rewards | Membership, Generic, Event |

Source: [S17]. The WWDC26 code sample uses `"viewMembership"`, which is not in Apple's list [S30], so treat Apple's list as canonical. Featured actions render on all classic styles and PG, but **not** on PET or SBP (RE) [S51].

---

## 15. NFC (Value Added Services)

`nfc` dictionary [S10][S36]:

| Key | Type | Rules |
|---|---|---|
| `message` | string | **Required**, ≤64 bytes (truncated beyond) |
| `encryptionPublicKey` | string | Required (doc). Base64 X.509 SubjectPublicKeyInfo, ECDH P-256 (body only, no PEM header) [S37] |
| `requiresAuthentication` | bool | iOS 13.1+. Requires Face ID or Touch ID per use. Pair with `sharingProhibited: true` [S10] |

Requirements:
- A Pass Type ID **with NFC** certificate. NFC is "a special entitlement issued by Apple" [S10][S44], and the request goes through Apple [S46].
- VAS-certified terminals or readers and POS support [S46].
- The archive (2017) said NFC was storeCard-only [S36]. Today NFC is also used on event tickets (PET in iOS 18 required it) [S32].
- Rewards enrollment (personalization) is **only** for NFC-enabled reward cards [S35].
- Pass Builder's PET validator also requires `nfc.requiresAuthentication` to be present [S37].

---

## 16. Personalization (rewards enrollment)

- The bundle adds **`personalization.json`** and **`personalizationLogo*.png`** (150×40 pt) [S35].
- `personalization.json` (`Personalize`) [S28]:
  - `requiredPersonalizationFields` (required): one or more of `PKPassPersonalizationFieldName`, `PKPassPersonalizationFieldPostalCode`, `PKPassPersonalizationFieldEmailAddress`, `PKPassPersonalizationFieldPhoneNumber`.
  - `description` (required).
  - `termsAndConditions` (optional, may contain links).
- Flow [S35][S26]:
  1. The user fills the signup sheet.
  2. Wallet sends `POST {webServiceURL}/v1/passes/{passTypeIdentifier}/{serialNumber}/personalize` with a `PersonalizationDictionary`: `personalizationToken` plus `requiredPersonalizationInfo{fullName, givenName, familyName, emailAddress, phoneNumber, postalCode, ISOCountryCode}`.
  3. The server returns **200 `application/octet-stream`**: the token signed with the pass certificate (PKCS#7 detached).
  4. Wallet verifies it (failures go to `/v1/log`).
  5. Wallet `GET`s the pass. The personalized pass **must not** contain `personalization.json`.
  6. If the user skips signup, a "Sign Up" button stays on the back of the pass.

---

## 17. Multi-event passes: `upcomingPassInformation` (iOS 26, PET)

Entry (`UpcomingPassInformationEntry`) [S27][S31]:

| Key | Type | Rules |
|---|---|---|
| `identifier` | string | Required, unique |
| `name` | ls | Required |
| `type` | `"event"` | Required. The only value. |
| `dateInformation` | `{date, ignoreTimeComponents, isAllDay, isUnannounced, isUndetermined, timeZone}` | Omitted means TBD. `date` is optional (passkit-generator 3.7 fix) [S55] |
| `isActive` | bool | Default false. Update it at event start and end [S31]. |
| `semantics` | SemanticTags | `venueName`, `venuePlaceID`, `venueLocation`, `seats`, … |
| `additionalInfoFields`, `backFields` | [Field] | (RE) at least one `backFields` entry is needed for the event detail view [S53][S55] |
| `URLs` | the 14 event-guide URL keys (§3.10) | Not inherited from the pass |
| `images.headerImage`, `images.venueMap` | `{URLs:[{URL(https), SHA256, scale(default 1), size(≤2 MB)}], reuseExisting}` | No `venueMap` unless URLs are given or `reuseExisting: true` [S31] |
| `auxiliaryStoreIdentifiers` | [number] | event guide apps |

Pass Builder spells these keys `urls`, `url` and `sha256` (lowercase) [S37]. That contradicts Apple's docs and passkit-generator (`URLs`, `URL`, `SHA256`). Emit Apple's casing.

---

## 18. Distribution and app-side APIs (outside pass.json, but part of "supports everything")

- **Web**: serve `.pkpass` as `application/vnd.apple.pkpass` and `.pkpasses` as `application/vnd.apple.pkpasses`. Use the Add to Apple Wallet badge [S24].
- **Email** attachment. **App or App Clip**: `PKAddPassButton` and `PKAddPassesViewController`, or `PKPassLibrary.addPasses`.
- **iOS 26: `PKPassLibrary.requestAuthorization(for: .backgroundAddPasses)`** is a one-time prompt. After that, `addPasses` adds passes silently and Wallet posts a notification [S24][S31].
- Passes sync through iCloud to all of the user's devices [S45].
- Wallet Orders (order tracking) is a separate format (`.order`) and out of scope here [S29].

---

## 19. Signing and certificates

- A **Pass Type ID certificate** per `passTypeIdentifier`, made from a CSR in Certificates, Identifiers & Profiles [S23].
- It chains to the **WWDR G4** intermediate. G4 covers "Pass Type ID, Pass Type ID with NFC, APNs …". The old WWDR intermediate expired on 2023-02-07 [S44].
- If the certificate expires, installed passes keep working, but you can't sign new passes or **send updates**. If it is revoked, passes stop working [S45].
- The manifest uses SHA-1 (§2). Don't put the private key on the public web server (archive best practice) [S34].

---

## 20. Web service (pass updates)

The base is `webServiceURL` followed by `v1/…`. HTTPS is required in production [S25][S26]:

| Endpoint | Method and path | Auth | Body / query | Responses |
|---|---|---|---|---|
| Register | `POST /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}/{serialNumber}` | `Authorization: ApplePass <authenticationToken>` | `{"pushToken":"…"}` | **201** registered, **200** already registered, **401** |
| Serials changed | `GET /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}?passesUpdatedSince={lastUpdated}` | none (the device library ID is the shared secret) | query omitted on first call (archive) | **200** `{"serialNumbers":[…],"lastUpdated":"…"}`, **204** none |
| Latest pass | `GET /v1/passes/{passTypeIdentifier}/{serialNumber}` | ApplePass token | `If-Modified-Since` | **200** `application/vnd.apple.pkpass` (send `Last-Modified`), **304** not modified (archive), **401** |
| Unregister | `DELETE /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}/{serialNumber}` | ApplePass token | — | **200**, **401** |
| Log | `POST /v1/log` | none | `{"logs":["…"]}` | **200** |
| Personalize | `POST /v1/passes/{passTypeIdentifier}/{serialNumber}/personalize` | — | PersonalizationDictionary | **200** `application/octet-stream` (signed token) |

Notes:
- `lastUpdated` is an opaque, monotonically comparable tag [S34].
- Return **all** registered serials when no tag is given [S34].
- Remove a device when its last registration goes [S25].
- (Field report) ignoring `If-Modified-Since` triggers device log warnings [S56].
- Statuses other than these are undocumented.

---

## 21. APNs for passes

- **Protocol**: HTTP/2 Provider API only. The legacy binary interface "is no longer functional" (DTS, 2025) [S42].
- **Environment**: **production only**. "The sandbox environment will not deliver notifications of this type" [S41][S25].
- **Auth**:
  - **Certificate** (the same Pass Type ID certificate and key used for signing) [S25][S34]. Topic: "only provided if the certificate is configured to support multiple APNs-based capabilities". For a PassKit-only certificate it can be omitted [S41].
  - **Token (JWT, `.p8`)**: "use the Pass Type ID as the push notification topic" (DTS) [S41].
- **Payload**: an **empty JSON dictionary** `{}`. No alert, because Wallet shows nothing from the payload [S25][S41].
- **Device token**: the `pushToken` from registration.
- **Headers**: not specified by Apple for passes. Common practice is `apns-push-type: background` with `apns-priority: 5`. Background pushes must use priority 5 [S47][S56]. Treat this as convention.
- **Errors**: delete the device when APNs reports an invalid token [S25][S41].
- **Coalescing**: APNs coalesces multiple pushes. That is why the payload is empty and the device asks for serials changed since a tag [S34].

---

## 22. Update notifications and `changeMessage`

- After a push or pull-to-refresh, the device fetches the changed serials, then each pass. It **compares the new pass with its own stored copy**, field by field. For each changed field that has `changeMessage`, it shows the message with `%@` replaced by the new value [S34][S56]. These notifications appear on the Lock Screen [S41]. Without a `changeMessage`, the user isn't notified [S36].
- (RE, iOS 27) Adding a field without a `changeMessage` can produce a generic "Pass changed" notification. Removing a field or changing a value without one notifies nothing [S56].
- Use change messages only for time-critical information, "never … for marketing" (HIG) [S29][S34].
- **Rate limits and throttling are not documented by Apple.** Field reports:
  - Wallet stops fetching after bursts of pushes [S58].
  - iOS 27 warned users and disabled automatic updates for an issuer after a run of pushes that didn't change the pass (RE) [S56].
  - iOS Developer settings have a PassKit testing switch to disable rate limiting (third-party report) [S59].
  - Vendor numbers such as "20 per day" are unsourced.
- **Push only on real content changes.**
- Users can switch off **Automatic Updates** per pass (iOS pass Details).
- `changeMessage` isn't used on watchOS [S4].

---

## 23. Recommended feature set for Henry's Gymnasium

Context: `templates/henrys.pkpasstemplate/pass.json`, which is now at `templates/henrys-copper/` in the working tree, plus `src/templates/henrys.ts` and `henrys-clubs.ts`. The template has two clubs about **2.6 km apart** (Capitol Hill 47.615835,−122.323555; Queen Anne 47.624765,−122.356206), so their 100 m relevance circles never overlap. It uses a Code 39 key-tag barcode. Members have home-club or all-club access. The member portal is `henrysgymnasium.thememberspot.com`.

### 23.1 Use

| Feature | Recommendation | Why |
|---|---|---|
| Style | **`posterGeneric` + `generic` fallback** (as now) | PG is Apple's membership-card style on iOS 27. `generic` covers iOS ≤26 and watchOS ≤26 [S16][S30]. `storeCard` suits balances or points, which this pass doesn't have. `eventTicket` or `boardingPass` would mis-state the pass. |
| `locations` | One entry per club the member can use (home club only, or both). This is what `customize()` already does. | Lock Screen suggestion within about 100 m [S33][S49] |
| `relevantText` | Short "why here" text **without the org name or instructions**, for example `"Capitol Hill club · 1617 Boylston Ave"` | The archive guidance [S33]. The current text "Your Henry's Gymnasium membership — Capitol Hill" repeats `organizationName`. |
| `maxDistance` | **Remove the root `maxDistance: 150`.** It can't raise the 100 m default, and it is reportedly ignored anyway [S2][S49]. Don't add per-location `maxDistance` unless you want a *smaller* zone. | No benefit, and it adds confusion |
| `relevantDate(s)` | **Don't set** | For generic passes it ANDs with location and kills gym suggestions outside the window. It also risks auto-hiding [S33][S43]. |
| `beacons` | Optional, only if the gym installs iBeacons (one UUID, `major` 1 and 2 per club) | Front-desk precision. Needs hardware. |
| `barcodes` | `Code39` first, then `Code128` fallback, same `message` and `altText` (as now). Confirm that the scanner has Code 128 enabled, and test whether the Code 39 `message` needs the check digit or `*`. | iOS ≤26 can't render Code 39 [S30]. Code 128 isn't shown on watchOS, and Code 39 on watchOS is UNVERIFIED, so the Watch may show no barcode. The member ID is already in a header field, which is WWDC26's recommended mitigation. |
| `featuredActions` | (1) `membershipBenefits` → the portal. (2) `place` with **`placeIdentifier`** of the home club (as now). Alternative for (2): `bookAppointment`, if the portal books classes or training. | Max 2. `place` needs `placeIdentifier` [S17][S52]. |
| `webServiceURL` + `authenticationToken` (≥16 chars) | **Required** for status changes, expiry and messages | Updates and `changeMessage` [S25][S36] |
| `changeMessage` | On **one** status field only (`"Your membership status is now %@."`). Keep the `%@` "message" field for operational notices (club closures, holiday hours), not marketing. Never on fields that have `attributedValue`. | HIG [S29]. Raw-markup issue [S56]. |
| Expiry | Set `expirationDate` when a membership ends. Set `voided: true` when it is cancelled. Send both with a status update. | Wallet hides expired and voided passes [S29] |
| Back fields | Keep contact info for the issuer and the signer (required by guidelines) [S21], the portal, per-club address and phone, and terms. **Make keys unique within each style dict**: `generic` currently repeats `memberId` (auxiliary and back) and `status` (header and back). Rename the back copies, for example `memberId-back` and `status-back`. Use `dataDetectorTypes: ["PKDataDetectorTypePhoneNumber"]` on phone fields. | Key-uniqueness rule [S36] |
| Images | `icon` (38 pt, opaque background), `primaryLogo` (PG), `logo` (generic fallback), `artwork` 358×448 pt (PG). Optional `thumbnail` 90×90 pt for generic. **Test whether `background.png` (≈2.9 MB across scales) is used at all** when `artwork` exists. Generic never renders it. | HIG image matrix [S29] |
| `sharingProhibited: true` | Keep | Membership is personal. It doesn't prevent screenshots [S2]. |
| `description` / `organizationName` | Keep. `organizationName` is what the Lock Screen shows. | [S33] |
| Semantics | Optional: `wifiAccess` **only if** a member Wi-Fi exists. Don't invent event or flight semantics. | `wifiAccess` is "for any pass" [S13]. Other tags don't apply to memberships. |
| `associatedStoreIdentifiers` | Add only if Henry's or MemberSpot ships an iOS app | App link and icon tap [S2] |

### 23.2 Don't use (and why)

- `eventTicket` or `boardingPass` styles (wrong semantics, date-driven hiding), `relevantDates`, `groupingIdentifier` (event and boarding only).
- PET or SBP keys, the event-guide URLs, `upcomingPassInformation` (PET only), `footerBackgroundColor` and `useAutomaticColors` (documented for PET only).
- `nfc` and personalization: they need the NFC entitlement and VAS readers, and they don't fit the key-tag barcode check-in.
- `strip` (coupon and store card only), `secondaryLogo` (PET), `footer` (boarding pass).
- Undocumented `sharing`, `stripColor`, `logoSymbolName`: no benefit here, and they are UNVERIFIED.

### 23.3 Snippets

All-club member (relevance block). Remove the root `maxDistance` and don't add `relevantDate(s)`:

```json
"locations": [
  { "latitude": 47.615835, "longitude": -122.323555,
    "relevantText": "Capitol Hill club · 1617 Boylston Ave" },
  { "latitude": 47.624765, "longitude": -122.356206,
    "relevantText": "Queen Anne club · 14 Mercer St" }
]
```

Home-club-only member: the same block with just the home-club entry. Put each point at the member entrance, not the parcel centroid, because the radius is only about 100 m. A second point per club, for example a parking-garage entrance members use, is legitimate (up to 10 total).

Optional beacon relevance, if hardware is installed. The UUID below is a placeholder:

```json
"beacons": [
  { "proximityUUID": "00000000-0000-0000-0000-000000000000", "major": 1,
    "relevantText": "Capitol Hill front desk" },
  { "proximityUUID": "00000000-0000-0000-0000-000000000000", "major": 2,
    "relevantText": "Queen Anne front desk" }
]
```

Web service and lifecycle:

```json
"webServiceURL": "https://<pass-service-host>/",
"authenticationToken": "<≥16 random chars, never rotated>",
"expirationDate": "2027-01-31T23:59-08:00",
"voided": false
```

Barcodes:

```json
"barcodes": [
  { "format": "PKBarcodeFormatCode39",  "message": "DEMO0001", "messageEncoding": "iso-8859-1", "altText": "DEMO0001" },
  { "format": "PKBarcodeFormatCode128", "message": "DEMO0001", "messageEncoding": "iso-8859-1", "altText": "DEMO0001" }
]
```

Featured actions (iOS 27):

```json
"featuredActions": [
  { "identifier": "member-portal", "type": "membershipBenefits",
    "url": "https://henrysgymnasium.thememberspot.com/signin" },
  { "identifier": "home-club", "type": "place", "placeIdentifier": "I23C636C7300F20FD" }
]
```

`posterGeneric` face (iOS 27). The first primary field has no label, which gives the bold name title. Only one footer field is shown:

```json
"posterGeneric": {
  "headerFields":  [ { "key": "memberId", "label": "MEMBER", "value": "DEMO0001" } ],
  "primaryFields": [ { "key": "memberName", "value": "Alex Morgan" },
                     { "key": "homeClub", "label": "HOME CLUB", "value": "Capitol Hill" } ],
  "footerFields":  [ { "key": "membership", "value": "All-Inclusive Wellness" } ],
  "backFields": [
    { "key": "status-back", "label": "MEMBERSHIP STATUS", "value": "Active",
      "changeMessage": "Your membership status is now %@." },
    { "key": "message", "label": "FROM HENRY’S", "value": "Welcome to Henry’s.", "changeMessage": "%@" },
    { "key": "phone", "label": "CONTACT THE GYM", "value": "(206) 644-7797",
      "dataDetectorTypes": ["PKDataDetectorTypePhoneNumber"] },
    { "key": "portal", "label": "MANAGE YOUR MEMBERSHIP",
      "attributedValue": "<a href=\"https://henrysgymnasium.thememberspot.com/signin\">Member portal</a>",
      "value": "https://henrysgymnasium.thememberspot.com/signin" }
  ]
}
```

`generic` fallback (iOS ≤26). Keys are unique inside the dict, and `changeMessage` is on the front status field only:

```json
"generic": {
  "headerFields":    [ { "key": "status", "label": "STATUS", "value": "Active",
                         "changeMessage": "Your membership status is now %@." } ],
  "primaryFields":   [ { "key": "memberName", "label": "MEMBER", "value": "Alex Morgan" } ],
  "secondaryFields": [ { "key": "membership", "label": "MEMBERSHIP", "value": "All-Inclusive Wellness" },
                       { "key": "homeClub", "label": "HOME CLUB", "value": "Capitol Hill" } ],
  "auxiliaryFields": [ { "key": "memberId", "label": "MEMBER NUMBER", "value": "DEMO0001" } ],
  "backFields":      [ { "key": "message", "label": "FROM HENRY’S", "value": "Welcome to Henry’s.", "changeMessage": "%@" } ]
}
```

Optional semantics, only if a real member network exists:

```json
"semantics": { "wifiAccess": [ { "ssid": "Henrys-Members", "password": "<password>" } ] }
```

### 23.4 Expected behavior to tell the owner

On iPhone, iOS 27 shows the poster pass and iOS 18–26 shows the generic pass. When a member is within about 100 m of a club they can use, Wallet *may* place the pass on the Lock Screen with the icon, "Henry's Gymnasium" and the club's `relevantText`. One tap opens the barcode. There is no sound and no guarantee. It works only if the member keeps "Suggest on Lock Screen" on (the default) and allows Wallet Location Services (Precise location recommended). Status, expiry and broadcast changes arrive as Lock Screen notifications through `changeMessage` after a push. Apple Watch mirrors the relevance suggestion in Notification Center, but it may show no barcode because of the Code 39/128 limits.

---

## 24. Sources

Apple, primary:
- [S1] Wallet Passes: https://developer.apple.com/documentation/walletpasses (JSON: https://developer.apple.com/tutorials/data/documentation/walletpasses.json)
- [S2] `Pass`: https://developer.apple.com/documentation/walletpasses/pass
- [S3] `PassFields` and subpages: https://developer.apple.com/documentation/walletpasses/passfields
- [S4] `PassFieldContent`: https://developer.apple.com/documentation/walletpasses/passfieldcontent
- [S5] `Pass.Barcodes`: https://developer.apple.com/documentation/walletpasses/pass/barcodes-data.dictionary
- [S6] `Pass.Barcode` (deprecated): https://developer.apple.com/documentation/walletpasses/pass/barcode-data.dictionary
- [S7] `Pass.Locations`: https://developer.apple.com/documentation/walletpasses/pass/locations-data.dictionary
- [S8] `Pass.Beacons`: https://developer.apple.com/documentation/walletpasses/pass/beacons-data.dictionary
- [S9] `Pass.RelevantDates`: https://developer.apple.com/documentation/walletpasses/pass/relevantdates-data.dictionary
- [S10] `Pass.NFC`: https://developer.apple.com/documentation/walletpasses/pass/nfc-data.dictionary
- [S11] `Pass.BoardingPass`: https://developer.apple.com/documentation/walletpasses/pass/boardingpass-data.dictionary
- [S12] Showing a Pass on the Lock Screen: https://developer.apple.com/documentation/walletpasses/showing-a-pass-on-the-lock-screen
- [S13] `SemanticTags`: https://developer.apple.com/documentation/walletpasses/semantictags
- [S14] `SemanticTagType`: https://developer.apple.com/documentation/walletpasses/semantictagtype
- [S15] Supporting semantic tags: https://developer.apple.com/documentation/walletpasses/supporting-semantic-tags-in-wallet-passes
- [S16] Creating a Poster Generic Pass: https://developer.apple.com/documentation/walletpasses/creating-a-poster-generic-pass
- [S17] Defining the metadata of your Wallet Pass (featured actions table): https://developer.apple.com/documentation/walletpasses/defining-the-metadata-of-your-wallet-pass
- [S18] Creating a pass with Pass Designer: https://developer.apple.com/documentation/walletpasses/creating-a-pass-with-pass-designer
- [S19] Creating an airline boarding pass using semantic tags: https://developer.apple.com/documentation/walletpasses/creating-an-airline-boarding-pass-using-semantic-tags
- [S20] Creating a poster event pass using semantic tags: https://developer.apple.com/documentation/walletpasses/creating-an-event-pass-using-semantic-tags
- [S21] Creating a coupon pass / store card pass: https://developer.apple.com/documentation/walletpasses/creating-a-coupon-pass, https://developer.apple.com/documentation/walletpasses/creating-a-store-card-pass
- [S22] Creating the Source for a Pass: https://developer.apple.com/documentation/walletpasses/creating-the-source-for-a-pass
- [S23] Building a Pass: https://developer.apple.com/documentation/walletpasses/building-a-pass
- [S24] Distributing and updating a pass: https://developer.apple.com/documentation/walletpasses/distributing-and-updating-a-pass
- [S25] Adding a Web Service to Update Passes: https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes
- [S26] Endpoints: …/register-a-pass-for-update-notifications, …/get-the-list-of-updatable-passes, …/send-an-updated-pass, …/unregister-a-pass-for-update-notifications, …/log-a-message, …/return-a-personalized-pass (under https://developer.apple.com/documentation/walletpasses/)
- [S27] `UpcomingPassInformationEntry`: https://developer.apple.com/documentation/walletpasses/upcomingpassinformationentry
- [S28] `Personalize` / `PersonalizationDictionary`: https://developer.apple.com/documentation/walletpasses/personalize, https://developer.apple.com/documentation/walletpasses/personalizationdictionary
- [S29] HIG Wallet (updated 2026-06-08 for iOS 27): https://developer.apple.com/design/human-interface-guidelines/wallet
- [S30] WWDC26 "What's new in Wallet" (209): https://developer.apple.com/videos/play/wwdc2026/209/
- [S31] WWDC25 "What's new in Wallet" (202): https://developer.apple.com/videos/play/wwdc2025/202/
- [S32] WWDC24 "What's new in Wallet and Apple Pay" (10108): https://developer.apple.com/videos/play/wwdc2024/10108/
- [S33] Archived Wallet Developer Guide, Pass Design and Creation: https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html
- [S34] Archived, Updating a Pass: https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Updating.html
- [S35] Archived, Pass Personalization: https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/PassPersonalization.html
- [S36] Archived PassKit Package Format Reference (via Wayback): https://web.archive.org/web/2020/https://developer.apple.com/library/archive/documentation/UserExperience/Reference/PassKit_Bundle/Chapters/TopLevel.html (also `FieldDictionary.html`, `LowerLevel.html`)
- [S37] Apple Pass Builder (main @ 6138535, 2026-10-22): https://github.com/apple/pass-builder
- [S38] Pass Designer: https://developer.apple.com/pass-designer/
- [S39] Apple Support, iOS 27 "Use passes, cards, and keys in Wallet on iPhone": https://support.apple.com/guide/iphone/use-passes-cards-and-keys-iphe7aa3336/ios
- [S40] Apple Support, older settings path (iOS 14 guide): https://support.apple.com/en-asia/guide/iphone/iphe7aa3336/14.0/ios
- [S41] Apple Developer Forums (DTS), pass push topic, payload, production only: https://developer.apple.com/forums/thread/758991
- [S42] Apple Developer Forums (DTS), legacy binary APNs dead: https://developer.apple.com/forums/thread/789547
- [S43] Apple Developer Forums, passes hidden after relevantDate: https://developer.apple.com/forums/thread/708761
- [S44] WWDR intermediate certificates: https://developer.apple.com/support/expiration/, https://developer.apple.com/help/account/certificates/wwdr-intermediate-certificates
- [S45] Get started with Apple Wallet: https://developer.apple.com/wallet/get-started/
- [S46] Loyalty and membership passes (NFC/VAS): https://developer.apple.com/wallet/loyalty-passes/
- [S47] APNs, Sending notification requests: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns

Third-party (reverse engineering and field tests; treat as **(RE)**):
- [S48] passkit-generator (v3.7.0, 2026-10-15, plus later commits): https://github.com/alexandercerutti/passkit-generator
- [S49] Commit a5af6ed, "root maxDistance never read; per-location maxDistance; defaults 100 m / 1500 m" (tested iOS 27.2): https://github.com/alexandercerutti/passkit-generator/commit/a5af6ede520d171b231c4c04b0b70f92c010a741
- [S50] Commit 0390523, undocumented `sharing`: https://github.com/alexandercerutti/passkit-generator/commit/0390523b5228a28f23fbd52964b842d8149abfa3
- [S51] Issue #268, iOS 27 changes: https://github.com/alexandercerutti/passkit-generator/issues/268
- [S52] PR #275, `placeIdentifier` for `place` actions (device-verified): https://github.com/alexandercerutti/passkit-generator/pull/275
- [S53] Issue #249, iOS 26 changes (includes passd disassembly of the time-zone keys): https://github.com/alexandercerutti/passkit-generator/issues/249
- [S54] Issue #205, iOS 18 changes: https://github.com/alexandercerutti/passkit-generator/issues/205
- [S55] passkit-generator CHANGELOG: https://github.com/alexandercerutti/passkit-generator/blob/master/CHANGELOG.md
- [S56] EIP-8426 implementation notes (Apple Wallet field tests on iOS 27, Oct 2026): https://eips.ethereum.org/assets/eip-8426/implementation-notes
- [S57] Pushwoosh, "Wallet passes on the lock screen" (2026-10-19): https://www.pushwoosh.com/blog/wallet-pass-lock-screen-locations/
- [S58] Apple Developer Forums, throttling report (no Apple reply): https://developer.apple.com/forums/thread/807401
- [S59] Apple Community, developer-setting rate-limit toggle (seen via search summary only; UNVERIFIED): https://discussions.apple.com/thread/256085805
- [S60] exporter.dev, real United pass with `departureLocationTimeZone` (seen via search summary only): https://exporter.dev/wallet

---

## Appendix A: validator table (top-level keys)

Columns: key | JSON type | styles (`ALL`, or list; PET / SBP / PG as in §3) | min OS (iOS / watchOS) | notes. `R` = required. `dep` = deprecated. `undoc` = not in Apple docs. A validator should **warn, not fail**, on undocumented keys and on style mismatches, because Wallet ignores keys a style doesn't use.

| key | type | styles | minOS | notes |
|---|---|---|---|---|
| formatVersion | int | ALL | 6/1 | R, ==1 |
| passTypeIdentifier | string | ALL | 6/1 | R, matches cert, starts with `pass.` |
| serialNumber | string | ALL | 6/1 | R, immutable |
| teamIdentifier | string | ALL | 6/1 | R |
| organizationName | l10n string | ALL | 6/1 | R |
| description | l10n string | ALL | 6/1 | R |
| boardingPass | PassFields+transitType | — | 6/1 | style key. transitType R |
| coupon | PassFields | — | 6/1 | style key |
| eventTicket | PassFields | — | 6/1 | style key |
| generic | PassFields | — | 6/1 | style key |
| storeCard | PassFields | — | 6/1 | style key |
| posterGeneric | PassFields | — | 27/27 | style key, may coexist with one legacy style key |
| preferredStyleSchemes | [string] | eventTicket, boardingPass | 18 (PET) / 26 (SBP) | values: posterEventTicket, eventTicket, semanticBoardingPass, boardingPass |
| backgroundColor | rgb string | ALL | 6/1 | accept `#hex`, emit `rgb()` |
| foregroundColor | rgb string | ALL | 6/1 | |
| labelColor | rgb string | ALL | 6/1 | |
| stripColor | rgb string | coupon, storeCard, eventTicket | ? | undoc |
| footerBackgroundColor | rgb string | PET (PG?) | 18/11 | |
| useAutomaticColors | bool | PET | 18/11 | overrides fg/label |
| suppressHeaderDarkening | bool | PET, PG | 18 (PG 27) | |
| logoText | l10n string | ALL but PET | 6/1 | |
| eventLogoText | l10n string | PET | 18.1 | |
| logoSymbolName | string | ? | ? | undoc (Pass Builder) |
| suppressStripShine | bool | strip styles | 6 | no-op since iOS 7 |
| groupingIdentifier | string | eventTicket, boardingPass | 7 | not allowed elsewhere (archive) |
| barcode | Barcode | ALL | 6 | dep iOS 9; QR/PDF417/Aztec only |
| barcodes | [Barcode] | ALL | 9/2 | first displayable wins |
| locations | [Location] | ALL | 6/1 | ≤10 |
| maxDistance | number>0 | ALL | 7 | must be a number, not a string. Root reportedly ignored (RE) |
| beacons | [Beacon] | ALL | 7/1 | ≤10 UUIDs |
| relevantDate | ISO date-time | boardingPass, eventTicket, generic | 6 | dep iOS 18 |
| relevantDates | [RelevantDate] | boardingPass, eventTicket, generic (PET Live Activity) | 18/11 | intervals ≤24 h (RE) |
| expirationDate | ISO date-time | ALL | 7 | |
| voided | bool | ALL | 7 | |
| webServiceURL | https URL | ALL | 6 | requires authenticationToken |
| authenticationToken | string ≥16 | ALL | 6 | immutable |
| associatedStoreIdentifiers | [int] | ALL | 6 (not watchOS) | |
| appLaunchURL | string | ALL | 6 (not watchOS) | requires associatedStoreIdentifiers |
| auxiliaryStoreIdentifiers | [int] | PET | 18 | |
| userInfo | any | ALL | 7 | |
| sharingProhibited | bool | ALL | 11 | |
| sharing | {method,url?,text?} | ALL | ? | undoc (RE) |
| nfc | NFC | storeCard, eventTicket (others UNVERIFIED) | 9/2 | NFC certificate required |
| semantics | SemanticTags | ALL | 12/5 | also per field |
| featuredActions | [Action] ≤2 | ALL but PET, SBP | 27/27 | |
| upcomingPassInformation | [Entry] | PET | 26/26 | |
| accessibilityURL, addOnURL, bagPolicyURL, contactVenueEmail, contactVenuePhoneNumber, contactVenueWebsite, directionsInformationURL, merchandiseURL, orderFoodURL, parkingInformationURL, purchaseParkingURL, sellURL, transferURL, transitInformationURL | string | PET (orderFoodURL also SBP) | 18 | event guide and menu |
| changeSeatURL, entertainmentURL, managementURL, purchaseAdditionalBaggageURL, purchaseLoungeAccessURL, purchaseWifiURL, registerServiceAnimalURL, reportLostBagURL, requestWheelchairURL, upgradeURL, transitProviderEmail, transitProviderPhoneNumber, transitProviderWebsiteURL | string | SBP | 26/26 | airline services |
| trackBagsURL | string | SBP | 26.1 | |
| businessChatIdentifier | string | SBP | 26 | in the SBP guide table, not on the Pass page |
| _id (any object) | string | — | — | Pass Designer artifact, ignore or strip |

Nested objects:

| object.key | type | rules |
|---|---|---|
| Location.latitude / .longitude | double | R |
| Location.altitude | double | m |
| Location.relevantText | string | no org name or instructions |
| Location.maxDistance | number>0 | undoc (RE). ≤0 rejects the pass |
| Beacon.proximityUUID | UUID string | R |
| Beacon.major / .minor | uint16 | |
| Beacon.relevantText | string | |
| RelevantDate.startDate + endDate | ISO | both or neither, ≤24 h (RE) |
| RelevantDate.date | ISO | iOS 26+. Also emit `relevantDate` for iOS 18 |
| Barcode.format | enum (8) | R. Code39/Codabar/EAN13/I2of5 need iOS 27. Code128 not on watchOS |
| Barcode.message | string | R |
| Barcode.messageEncoding | string | R (doc), default iso-8859-1 |
| Barcode.altText | string | |
| NFC.message | string | R, ≤64 bytes |
| NFC.encryptionPublicKey | base64 SPKI P-256 | R |
| NFC.requiresAuthentication | bool | iOS 13.1 |
| Action.identifier | string | R, unique |
| Action.type | enum (14) | R |
| Action.url | string | R unless type=place. `tel:` for call |
| Action.placeIdentifier | string | R if type=place (undoc in Apple docs) |
| PassFields.headerFields / primaryFields / secondaryFields / auxiliaryFields / backFields | [Field] | |
| PassFields.additionalInfoFields | [Field] | iOS 18 |
| PassFields.footerFields | [Field] | iOS 27, PG, first one shown |
| PassFields.transitType | enum (5) | boardingPass only, R there |
| Field.key | string | R, unique per style dict |
| Field.value | string / number / ISO date | R, dates with tz |
| Field.label | l10n string | |
| Field.attributedValue | string | `<a href>` only |
| Field.changeMessage | l10n string containing `%@` | |
| Field.dataDetectorTypes | [enum 4] | back fields only, `[]` = none |
| Field.textAlignment | enum 4 | not on primary or back |
| Field.dateStyle / .timeStyle | enum 5 | date values only |
| Field.isRelative / .ignoresTimeZone | bool | date values only |
| Field.currencyCode | ISO 4217 | number values, not with numberStyle |
| Field.numberStyle | enum 4 | number values, not with currencyCode |
| Field.row | 0 or 1 | eventTicket auxiliaryFields |
| Field.semantics | SemanticTags | |
| Upcoming.identifier, .name, .type="event" | | R |
| Upcoming.dateInformation{date, ignoreTimeComponents, isAllDay, isUnannounced, isUndetermined, timeZone} | | |
| Upcoming.isActive | bool | |
| Upcoming.semantics, .additionalInfoFields, .backFields, .URLs{14 URL keys}, .auxiliaryStoreIdentifiers | | |
| Upcoming.images.{headerImage, venueMap}.{URLs[{URL https, SHA256, scale, size ≤2 MB}], reuseExisting} | | |
| personalization.json: requiredPersonalizationFields (R, enum 4), description (R), termsAndConditions | | NFC passes only |

Bundle-level checks: `icon` present (any scale); `manifest.json` lists every file with correct SHA-1; `signature` verifies with the WWDR G4 chain; certificate type ID and team match `pass.json`; `.lproj` folders have equal string keys and image scale counts; no `personalization.json` in a personalized (returned) pass; `.pkpasses` ≤10 passes and ≤150 MB.

## Appendix B: known conflicts and UNVERIFIED items (decide policy explicitly)

1. Root `maxDistance`: documented, but reportedly ignored. Per-location `maxDistance` is undocumented but works (RE) [S2][S49].
2. Single-moment key in `relevantDates`: `relevantDate` (iOS 18) vs `date` (iOS 26+). Emit both [S53][S55].
3. PG footer: "two footer fields" (guide) vs "only the first will be displayed" (WWDC26) [S16][S30].
4. Generic secondary/aux: "four combined" vs "4+4 = 8". The square-barcode rule reconciles them [S16][S17][S3].
5. PET barcodes: "not compatible" (guide) vs works without NFC on iOS 27 (RE) [S20][S51].
6. Semantic names: `*LocationTimeZone` vs `*AirportTimeZone`; `loungePlaceIDs` vs `airlineLoungePlaceID`; `venuePlaceID` is undocumented [S13][S31][S37][S53].
7. Upcoming-entry casing: `URLs`/`URL`/`SHA256` (docs) vs `urls`/`url`/`sha256` (Pass Builder) [S27][S37].
8. Image sizes: background 343×503 (HIG) vs 345×505 (Pass Designer/Builder); footer 268×15 vs 286×15; icon 38 pt vs 29 pt (archive) [S29][S37][S33].
9. `additionalInfoFields`: "only PET" (field doc) vs listed for PG (PG guide) [S3][S16].
10. PG logo: `primaryLogo` (HIG, RE) vs "Logo iOS 27+" (Pass Designer table) [S29][S18][S51]. Ship both.
11. `featuredActions` type `viewMembership` (WWDC26 code) is not in Apple's list [S30][S17].
12. Barcodes on watchOS for the iOS 27 formats: UNVERIFIED.
13. Whether PG honors `footerBackgroundColor` and `useAutomaticColors`: UNVERIFIED.
14. `stripColor`, `logoSymbolName`, `sharing`, `eventLiveMessage`, `airplay`, `venueMap.png`: undocumented.
15. Wallet's handling of PDF images and hex colors: UNVERIFIED.
16. Pass-update rate limits: undocumented. Field reports only [S56][S58][S59].
17. Whether Precise Location is required for location relevance: UNVERIFIED.
18. Duplicate field keys within one style dict: forbidden by the archive spec. Rejection behavior is UNVERIFIED [S36].

## Appendix C: "supports everything" checklist (what engines usually miss)

1. `posterGeneric` **plus** a legacy style in one pass; `footerFields` with only the first one rendered; unlabeled first primary field becomes a bold title (iOS 27).
2. `featuredActions`: ≤2 per pass, 14 types, `place` uses `placeIdentifier` (not `url`), `call` uses a `tel:` URL, hidden on PET and SBP.
3. Ordered `barcodes[]` fallbacks: iOS 27 formats first, then an iOS 9 format. Code128 is not shown on watchOS. Keep the legacy `barcode` dict for iOS ≤8 only if you care.
4. Relevance details: ≤10 `locations`; **per-location `maxDistance`** (root is ignored, RE); `beacons` with major/minor; `relevantDates` with both `date` and `relevantDate`, intervals ≤24 h; the generic date-AND-location rule; no date relevance on coupon or storeCard.
5. `preferredStyleSchemes` validation and fallback: PET and SBP need valid legacy fields too, or ingestion fails on every device.
6. `additionalInfoFields`, `auxiliaryFields[].row`, field-level `semantics`.
7. `upcomingPassInformation` with remote images (`URLs[]`, `SHA256`, `size` ≤2 MB, `scale`, `reuseExisting`) and per-entry `URLs`.
8. All ~30 URL keys: 14 event-guide/menu keys, 13 airline-service keys, `trackBagsURL` (26.1) and `businessChatIdentifier`.
9. The full semantic tag set (104 documented keys plus undocumented aliases), typed sub-objects, and enum validation (event types, security programs, passenger capabilities, SSR codes).
10. Every image slot: `icon`, `logo`, `primaryLogo`, `secondaryLogo`, `strip`, `thumbnail`, `background`, `artwork`, `footer`, `personalizationLogo`, (undocumented) `venueMap`. Each at @1x, @2x and @3x, and per `.lproj`.
11. Localization: `pass.strings` (UTF-16 per Apple), localized images, and top-level images overriding localized ones.
12. Personalization: `personalization.json`, the `/personalize` endpoint, signing the token, returning a pass without `personalization.json`.
13. NFC dictionary rules (≤64-byte message, P-256 SPKI key, `requiresAuthentication` with `sharingProhibited`).
14. `.pkpasses` bundles (≤10 passes or 150 MB, MIME `application/vnd.apple.pkpasses`).
15. The web service in full: `204` for no updates, `304` with `If-Modified-Since`, the `/v1/log` endpoint, an optional `passesUpdatedSince`, and device cleanup on unregister.
16. APNs: HTTP/2 only, production only, certificate **or** JWT with topic set to the pass type ID, empty `{}` payload, invalid-token pruning, and pushing only on real changes (iOS 27 may disable auto-updates otherwise, RE).
17. `changeMessage` semantics: `%@`, compared against the device's stored copy, no markup on `attributedValue` fields, per-field only, not on watchOS.
18. Field formatting: `dateStyle`/`timeStyle`/`isRelative`/`ignoresTimeZone`, `currencyCode` xor `numberStyle`, `dataDetectorTypes: []`, the `textAlignment` restrictions.
19. Lifecycle: `expirationDate`, `voided`, auto-hiding. Also the reported hide-after-`relevantDate` behavior.
20. Companion keys: `userInfo`; `appLaunchURL` needs `associatedStoreIdentifiers`; `auxiliaryStoreIdentifiers`.
21. `groupingIdentifier`, which is only allowed for eventTicket and boardingPass.
22. Undocumented but real: `stripColor`, `sharing`, `logoSymbolName` (Pass Builder), `eventLiveMessage`, `airplay`, `venuePlaceID`.
23. Pass Designer interop: read `.pkpasstemplate`, tolerate `_id` and `tooling.json`, and optionally accept Pass Builder protobuf customizations.
24. Signing: SHA-1 manifest, CMS detached signature with WWDR **G4**, EC or RSA keys, exclude junk files.
25. `authenticationToken` of at least 16 characters, never rotated; `serialNumber` immutable.
