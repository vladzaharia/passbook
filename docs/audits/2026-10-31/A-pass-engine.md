# Audit A: pass engine and template system

**Scope:** `src/sign.ts`, `src/personalize.ts`, `src/passes.ts`, `src/templates/*`, `src/generated/*` (skimmed), `src/assets.ts`, `src/signing-identities.ts`, `src/identity-names.ts`, `src/types.ts`, `scripts/build-assets.mjs`, `scripts/package-template.mjs`, `scripts/sample.ts`, `templates/*.pkpasstemplate/{pass.json,tooling.json}` and the PNGs in them, `docs/extending.md`, `docs/henrys-reference.json`. I also read the code that uses the engine where it bears on templates: `index.ts`, `jobs.ts`, `views.ts`, `email.ts`, `status.ts`, `admin/client.ts`, `sources/*`, the migration and the tests.

**Method:**
- Read all of the files above.
- Ran `npx tsc --noEmit`. It passes.
- Ran a local micro-benchmark under Node 26 on macOS. It used a throwaway OpenSSL identity in the scratchpad (not workerd, not production).
- Did not run `npm test`. Its `npm run assets` step rewrites `src/generated/` and `public/`, which counts as a project write.
- Did not open `.secrets/` or `.dev.vars`.
- Checked the claims below against Apple's WalletPasses docs (Poster Generic, Pass Designer, Building a Pass), the source of Apple's open-source `apple/pass-builder`, and the Cloudflare docs. Sources are listed at the end.

**Scope change from the owner:** existing passes and data can be wiped. The recommendations assume a clean-slate schema and new template IDs. They include no compatibility shims.

---

## 1. Summary

1. **Signing is sound and tested end to end.** It produces a SHA-1 `manifest.json` and a detached CMS signature (SHA-256, with contentType, signingTime and messageDigest attributes, and the WWDR G4 cert embedded). It checks that the certificate's UID and OU match the pass, and it re-verifies the key pair after signing. OpenSSL and workerd both verify the output. **Not yet verified: a physical iPhone has never installed the pass** (`docs/deployment.md:23`).
2. **The template abstraction is about 70% data already.** That data is pass.json, the asset map, and the input schema with `fieldKeys` and `paths`. Each template still needs a TypeScript module, a build-time JSON import and a hand-bumped integer `version`. Henry's-specific code also leaks into core: views, the list API, the admin client, status and email.
3. **Correctness risks in the shipped templates:**
   - Duplicate field `key`s inside a style. Apple requires keys to be unique.
   - An unused 2.9 MB `background.png`. It makes each pass about 5.7 MB, and every device re-downloads the whole bundle on each update.
   - No pass.json validation before signing.
   - Manual template versions that are easy to forget to bump.
4. **Multi-org support is blocked by structure, not by crypto:**
   - Signing identities are env-var names, capped at 128 vars per Worker, and any change needs a redeploy.
   - The APNs binding hangs off the template instead of the identity.
   - `passTypeIdentifier` and `teamIdentifier` are hard-coded in each template's pass.json.
5. **Recommended direction:**
   - A template package format: Apple's `.pkpasstemplate` plus a `wallet.template.json` manifest.
   - One registry for baked (static assets) and uploaded (R2 + D1) templates.
   - Declarative bindings, plus optional trusted behavior plugins.
   - An identities table with envelope-encrypted keys.
   - Precomputed asset digests and a streamed "virtual pkpass".
   - A generic renderer, driven by pass.json, for front and back previews.

---

## 2. What works well and should be kept

- **Signing stack** (`sign.ts:27-84`). PKI.js builds the CMS and Workers Web Crypto does the RSA signing. There is no Node signer, no node-forge and no subprocess. The checks are solid:
  - validity windows (`:41-42`)
  - chain signature (`:46`)
  - cert UID/OU matches `passTypeIdentifier`/`teamIdentifier` (`:43`), the same check Apple's Pass Builder does (`validateAttributes(for:)`)
  - re-parse and verify after signing, which catches a mismatched key and cert (`:79-81`)

  The signed attributes come out in DER-canonical SET OF order (contentType, signingTime, messageDigest, by encoded length 0x18 < 0x1C < 0x2F). This holds by construction, not by explicit sorting, so keep that order.
- **Manifest and zip.** The manifest covers every file except itself and the signature, in sorted order (`:54-58`). The zip uses STORE level 0, so PNGs are not recompressed (`:83`).
- **Asset hygiene:**
  - The asset name allowlist covers `.lproj` (`sign.ts:49`) and rejects `..`.
  - `tooling.json` and dotfiles never ship (`build-assets.mjs:15`).
  - The pass is rejected without an icon (`sign.ts:52`).
- **Server-owned fields:**
  - serial, authenticationToken and webServiceURL are injected *after* personalization (`passes.ts:21`) and are protected from mappings (`personalize.ts:27`).
  - Prototype keys are rejected (`:28`).
  - Unknown input fields are rejected (`personalize.ts:6`).
- **Serializable schema.** The input schema is plain JSON (`types.ts:3-13`). Mapping by Wallet field key (`fieldKeys`) matches Apple's own model in Pass Builder (`package.pass.fields.setValue(.text(...), forKey:)`).
- **Publish protocol:**
  - R2 is written first, then a D1 compare-and-swap commits (`passes.ts:56-64`).
  - Stored versions are immutable.
  - ETag and If-Modified-Since handling is careful (`passes.ts:68-77`).
  - The no-op check avoids re-signing and re-pushing when nothing changed (`passes.ts:55`).
- **Private baked assets.** They ship as Worker Static Assets with `run_worker_first: true` (`wrangler.jsonc:8`). Nothing is public unless a route allowlists it.
- **WWDR handling.** WWDR G4 is bundled and can be overridden per identity (`signing-identities.ts:8`). Certificate expiry shows on the status page (`status.ts:34-39`).
- **Featured actions validation:**
  - at most 2 actions, with unique identifiers
  - `place` requires a `placeIdentifier`
  - other types require an `https`/`tel` URL

  This matches what community validators found for iOS 27 ([robdvr/passkit#5](https://github.com/robdvr/passkit/pull/5), [passkit-generator#275](https://github.com/alexandercerutti/passkit-generator/pull/275)). Keep the logic but move it (see L1).
- **Barcode ordering.** The barcodes array lists Code 39 first, then a Code 128 fallback. That is the right pattern for older OS versions.
- **Pass styles.** `posterGeneric` plus a `generic` fallback in one pass.json is what Apple recommends for backward compatibility ([Creating a Poster Generic Pass](https://developer.apple.com/documentation/walletpasses/creating-a-poster-generic-pass)).
- **Runtime test.** The workerd signing test (`scripts/test-runtime.ts`, `tests/runtime-worker.ts`) should stay as a CI gate. So should the OpenSSL `cms -verify` test (`tests/service.test.ts:43-55`).

---

## 3. Problems and bugs

| ID | Where | Sev | Problem and why it matters |
|---|---|---|---|
| H1 | `templates/henrys*.pkpasstemplate/pass.json`: in `generic`, `memberId` is in both `auxiliaryFields` and `backFields`, and `status` is in both `headerFields` and `backFields`. In `posterGeneric`, `memberId` is in both `headerFields` and `backFields`. | **High** (device behaviour unverified) | Apple documents field `key` as unique within a pass. passkit-generator enforces one key pool per pass, and there are field reports of passes that will not install. Unique keys are also how Wallet tracks fields for change notifications. The physical-device acceptance test is still outstanding (`deployment.md:23`). `personalize.ts:43` actually *relies* on the duplicates to fan one input out to several fields. **Fix:** give each field a unique key (`memberId-header`, `memberId-back`, `status-back`) and list all of them in `fieldKeys`. |
| M1 | `background.png` (345×505 pt, **2.88 MB of the 5.73 MB bundle**) ships in every pass. `build-assets.mjs:15` indexes every PNG, and `sign.ts:48-51` signs whatever it is given. | Med | Apple's Pass Designer image table lists *Background* as N/A for both Generic and Poster Generic. Poster Generic draws `artwork.png`, which a community device test on iOS 27 confirms. As a result:<br>• every pass is about 5.74 MB<br>• every APNs-triggered refresh re-downloads it on every registered device<br>• the email attachment is about 7.7 MB once base64-encoded<br>• each new version writes another 5.7 MB object to R2<br>The image is only "used" as web preview art (`index.ts:56`, `views.ts:11`, `client.ts:103,170,193`, `studio.ts:39`). Separately, `artwork@3x.png` is 1.7 MB and would benefit from lossless optimisation. |
| M2 | `sign.ts:27-53` checks only featuredActions and the icon before signing. | Med | Nothing checks pass.json itself:<br>• required keys (`description`, `organizationName`, `formatVersion`)<br>• a style key, and a fallback for `posterGeneric`<br>• field counts per style and key uniqueness<br>• `rgb()` colors and ISO dates<br>• barcode formats<br>An invalid pass is signed, stored, emailed and pushed, and only fails when someone tries to add it ("cannot be added"). This becomes mandatory once templates can be uploaded. |
| M3 | Manual `version: 1` (`henrys.ts:6`). `templates/index.ts:7` builds `henrys-blue` by spreading `henrys`, so blue inherits that version. | Med | The no-op check (`passes.ts:55`) depends on this number. Changing art, fixed text or mappings without bumping it never rebuilds existing passes. Changing blue's art also requires bumping `henrys`. A content hash removes the failure mode. |
| M4 | `personalize.ts:36-49` writes only the inputs that are present. Nothing can remove a field. | Med | Optional inputs with no default leave the template's Pass Designer sample values in place, such as "Alex Morgan" or "DEMO0001". There is no "omit when empty" option. That is acceptable for Henry's today (the portal default is intentional), but uploaded templates will leak placeholder data. |
| M5 | `personalize.ts:43`: `fieldKeys` sets only `value`. | Med | A field that also has `attributedValue` keeps the template's version, and Wallet shows that one on the back. Values are not coerced to match the field's formatter either: `dateStyle` fields need ISO strings, and `numberStyle`/`currencyCode` fields need numbers. |
| M6 | Index-based pointers into arrays: `henrys.ts:9` (`/barcodes/0..1/*`) and `henrys.ts:17` (`/featuredActions/0/url`). The customize hook, by contrast, finds the action by identifier (`henrys.ts:23`). `setPath` also creates leaves past the end of an array (`personalize.ts:31`). | Med | If the actions are reordered in Pass Designer, the portal URL lands on the `place` action. `signPass` does not catch this, because a place action is only checked for `placeIdentifier`. Writing past the end of `barcodes` creates a sparse array, which JSON serialises as `null`. |
| M7 | Henry's-specific code in core:<br>• `views.ts:5` imports `henrys-clubs`<br>• `views.ts:16-17` uses `startsWith('henrys')` and a hard-coded memberspot URL<br>• `index.ts:73-77,86` searches and lists by `memberName`, `memberId`, `homeClub`, `status`<br>• `client.ts:78,94,103-105` has a label map, an "advanced" field list and a preview<br>• `status.ts:21,30` uses the first template's `icon@2x.png`<br>• `email.ts:16` assumes `logo@2x.png` exists<br>• `index.ts:56` has a 3-file brand allowlist | Med | Each of these breaks or degrades a non-Henry's template. A poster-only template may have no `logo@2x.png`. A template missing an allowlisted asset hits `loadAsset(undefined)`, which returns a 500. |
| M8 | `apnsBinding` is on the template (`types.ts:19`, `henrys.ts:6`) and is resolved via `getTemplate(row.template_id)` in `jobs.ts:10`. | Med | Push transport belongs to the Pass Type ID certificate, not to a design. Two templates of the same pass type could disagree. Removing a template from the registry makes pushes for its existing passes throw `HTTPException(404)` inside the queue consumer, so they retry and end in the dead-letter queue. |
| M9 | Identity resolution goes through env-var naming: `identity-names.ts:1-5`, `signing-identities.ts:5-11`, `types.ts:39` (`[binding: string]: unknown`). | Med (for the target) | Each identity costs 2–3 secrets against **128 vars per Worker (paid)**, at 5 KB each ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Any change requires a redeploy, and nothing scopes an identity to an org. The template also bakes `passTypeIdentifier`/`teamIdentifier` into its pass.json, so one design cannot be reused across orgs. |
| M10 | `personalize.ts:14` runs `new RegExp(spec.pattern)` on schema data. It is unanchored unless the author anchors it. | Med (once templates can be uploaded) | This is fine for code-reviewed templates. For admin-uploaded schemas it is a CPU/ReDoS risk inside the request path. |
| L1 | Featured-action rules live in the signer (`sign.ts:28-38`). `/^(https:\|tel:)/` also accepts `https:foo`. | Low | This mixes layers. Move the rules into a `validatePass()` step and check the URL with `new URL()` plus a host. |
| L2 | Per-call overhead in the signer:<br>• `sign.ts:56`: `Uint8Array.from(files[name])` copies every asset (5.7 MB) just to hash it<br>• `sign.ts:39-46,76`: re-parses the PEMs, re-verifies the chain and re-imports the key on every call | Low | The measured cost is small: importKey takes about 0.4 ms. It is easy to cache the parsed identity per isolate, keyed by cert fingerprint. |
| L3 | `sign.ts:83` uses `zipSync` and builds the whole archive in memory. | Low | Peak memory is about 3× the bundle (the assets, the hashing copy and the zip). That is fine now, but tight against 128 MB per isolate with large uploaded templates or concurrent builds. |
| L4 | 33 Pass Designer `_id` keys ship verbatim in `henrys` pass.json. `henrys-blue` has none. | Low | Harmless bytes, but it shows that template JSON is shipped unfiltered. Strip non-Apple keys on import. |
| L5 | `package-template.mjs:4` hard-codes the slugs, and `:6` uses a non-recursive `readdir` followed by `readFile`. | Low | A template with any `.lproj` directory fails with EISDIR. |
| L6 | `build-assets.mjs:15` and `sign.ts:49` accept only `png` and `strings`. | Low (decide explicitly) | Apple's pass-builder `PassImageDescriptor.FileType` also accepts `.pdf` images. **Unverified** whether Wallet itself accepts PDF images. |
| L7 | `getTemplate` throws a Hono `HTTPException` (`templates/index.ts:11`). | Low | This couples the registry to HTTP, so queue and cron paths get HTTP errors. |
| L8 | `henrys-clubs.ts:22`: an unknown `homeClub` silently falls back to Capitol Hill. `henrys.ts:23,29` use non-null `!`. | Low | A Pass Designer edit that renames the action or the `phone` field causes a TypeError (500) on every build. |
| L9 | `passes.ts:21` derives `webServiceURL` from the current `PUBLIC_BASE_URL` at every rebuild instead of storing it per pass. | Low | Changing the origin silently moves installed passes to a new service URL on their next update. |
| L10 | `index.ts:30` sets `Cache-Control: no-store` on everything, including `/brand/*` and `/admin/*`. | Low | The 0.9 MB `background@2x.png` is re-downloaded on every admin load, and it is used as a list avatar (`client.ts:170`). |
| L11 | Old R2 versions are kept forever (`README.md:91`), at 5.7 MB each. | Low | Storage grows as passes × updates × 5.7 MB. See §5.8. |
| L12 | The CSP allows `'unsafe-inline'` scripts (`index.ts:29`). | Low (rises once templates can be uploaded) | Once uploaded template strings are rendered in an admin preview, template content becomes an XSS vector in the admin origin. |

---

## 4. Not modern best practice

| Today | Modern alternative |
|---|---|
| Hand-rolled schema (`types.ts:3-13`, `validateInputs`). It has no labels, help text, groups or widgets, so the admin hard-codes them (`client.ts:78,94`). | A **JSON Schema 2020-12 subset** with `x-label`, `x-group`, `x-widget`, `x-order`, `x-search`. Validate with `@cfworker/json-schema`, which uses no eval and runs on Workers. Ajv's code generation uses `new Function`, which Workers block unless it is precompiled. The same schema then drives admin forms, OpenAPI and connection-mapping validation. |
| One TypeScript module per template, with JSON imported at build time. | A **declarative package**, with code only as named, versioned behavior plugins (§5.2). |
| A hand-bumped integer version. | **Content-addressed versions**: sha256 over the canonical pass.json, the sorted asset sha1s and the manifest. |
| A generated TS map of name → path (`src/generated/*-assets.ts`). | A generated or uploaded **asset index with `sha1`, `crc32`, `size`, `width`, `height` and slot**, so runtime code never re-hashes immutable images. |
| Hash and zip every image on every sign. | **Precomputed digests** plus a **streaming STORE zip** (local header → piped asset stream → central directory) through `FixedLengthStream` into R2 or straight into the response. |
| Store a full pkpass (5.7 MB) per version. | Store only the per-version `pass.json`/`manifest.json`/`signature` (~10 KB) and **assemble on download** from immutable template assets, or at least deduplicate them. |
| Identities as env-var names. | An **identities table** with **envelope encryption** (AES-256-GCM, with the KEK in Secrets Store) and a cached non-extractable `CryptoKey`. |
| Ad-hoc JSON Pointer writes plus a key walk. | **Typed binding targets**: a field key, an action by `identifier`, a barcode by index or `*`, or an allowlisted RFC 6901 pointer. Each is validated against the template at upload time: the target must exist and be type-compatible. |
| `new RegExp` built from data. | A curated **format catalog** (`code39`, `code128`, `digits`, `ean13`, `email`, `https-url`, `date`, `date-time`), plus optionally a linear-time regex engine (re2js; Workers compatibility unverified). |
| A Henry's-only preview in HTML (`views.ts:10-12`) and a studio summary line (`client.ts:102-106`). | A **generic renderer driven by pass.json**, shared by Worker SSR and the admin client (§5.7). |
| Validation scattered between the signer and the template code. | A **validator plugin pipeline** with error/warning severities, the model Apple's Pass Builder uses (`PassValidator` / `PassValidationPlugin`). |

---

## 5. Gaps vs. the target, with recommendations

### 5.1 Template package and manifest (uploaded templates without code)

```
<slug>.pkpasstemplate/            (upload as the folder zipped, or a .zip containing it)
  pass.json                       Apple-native, as exported by Pass Designer; sample values allowed
  icon.png icon@2x.png icon@3x.png, primaryLogo*, artwork*, logo*, strip*, thumbnail* …
  <bcp47>.lproj/pass.strings, <bcp47>.lproj/<slot>(@2x|@3x).png
  tooling.json                    accepted and stored, never shipped
  wallet.template.json            OUR manifest (optional on upload; editable in admin)
```

```ts
interface TemplateManifest {
  schema: 1;
  name: string; description?: string;
  inputs: JSONSchemaObject;                 // properties carry x-label/x-group/x-widget/x-order/x-search
  sample: Record<string, Json>;             // drives preview, upload dry-run, docs
  lookups?: Record<string, Record<string, Record<string, Json>>>;   // static tables, e.g. clubs
  bindings: Binding[];
  display: { title: Expr; subtitle?: Expr; status?: Expr; search?: string[] }; // replaces index.ts:73-86
  behaviors?: { use: string; version: number; config: Json }[];     // trusted plugins, §5.2
  requires?: { styles?: PassStyle[]; nfc?: boolean };
}
type Expr = string /* "{{memberName}}", "{{lookups.clubs[homeClub].phone}}" */ | { const: Json };
type Target =
  | { field: string | string[]; prop?: 'value' | 'attributedValue' | 'label' }  // every style dict
  | { action: string; prop: 'url' | 'placeIdentifier' }                         // featuredActions by identifier
  | { barcode: number | '*'; prop: 'message' | 'altText' }
  | { pointer: string };                                                        // allowlisted RFC 6901
type Condition = { input: string; eq?: Json; in?: Json[]; empty?: boolean }
  | { all: Condition[] } | { any: Condition[] } | { not: Condition };
interface Binding { to: Target; value?: Expr; when?: Condition; remove?: Condition; omitIfEmpty?: boolean }
```

**Henry's `customize` written declaratively.** Everything except building the `locations` list is a plain binding:

```jsonc
"lookups": { "clubs": { "capitol-hill": { "name": "Capitol Hill", "place": "I23C636C7300F20FD", "phone": "(206) 644-7797", "lat": 47.615835, "lng": -122.323555 },
                        "queen-anne":   { "name": "Queen Anne",   "place": "I1F4F79088B704BE",  "phone": "(206) 644-0969", "lat": 47.624765, "lng": -122.356206 } } },
"bindings": [
  { "to": { "field": ["memberId-header", "memberId-aux", "memberId-back"] }, "value": "{{memberId}}" },
  { "to": { "barcode": "*", "prop": "message" }, "value": "{{memberId}}" },
  { "to": { "action": "membership", "prop": "url" }, "value": "{{memberPortalURL}}", "omitIfEmpty": true },
  { "to": { "action": "home-gym-directions", "prop": "placeIdentifier" }, "value": "{{lookups.clubs[homeClub].place}}" },
  { "to": { "field": "phone" }, "value": "{{lookups.clubs[homeClub].phone}}" },
  { "to": { "field": "directions-queen-anne" },  "remove": { "all": [ { "input": "access", "eq": "home" }, { "not": { "input": "homeClub", "eq": "queen-anne" } } ] } },
  { "to": { "field": "directions-capitol-hill" }, "remove": { "all": [ { "input": "access", "eq": "home" }, { "not": { "input": "homeClub", "eq": "capitol-hill" } } ] } }
],
"behaviors": [ { "use": "venue-locations", "version": 1, "config": { "venues": "clubs", "homeInput": "homeClub", "accessInput": "access", "allValue": "all", "relevantText": "Your Henry’s Gymnasium membership — {{name}}" } } ]
```

Rules:
- **Inputs:** `enum` holds stable IDs (`capitol-hill`), not display strings. `x-enumLabels` provides the display text.
- **Expressions:** the language is deliberately tiny. It supports interpolation, lookups and conditions, with no loops and no user functions, so it is bounded in CPU and safe to accept from uploads.
- **Evaluation order:**
  1. bindings
  2. behaviors
  3. server-field injection
  4. `validatePass()` (§5.4), which always runs last

### 5.2 Behavior plugins (what has to stay code)

```ts
interface BehaviorPlugin<C = unknown> {
  id: string; version: number;
  configSchema: JSONSchemaObject;            // validated at template upload
  apply(pass: PassJson, input: Personalization, config: C, ctx: { now: Date; identity: IdentityInfo; lookups: Lookups }): void;
}
```

- Plugins are registered at build time, like `sources/index.ts`. Uploaded templates can **reference** a registered plugin and configure it, but never ship code.
- Henry's behaviour becomes a reusable `venue-locations` plugin for any multi-location business. It handles location relevance and an optional "nearest/home venue" action.
- **What stays code:**
  - connection adapters (`sources/`)
  - behavior plugins: multi-venue, computed check digits, NFC payload encryption, time-based relevance, anything needing loops or I/O
  - signing
  - the APNs transport
- If tenants ever need custom logic, run it in Workers for Platforms or the Dynamic Worker Loader sandbox, not in the main Worker. That is probably unnecessary.

### 5.3 One registry for baked and uploaded templates

```ts
type PassStyle = 'generic' | 'posterGeneric' | 'storeCard' | 'coupon' | 'eventTicket' | 'boardingPass';
interface AssetEntry { name: string; slot: ImageSlot | 'strings'; scale: 1 | 2 | 3; locale?: string;
  size: number; sha1: string; crc32: number; width?: number; height?: number;
  source: { kind: 'static'; path: string } | { kind: 'r2'; key: string } }
interface ResolvedTemplate { id: string; version: string /* content hash */; orgId: string | null;
  origin: 'baked' | 'uploaded'; manifest: TemplateManifest; passJson: PassJson; assets: AssetEntry[]; styles: PassStyle[] }
interface TemplateRegistry {
  list(q: { orgId?: string; includeArchived?: boolean }): Promise<TemplateSummary[]>;
  resolve(id: string, version?: string): Promise<ResolvedTemplate>;   // immutable → cache forever per isolate
  openAsset(t: ResolvedTemplate, name: string): Promise<ReadableStream>;
}
interface MutableTemplateRegistry extends TemplateRegistry {
  upload(orgId: string, archive: ReadableStream, by: UserId): Promise<{ id: string; version: string; report: ValidationReport }>;
  activate(id: string, version: string): Promise<void>;   // starts the "rebuild passes" Workflow
  archive(id: string): Promise<void>;                     // soft delete; hard delete only when 0 passes reference it
}
```

- **Baked templates:** `build-assets.mjs` emits `public/templates/index.json` containing each manifest and the asset hashes, sizes and dimensions. No TS module per template is needed. IDs are namespaced (`baked:henrys-copper`), and mutating calls return 403. "Customize a baked template" means cloning it into an uploaded copy.
- **Uploaded templates:** D1 tables `templates(id, org_id, slug, name, active_version, status)`, `template_versions(template_id, version, manifest_json, pass_json, report_json, created_by, created_at)` and `template_assets(...)`. Assets go in R2 under `templates/<org>/<id>/<version>/<file>`, or content-addressed as `assets/<sha1>`.
- **Lookup:** a `CompositeRegistry` checks baked first, then D1. Passes store `(template_id, template_version, identity_id)`, so old versions stay resolvable for pushes and rebuilds (this fixes M8's 404 path).

### 5.4 Upload pipeline and validation

Run it as a Worker route plus a **Workflow**. Alternatively, use a presigned R2 PUT, then an R2 event notification, a Queue and the Workflow.

1. **Limits.** Give the upload route its own body limit (the global one is 32 KB, `index.ts:22`), for example 15 MB. Unzip with fflate `unzip` and its `filter` callback:
   - at most 100 entries
   - each entry's declared size ≤ 5 MB
   - at most 15 MB uncompressed in total
   - a compression-ratio cap (zip bombs)
2. **Paths.** Strip one leading `*.pkpasstemplate/`. Reject absolute paths, `..`, backslashes, NUL bytes, symlink external attributes and case-insensitive duplicates. Drop `__MACOSX/`, `.DS_Store`, `manifest.json` and `signature`. Store `tooling.json` aside.
3. **Name allowlist:** `pass.json`, `wallet.template.json`, `<slot>(@2x|@3x)?.png`, `<bcp47>.lproj/(pass.strings|<slot>(@2x|@3x)?.png)`.
4. **Images.**
   - Check the PNG magic bytes and parse IHDR (24 bytes), or use the **Images binding `.info()`**.
   - Check dimensions against the slot table from Apple pass-builder (`PassPackage.swift`), in points times scale:

     | Slot | Constraint (pt) |
     |---|---|
     | icon | 38×38 exactly; required |
     | logo | max 160×50 |
     | primaryLogo | max 126×30 |
     | secondaryLogo | max 135×12 |
     | strip | 375×144 exactly |
     | thumbnail | 90×90 exactly |
     | artwork | 358×448 exactly |
     | background | 345×505 exactly |
     | footer | max 286×15 |

   - Use error and warning severities.
   - **Drop slots that none of the declared styles use**, with a warning, which fixes M1. Every localization folder must contain the same localized images (Apple's "Common Problems" list).
5. **pass.json.**
   - At most 64 KB.
   - Schema checks: `formatVersion: 1`, `description`, `organizationName`, at least one style, a fallback style alongside `posterGeneric`, field counts per style (poster: 1 header, 4 primary, 2 footer), **unique keys**, `rgb()` colors, ISO dates, known barcode formats, the featuredActions rules.
   - Strip `_id`, `serialNumber`, `authenticationToken` and `webServiceURL`.
   - **Replace `passTypeIdentifier`/`teamIdentifier` with the org identity's values.**
   - Reject `nfc` unless the identity is flagged for NFC.
   - Allow only `<a href="https:|tel:|mailto:">` in `attributedValue`.
6. **.strings files.** Decode UTF-8 or UTF-16 by BOM and parse `"k" = "v";`. Every locale must have the same key set, which Apple's "Common Problems" list requires.
7. **Manifest checks.**
   - Validate `configSchema` for each behavior.
   - Resolve every binding target against pass.json.
   - Run `sample` through the engine.
   - Do a **dry-run sign** without storing it.
   - Render a preview thumbnail.
8. **Persist** an immutable version with precomputed `sha1`/`crc32` for each asset. Signing then only hashes pass.json.

### 5.5 Engine pipeline (one function used by API, sources, user force-refresh and Workflows)

```ts
async function buildPass(ref: TemplateRef, input: unknown, ctx: { identity: Identity; serial: string; token: string; webServiceURL: string }): Promise<BuiltPass>
// resolve → validate inputs (JSON Schema) → bindings → behaviors → inject server fields
//         → validatePass → manifest(precomputed asset sha1 + sha1(pass.json)) → CMS sign → { passJson, manifest, signature, assets }
function streamPkpass(built: BuiltPass, registry: TemplateRegistry): { stream: ReadableStream; length: number }
async function rebuild(serial: string, opts: { force?: boolean; reason: 'edit' | 'source' | 'user-refresh' | 'template-version' | 'cert-rotation' }): Promise<{ changed: boolean }>
```

- `force` is needed for user force-refresh and certificate rotation. Today, `passes.ts:55` makes a `PATCH {}` a no-op unless the template version changed.
- Store `webServiceURL` per pass row (L9).

### 5.6 Multi-org signing, certificate storage and APNs

**How identities resolve today:** `template.signingIdentity` → `SIGNER_<ID>_{CERTIFICATE,PRIVATE_KEY,INTERMEDIATE}` env vars, with WWDR G4 as the default. The APNs binding name comes from the template. Status enumerates identities from templates.

**Target data model:**
```
signing_identities(id, org_id, label, pass_type_id, team_id, cert_pem, cert_sha256,
                   key_wrapped, key_iv, kek_version, wwdr_pem NULL, not_before, not_after,
                   apns_mode 'binding'|'relay', apns_binding NULL, nfc_enabled, status)
```
Passes store `identity_id`. Templates never carry the pass type or team. The `sign.ts:43` cross-check stays as a defence.

**Where certificates should live:**

| Option | Fit |
|---|---|
| Workers secrets | Static per deploy, 128 vars per Worker, 5 KB each, any change means a redeploy. Use only for a bootstrap, operator-owned identity. |
| **Secrets Store** | 100 secrets per account (beta), 64 KB each, one store per account. Bindings are static in the wrangler config and read with `get()` ([docs](https://developers.cloudflare.com/secrets-store/manage-secrets/)). Use it for the **KEK**, not for per-tenant keys. |
| **D1 (or R2) with envelope encryption**, the recommendation | Dynamic and scalable. Use AES-256-GCM with a per-record IV and AAD = `identity_id‖org_id`. The KEK comes from Secrets Store, with a `kek_version` for rotation. Decrypt, then `importKey` as non-extractable, and cache it per isolate in a `Map` keyed by `cert_sha256`. Keep the cert PEM in plaintext. |

- **Upload format:** accept a PEM cert plus a PKCS#8 key, or a PKCS#12. **Unverified:** legacy macOS Keychain `.p12` exports use 3DES/RC2 PBE, which Web Crypto cannot decrypt. Offer the existing CLI conversion (`import-credentials.mjs`) as a fallback.

**APNs:**
- Apple documents pass-update pushes **only with the Pass Type ID certificate** over production APNs ([Adding a web service to update passes](https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes)).
- Token-based `.p8` auth is undocumented for Wallet, and forum threads report pushes that never arrive. **Do not plan on `.p8`.** That is flagged as unverified; get a DTS answer if you want certainty.
- Workers mTLS bindings are static wrangler config ([mTLS binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/)).
- A dynamic client certificate through `connect()` or `node:tls`, combined with APNs' HTTP/2, is **not a viable in-Worker path** (unverified; would need a spike).

```ts
interface ApnsTransport { send(identity: IdentityInfo, pushTokens: string[]): Promise<{ token: string; status: number; reason?: string; timestamp?: number }[]> }
```

- **(a) Now:** one mTLS binding per identity, automated through the Cloudflare API. Upload the certificate, then publish a new Worker version that adds `APNS_<id>`. This is fine for tens of orgs, and renewals reuse the same binding name.
- **(b) At scale:** an APNs relay in **Cloudflare Containers** that receives the decrypted cert per batch.
- **(c)** Workers for Platforms, with one push worker per identity.

Design against `ApnsTransport` so (b) can replace (a) later. Move `apnsBinding` off `PassTemplate` (M8).

### 5.7 Pass preview rendering (admin detail page and user portal)

**What exists today:**
- the Henry's-only landing preview (`views.ts:10-12`)
- the studio summary line (`client.ts:102-106`)

None of it reads pass.json.

**Data that is already available:**
- `personalize()` is deterministic and cheap (about 0.05 ms), so `pass.json` for any version can be recomputed from `(template@version, personalization)`. Alternatively, store the signed `pass.json` per version, which costs about 10 KB.
- Images exist but are exposed only through a 3-file allowlist (`index.ts:56`).

**Recommendation:** a framework-free `src/preview/` module.

```ts
renderPass(pass: PassJson, opts: { face: 'front' | 'back'; style?: PassStyle;
  asset(name: string, scale: 1 | 2 | 3): string | undefined; locale?: string;
  strings?: Record<string, string>; now?: Date; status?: { voided?: boolean; expired?: boolean } }): string  // escaped HTML + inline SVG
```

- **Where it runs:** in the Worker (user portal SSR, plus an email-safe static variant) and in the admin client (live preview while editing).
- **Style resolution matches Wallet's:** `posterGeneric` first, then the poster event ticket via `preferredStyleSchemes`, then the legacy style.
- **Layouts per style:**
  - poster: `artwork` full-bleed at 4:5 with about 5% side crop, `primaryLogo`, 1 header, up to 4 primary, up to 2 footer, square barcode
  - generic: logo or logoText, header, primary plus thumbnail, secondary/auxiliary
  - storeCard/coupon: strip
  - eventTicket: blurred background plus thumbnail
  - boardingPass: transitType glyph
- **Formatting:** use `Intl` for `dateStyle`, `timeStyle`, `numberStyle`, `currencyCode`, `ignoresTimeZone` and `textAlignment`, and parse colors from `rgb()`.
- **Back face:** `backFields` with sanitised `attributedValue` links, `featuredActions` cards, `additionalInfoFields`, and voided/expired banners.
- **Barcodes:** `bwip-js` rendered to SVG. It supports every Wallet format, including Code 39, Codabar, EAN-13 and ITF; Workers compatibility is unverified. Label the result "approximate".
- **Asset routes:**
  - admin: `/api/templates/:id/:version/assets/:name`
  - user portal: `/p/:token/assets/:name`, scoped by the pass token

  Both are immutable by content hash, so use `Cache-Control: immutable`, not `no-store` (L10). Generate list thumbnails with the Images binding.
- **Optional:** Browser Rendering to snapshot PNG previews for email and OG images.
- **Testing:** golden tests against device screenshots. Pass Designer gives the only Apple-accurate preview, and it is Mac-only.
- **Security:** treat every template string as untrusted, and tighten the CSP (L12).

### 5.8 Performance

**Local measurements** (Node 26, Apple Silicon, scratchpad bench, not workerd; production Worker CPUs are probably slower, by an unverified factor):

| Operation | Time |
|---|---|
| `signPass`, full 5.73 MB Henry's bundle | **~28 ms** |
| `signPass`, without `background*` | ~18 ms |
| `signPass`, icons and logos only | ~9 ms |
| `zipSync` STORE (JS CRC-32), standalone | ~25–48 ms (the dominant cost) |
| SHA-1 of all assets | ~5 ms |
| RSA `importKey` | 0.4 ms |
| `personalize` | 0.05 ms |

- **CPU:** `cpu_ms: 10000` (`wrangler.jsonc:77`) is ample. RSA is not the bottleneck: the cost is CRC-32 and hashing, both proportional to bundle size.
- **The real costs are memory and bytes moved:**
  - about 3× the bundle in memory per build
  - 15 static-asset fetches per build
  - a 5.7 MB R2 PUT per version
  - 5.7 MB per device per update
- **Plan, in order of payoff:**
  1. Drop unused image slots and optimise PNGs. This roughly halves the bundle.
  2. Precompute `sha1`/`crc32` per asset at build or upload.
  3. Stream the STORE zip.
  4. Per version, store only `pass.json`/`manifest`/`signature` and assemble on download.
  5. Cache resolved templates and parsed identities per isolate.

### 5.9 Cloudflare products that fit the engine

| Product | Use |
|---|---|
| **R2** | uploaded template assets and signed artifacts |
| **D1** | registry and identities |
| **Static Assets** | baked templates |
| **Secrets Store** | the KEK |
| **Workflows** | upload validation, "activate version → rebuild N passes" fan-out with retries, certificate rotation rollouts |
| **Queues** | existing pushes and email |
| **Images binding** | `.info()` dimension checks, admin thumbnails |
| **Workers Cache / Cache API** | immutable asset responses |
| **Browser Rendering** | optional PNG previews |
| **Containers** | optional multi-identity APNs relay |
| **Analytics Engine** | build size, time and failure metrics per template and identity |

### 5.10 Suggested order (clean slate allowed)

1. Fix H1 (unique keys) and M1 (drop `background.png`), then run the device acceptance test.
2. Add `validatePass()` and move the featuredActions rules into it.
3. Use content-hash versions.
4. Write the TemplateManifest and JSON Schema inputs, and port Henry's to a manifest plus the `venue-locations` plugin. Remove all `henrys` references from core.
5. Build the registry (baked index.json plus D1/R2) and the upload Workflow.
6. Add the identities table with envelope encryption, and the `ApnsTransport` with automated mTLS bindings.
7. Build the generic preview renderer.
8. Add streaming and the virtual pkpass.

---

## 6. Open questions only the owner can answer

1. **Who holds the Apple developer accounts?** Will each organization bring its own Pass Type ID cert and team ("bring your own"), or will the platform sign every pass under its own team with a pass type per org ("hosted")? This decides the identity UX, the APNs strategy and the legal text on the back of the pass. Henry's already shows "Wallet pass service operated by Vlad Zaharia".
2. Whose team is `48H7CLBV8Y`, Henry's or yours?
3. **Expected scale:** how many orgs and signing identities, and how many pass updates per day? This decides automated mTLS bindings versus an APNs relay container.
4. **Who may upload templates:** platform admins only, or org admins too? The answer sets the trust level for regexes, `attributedValue` HTML, `nfc` and plugin selection.
5. Do you need **per-pass images**, such as a member photo thumbnail or per-event artwork? Today, assets are template-only.
6. **Localization:** do org templates need several languages, and do any input values need per-locale variants?
7. **PDF images:** Apple's pass-builder accepts PDF image slots. PNG-only, or also PDF (Wallet support unverified)?
8. **Storage model:** keep a full pkpass per version in R2 (simple and auditable), or assemble on download (≈99% less storage, a little more work per download)?
9. **Activating a template version:** should it automatically rebuild and push every existing pass, or should that be opt-in per pass or batch?
10. Is a small expression language (interpolation, lookups, conditions) acceptable for uploaded templates, or do you want only fixed binding types plus code plugins?
11. **Device test:** can you run the outstanding iPhone acceptance test (posterGeneric, Code 39, featured actions, duplicate keys) now, so the redesign starts from a verified baseline?

---

### Sources (web, checked 2026-10-31)

- [Apple — Creating a Poster Generic Pass](https://developer.apple.com/documentation/walletpasses/creating-a-poster-generic-pass)
- [Apple — Creating a pass with Pass Designer (image table, sizes)](https://developer.apple.com/documentation/walletpasses/creating-a-pass-with-pass-designer)
- [Apple — Building a Pass (SHA-1 manifest, PKCS#7 detached, common problems)](https://developer.apple.com/documentation/walletpasses/building-a-pass)
- [Apple — Adding a web service to update passes](https://developer.apple.com/tutorials/data/documentation/walletpasses/adding-a-web-service-to-update-passes.md)
- [apple/pass-builder (PassImageDescriptor sizes, PassValidator, PassSigner/CMS)](https://github.com/apple/pass-builder)
- [WWDC26 — What's new in Wallet](https://developer.apple.com/videos/play/wwdc2026/209/) · [WWDC Notes summary](https://wwdcnotes.com/documentation/wwdc26-209-whats-new-in-wallet/)
- [los-verdes/card-losverd-es#384 (device test: posterGeneric draws artwork.png)](https://github.com/los-verdes/card-losverd-es/issues/384)
- [passkit-generator#275 (placeIdentifier)](https://github.com/alexandercerutti/passkit-generator/pull/275) · [robdvr/passkit#5 (featured action targets)](https://github.com/robdvr/passkit/pull/5) · [hackclub/attend#263](https://github.com/hackclub/attend/pull/263)
- [Apple Developer Forums 758991 (.p8 vs cert for Wallet push)](https://developer.apple.com/forums/thread/758991) · [129236 (duplicate keys / pass not added)](https://developer.apple.com/forums/thread/129236)
- [Apple archived Wallet Developer Guide (unique field key)](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html) · [passkit-generator API reference (keys pool)](https://github.com/alexandercerutti/passkit-generator/wiki/API-Documentation-Reference/38a7190472f1449fb87518eb307174f0c8c9a291)
- [Cloudflare — Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [mTLS binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/) · [Secrets Store limits](https://developers.cloudflare.com/secrets-store/manage-secrets/) · [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) · [Images binding](https://developers.cloudflare.com/images/optimization/binding/)
