# Platform map for the scanner

Merged from `map-access.md` (tenancy, identity, permissions) and `map-domain.md` (passes, templates, ledger, surfaces). Read those for line-level detail.

Paths are relative to `scratchpad/next` (branch `next/integration`, HEAD `6687b4d`). **n6** = `scratchpad/wt/n6` (`next/n6`, sandbox). **n7** = `scratchpad/wt/n7` (`next/n7`, broadcasts and push budget). n8 was not used. **[U]** = unverified.

## 1. Headlines

1. Leftovers are thin. `scan_code`, `barcode_hash`, `{{pass.scanCode}}`, `scan.*` kinds, the `scanner` event actor and `PassSource` `scan` exist. `/scan` and `/admin/scanners` are empty states. No `modules/scan`, no table, no route. No baked template binds `{{pass.scanCode}}`.
2. The write path for stamps, points and redeem exists: `publishPass` with `mutate`, CAS retry, `source: 'scan'`, ledger and push. A check-in that changes no field builds an identical pass, so it publishes nothing and costs one ledger insert.
3. Two principals exist: cookie session (`admin` or `user`) and bearer API key. No org membership: every `admin` sees every org; a `user` has no org. A scanner needs a new principal kind (paired device) or an org-membership model.
4. Camera and WASM are blocked by CSP and Permissions-Policy today (section 7).
5. Initial bundle has about 5 B headroom (section 8). Everything scanner is a lazy chunk.
6. NFC is blocked on Apple, not code. The platform identity is `nfcEnabled: false` and the validator refuses an `nfc` block without an NFC identity.
7. No outbound webhook exists anywhere.
8. n6 and n7 are unmerged and both touch passes, nav, metrics, `common.ts`.

## 2. Migrations

| No. | File | State |
| --- | --- | --- |
| 0001 to 0009 | foundation, orgs, templates, passes etc. | on `next/integration` |
| 0010 | `0010_events.sql` | on integration. Adds `passes.mode`, `scan_code`, `barcode_hash`, `removed_at`, `pass_events`, `api_keys.mode`, `pass_versions.source`, rebuilt `workflow_runs` and `pass_published` trigger |
| 0011 | `0011_bundles.sql` | on integration |
| 0012 | `0012_identities.sql` | on integration. `apns_keys` (the envelope-encrypted key precedent) |
| 0013 | `0013_broadcasts.sql` | n7, in flight. `workflow_runs.kind` gains `broadcast` |
| **0014** | **`0014_scan.sql`** | **reserved for the scanner; no file** |
| 0015 | `0015_sandbox.sql` | n6, in flight. `captured_emails`, `passes_test_age`, `bundles_test_age` |
| 0016 | n1 file | on integration |

Rules:
- Wrangler applies missing names in any order, so `0014_scan.sql` must not depend on 0013, 0015 or 0016 objects, and must not rebuild a table they touch.
- Never rebuild a table other tables reference (`DROP TABLE` runs an implicit DELETE and cascades). Children exist for `passes`, `pass_events`, `signing_identities`, `credentials`, `bundles`. Safe to rebuild (no children): `audit_log`, `workflow_runs`, `template_imports`.
- `audit_log.actor_type` CHECK is `('user','api_key','system','connection','device')` (`0001_platform.sql:450`). No `scanner`. `AuditActorType` (`modules/audit/types.ts:1`) mirrors it. SQLite cannot alter a CHECK, so a rebuild is needed to add `scanner`; the table has an AUTOINCREMENT id and two indexes (`:459-460`).
- `credentials.kind` CHECK (`pass_signer|connector|webhook`) cannot be rebuilt (referenced). Use a separate table for NFC keys.
- `pass_events.actor_type`, `pass_versions.actor_type`, `passes.pending_actor_type` are free text. `passes.pending_cause` and `pass_versions.cause` are closed CHECK lists (`create, admin, api, connection, user_refresh, template_upgrade, resign`); `source` is free text, closed only in zod (`PassSourceSchema` includes `scan`).
- Guards: `test/migrations.test.ts` (order) and `test/query-plans.test.ts` (every list query needs an index). SQL only in `repo*.ts` (`tools/check-sql-owner.ts`).
- Plan reserved by `docs/design/next-wave.md:305-339` and AGENTS.md row n8: `migrations/0014_scan.sql`, `modules/scan/**`, `src/web/scan/**`, `src/web/routes/scan*`, `src/web/admin/scanners/**`, `src/web/routes/admin/scanners/`.

## 3. Seams

| Need | Where |
| --- | --- |
| New module | `src/worker/modules/scan/{routes,service,repo,jobs,dto}.ts`; one mount line in `src/worker/app.ts`; contracts `src/shared/contracts/scan.ts` re-exported by `contracts/index.ts`. Layering routes, service, repo; no Hono in service; injected clock and ids; `ctx.log.info('event.name', {orgId, code})` |
| Stamp, points, redeem | `publishPass({ cause: 'admin'\|'api', source: 'scan', actor, notify, mutate })` in `modules/passes/publish.ts`. `mutate` re-runs on a fresh row on each of 3 CAS attempts, so increments are safe under contention. After 3 losers: 409 `PASS_CONFLICT` |
| Redeem single-use | void via `status: 'voided'` (`service.ts` `setStatus`), or a claim table with a PK. Only atomic primitives: CAS on `passes.version`, a unique constraint |
| Field ownership | mark changed inputs `manual` in `fieldSources`; connection sync skips `manual` keys (`passes/connection-passes.ts:21-56`) |
| Lookup | `passes.scan_code` (unique partial index `passes_scan_code`), `passes_barcode_hash (org_id, barcode_hash)`, `listPasses` prefix search (`repo-list.ts`) |
| Idempotent replay | `idempotency_keys (org_id, key, request_hash, resource_id)`, `claimIdempotencyKey` / `finishIdempotencyKey` in `passes/repo-ops.ts`. Used by create only |
| Ledger | `recordPassEvent(s)` (`modules/events/record.ts`); kinds and groups in `src/shared/contracts/events.ts`; titles in `src/web/admin/passes/detail/sync-model.ts` (already titles all four `scan.*` kinds; `scan.rejected` is `danger`) |
| Counters | `platform/counters.ts` (`bumpCounter`), or a table in `0014_scan.sql` |
| Template actions | add `scan` to `TemplateManifest` (`src/passkit/types.ts`); validator `scanIssues(manifest, passJson)` beside n7's `src/passkit/template/messaging.ts`, one call in `validateManifest` (`template/manifest.ts`); persist in `modules/templates/package/manifest.ts`. Planned shape: `scan.actions: [{ id, label, kind: check_in\|redeem\|increment\|set, input?, amount?, value?, cooldownSeconds? }]`, default one `check_in` |
| Designer | new `section-scan.tsx` and `ops-scan.ts` in `src/web/admin/templates/designer/`, beside `section-barcode.tsx`; input picker via `inputs.ts` `scalarInputs`. Tests: `designer.test.ts` (pure ops), `designer-ui.test.tsx` |
| Baked templates | `templates/{starter-*,henrys-*}` via `tools/build-templates.ts`. Editing one bumps the version and triggers stale-reissue of every pass (`passes/stale-reissue.ts`, minute cron, 60 s quiet). Built-in templates are read-only in the UI (Duplicate to edit) |
| Pass view and result card | `src/web/pass-card/` (`PassCard`, `PassCardStage`), `src/shared/pass-view/normalize.ts` (derives `expired` and `invalid: 'voided'\|'expired'\|null`; `.pc-void` overlay), `admin/passes/pass-preview.tsx` `usePassView`. New `PassCard` props must be optional (SSR-safe, owned by workstream b) |
| NFC | `PassNfc` (`passkit/schema/pass-types.ts:101`), `validateNfc` (`validate-features.ts`), `signing_identities.nfc_enabled`, new `vas_keys` table following `apns_keys` |
| Auth | new principal kind beside `SessionAuth` and `ApiKeyAuth` in `src/worker/platform/auth.ts` (foundation-owned: coordinate with integration) |
| API shape | `createRouter` + `register(router, tag, spec, handler)` in `platform/openapi.ts`; docs `docs/api.md` and `/api/v1/openapi.json` |
| Rate limits | `wrangler.jsonc` `ratelimits` and `platform/env.ts` `RATE_LIMITS` (compile-time check that all are listed; a missing binding fails closed with 503) |
| Mode | `modeOf(auth)` (`platform/auth.ts:106-113`), `MODE_HEADER = 'x-passbook-mode'`, n6 `src/web/lib/mode.ts` and `ui/layout/mode-{band,pill}.tsx` (band hangs in `AppShell`'s `band` slot) |
| Metrics | `platform/analytics.ts` (`EventName` closed union, add `scan.result`; layout `blobs[event, orgId, templateId, identityId, outcome, mode]`, `doubles[value]`), `contracts/metrics.ts`, `metrics/{repo,analytics-sql}.ts` (AE query plus D1 fallback over `pass_events` `kind LIKE 'scan.%'`) |
| Jobs and cron | `src/worker/jobs/{queue,registry,types,cron}.ts`; daily hooks share `CRON_QUERY_BUDGET` 900. Queue kinds today: `push.deliver`, `email.send`, `pass.refresh`, `connection.webhook` |
| Workflows | `src/worker/workflows/*.ts`. A bulk "check in a list" would be one; single scans are request-scoped |
| Settings | zod objects in `contracts/settings.ts`; org settings `settings.scope GLOB 'org:*'` |
| Audit | `recordAudit(ctx, ...)` or `auditStmt` in the same `db.batch`. Create, revoke, pair, offline-sync batch are audit-worthy; individual scans go to the ledger |
| Admin UI | nav `src/web/lib/nav.ts` (`Scanners`, `ScanLine`, `orgScoped: true`, no `entity`), `lib/entities.ts` (add `scanner`), routes `routes/admin/scanners/*` (add `$scannerId.tsx`, `new.tsx` like `routes/admin/connections/`), pages `admin/scanners/*`, create-with-one-time-secret analog `admin/api-keys/create-key-dialog.tsx` with `ui/secret-reveal.tsx` and `copy-button.tsx`, `ui/typed-confirm-dialog.tsx`, `ui/empty-state.tsx`, `ui/status-pill.tsx`, `ui/tabs.tsx`, `two-pane.tsx`, kit `data-table`, `filter-bar`, `pagination` |
| Scan UI | `src/web/routes/scan.tsx`, `src/web/scan/scan-page.tsx`. Root `beforeLoad` skips the session check for public paths and picks `BareLayout` (`AppShell width="full" holder`, safe-area env insets already handled) |
| Buddy | `src/web/ui/art/{buddy.tsx,registry.ts,presence.ts}`, `scenes/*.css`, budget test `ui/art/art.test.tsx` |
| Outbound | none today. Path: new queue kind in `jobs/types.ts`, `platform/safe-fetch.ts` (HTTPS only, public hosts, no redirects, timeout and size caps), `credentials.kind = 'webhook'` for the secret (today that kind is the inbound HMAC secret) |

## 4. Auth, tenancy, permissions (as built)

- Roles: `RoleSchema = admin|user` (`contracts/common.ts:58`). Roles are not on the user; they are frozen in `sessions.roles` at sign-in (`sessions.ts:83-98`). Group changes apply at next sign-in. OIDC group maps to role in `modules/auth/service.ts:60-68`; magic link grants `['user']`; break-glass `['admin','user']`.
- Session: cookie `__Host-wallet_sid` (`platform/auth.ts:21`), SHA-256 stored. `SessionAuth = { kind:'session', userId, sessionId, roles, csrfSecret, amr, mode }`. Lifetimes: admin 1 h idle and 12 h absolute; user 30 d idle and 90 d absolute; break-glass 30 min and 4 h. CSRF: same-origin plus `x-csrf-token` equal to the session secret on non-safe methods (`platform/csrf.ts:28-39`); `csrfGuard` returns early for non-session kinds.
- API key: `wlt_<8>_<43>`, SHA-256 stored, shown once. `ApiKeyAuth = { kind:'api_key', keyId, orgId|null, scopes, mode }`. Scopes: `passes:read`, `passes:write`, `holders:write`, `templates:read` (`common.ts:52-57`); n7 adds `messages:write`. Fixed at creation. Create and revoke are admin-only. Org must be active. Limit `RL_API_KEY` 600/min per key.
- Guards (`platform/auth.ts`): `requireSession` (90), `requireAdmin` (97, sets mode from header), `requireApiKeyOrAdmin(scope)` (132), `methodScope` (124; read vs write by HTTP method only), `assertOrgAccess` (156; restricts only org-scoped keys), `modeOf`, `currentUserId`. `reportDenied` audits `FORBIDDEN`, `CSRF_*`, `MISSING_SCOPE` for users and keys only (capped 500 rows/h).
- Org scoping helpers `modules/passes/http.ts`: `orgScopeOf(c)` (admin and platform key return null = all orgs), `assertOrg`, `actorFor` (folds `device` into `system`, line 28-32).
- Org status: `isOrgActive` (`modules/orgs/active.ts:5`) is used by Apple, webhooks, connection jobs, key resolve. Not by `/p` or API pass routes.
- No org membership anywhere. `/admin` org picker is a list filter, not a permission boundary. Admin web guard is client-side only (`src/web/lib/guards.ts`).
- Holders: no separate principal; a holder is a `user` session owning passes via `passes.owner_user_id`. `holder` exists as an event actor type, unused.
- Mode: `Mode = live|test`, immutable per pass; set on `passes`, `api_keys`, `pass_events`, `bundles`, n7 `broadcasts`. Admin mode comes from the `x-passbook-mode` header; key mode from the key row. Lists and aggregates filter by mode; **by-id gets and writes do not** (n6 says so on purpose, `n6:modules/sandbox/service.ts:51`). A scanner must compare its mode to the pass mode itself. Test passes: no mail, daily purge after `sandbox.purgeDays` (default 30), purge cascades to `pass_events`. Connection-synced passes are always live.
- Routes of note: passes, bundles, holders use `requireApiKeyOrAdmin`; templates write is `requireAdmin` only; orgs, users, api-keys, settings, audit, status, metrics, identities, delivery, connections are `requireAdmin`; `/api/v1/me/*` is `requireSession`; `/wallet/v1/*` is per-pass `ApplePass` token; `/p/:token`, `/b/:token` are bearer links.
- Web guard `isPublicPath` returns true for `/login` and `/scan` by **exact match**. `/scan/history` would not be public.

### Rate limits (`wrangler.jsonc:119-133`, `platform/env.ts:33-41`)

| Binding | Limit | Id | Use |
| --- | --- | --- | --- |
| `RL_LOGIN` | 10/60s | 1001 | OIDC, magic consume, break-glass |
| `RL_MAGIC_LINK` | 5/60s | 1002 | magic requests |
| `RL_PUBLIC` | 120/60s | 1003 | `/p`, `/b` |
| `RL_APPLE` | 120/60s | 1004 | per device and pass |
| `RL_API_KEY` | 600/60s | 1005 | per key |
| `RL_WEBHOOK` | 120/60s | 1006 | inbound hooks |
| `RL_REFRESH` | 3/60s | 1007 | refresh, APNs check, n6 send-to-me |
| `RL_APPLE_IP` | 3000/60s | 1008 | `/wallet/v1` per IP |
| `RL_PUBLIC_ASSET` | 240/60s | 1009 | `/p`, `/b` assets |

Next free id: 1010. Admin sessions have no general API limit. A busy door does not fit 600/min per shared key, and 120/min per IP is too tight behind venue NAT. A scanner needs its own bindings: strict per IP for pairing, high per device for scans, a per-org ceiling.

## 5. Pass, template, ledger facts

- `passes`: `id` UUIDv7, `org_id`, `identity_id`, `serial`, `mode`, `status active|voided`, `removed_at`, `deleted_at`, `version` (CAS), `revision`, `scan_code` (26 base32 chars, 128 bit; NULL on old rows until next publish, lazy backfill at `publish.ts:98`), `barcode_hash` (SHA-256 of `barcodes[0].message` as UTF-8, else legacy `barcode.message`, rewritten every publish, non-unique, not in any DTO), `personalization`, `field_sources`, `holder_email`, `owner_user_id`, `external_id`, `display_title`, `display_subtitle`.
- `scan_code` is globally unique, not org-scoped. Lookup must filter by scanner org and mode first so there is no existence leak. Neither code nor barcode is an authenticator: a screenshot works. `barcode_hash` of a low-entropy message (`TICKET-0001`) is not secret.
- Expiry is not a column. It lives in `pass.json` (`expirationDate`, `voided`) and is evaluated at read time; nothing flips a pass at expiry. Compute `expired` from current `pass_json` with the `normalize` logic, not from `status`. Soft-deleted rows are hidden by `getPass`.
- Removed passes (`removePass`, `remove-build.ts`) are voided, stripped of barcodes, locations, nfc, and get `barcode_hash` NULL. `scan_code` stays, so lookup by code can answer "Removed" where lookup by barcode cannot.
- Barcode message today: starters bind `{{ticketId}}`, `{{code}}`, a card number. Duplicate `ticketId` values are possible. The designer can bind `{{pass.scanCode}}` (`designer/bindings.ts` `SCAN_CODE`); preview value `PREVIEW2PASS3SCAN4CODE5XYZ` (`modules/templates/build-check.ts`). Existing passes keep old messages until reissued. Message encoding defaults to `iso-8859-1`; a decoder's bytes may hash differently from the UTF-8 text for non-ASCII, so normalise both sides.
- Barcode formats (`passkit/schema/constants.ts`): QR, PDF417, Aztec, Code128, Code39, Codabar, EAN-13, I2of5. The last four are iOS 27 only. Decoder must read QR, PDF417, Aztec, Code128 at minimum.
- Manual lookup gap: `listPasses` `q` is a NOCASE prefix search over `display_title`, `display_subtitle`, `external_id`, `holder_email`, plus exact `serial`. No lookup by `scan_code`, `barcode_hash`, last-4 of a card number or phone. Inputs flagged `x-search` feed display fields only.
- Versions: each publish is one R2 put plus about 6 D1 writes; retention keeps current plus 3 (`retention.passVersionsKeep`).
- `Actor` types: `modules/passes/service.ts` has `user|api_key|system|connection`; `platform/context.ts` adds `device`; `EventActorTypeSchema` has `holder` and `scanner`. `broadcasts/apply.ts` (n7) shows narrowing an Actor to `ACTOR_TYPES`.
- Ledger `pass_events (id, org_id, pass_id CASCADE, mode, kind, device, actor_type, actor_id, data JSON, at)`; indexes `(pass_id, at DESC, id DESC)`, `(org_id, kind, at DESC)`, `(at)`. `recordPassEvent` never throws. `sanitizeEventData` drops keys matching `email|token|secret|password|authorization|cookie|personali[sz]|pushtoken|credential`, drops email-like strings, truncates strings to 300, depth 3, 20 array items, 2048 B total (else `{truncated:true}`). Device is a 12-hex hash. **Do not put holder names or emails in scan event data.** `EVENT_KINDS` is a closed enum with four `scan.*` kinds; reasons fit in `data.reason`, undo and manual lookup have no kind. `EVENT_GROUPS` (`delivery`, `devices`, `changes`) has no `scans` group. Sync log reads `data.status|reason|line|version`.
- Ledger limits: retention `retention.eventsDays` default 90 (min 7) with a daily purge; one D1 writer, so a busy door is many inserts; a per-event counter has no column (`data.eventId` is JSON, unindexed); no first-scan-wins primitive; pass delete or test purge deletes scans (CASCADE).
- Bundles (`0011`, `modules/bundles`): one link, 1 to 10 member passes, each with its own `scan_code`. `bundle_passes_pass` index allows "In bundle" on a result.
- Holder pages: `/p/:token` (SSR `src/worker/ssr/pass-page.tsx`) and the portal draw the barcode with `PassCard`, so a scan code is visible to anyone with the link. Generated SSR CSS and tokens are guarded by `tools/ssr-parity.test.ts`.
- Admin detail DTO sets `assetBaseUrl` to `/p/{downloadToken}/assets/` (`passes/detail.ts:81`). A scanner result card must not receive a download token.
- Metrics: AE dataset `wallet_events` (binding `EVENTS`), SQL via `ANALYTICS_SQL` (remote only, absent in tests and local) with D1 fallback. AE has a 250 data-point-per-invocation limit and sampling: charts only, never counters.
- Connections: `ConnectorDefinition` (`connectors/types.ts`), inbound `POST /hooks/connections/:id` HMAC with replay window. Scans on a connection-bound pass mark inputs `manual` so a poll does not undo them.

### n6 and n7 effects

- n7 push budget: 3 notifying `pass.updated` events per pass per 24 h (`push.budgetPerDay`, default 3, 0 to 50), counted from `pass_events` where `data.notified = 1` (`n7:modules/passes/repo-budget.ts`, `change-messages.ts:79-97`). All sources count, scans included. Over budget: the build is made silent (`silent: true` strips every `changeMessage`), the event gets `overBudget: true`, `PublishResult.silenced = true`; the update still publishes and pushes. `PublishOptions.notify`: `undefined` keeps the template's messages, `true` adds `%@` for changed fields, `false` strips all. A scan action needs `notify: false` so counters never burn the 3 slots.
- n7 `messages:write` is a per-capability scope, API-key only. n7 adds `manifest.messaging = { input }` and `src/passkit/template/messaging.ts`, `modules/broadcasts/apply.ts` (publish many with `dispatch: false`, `dispatchSafely` per chunk of 100).
- n6: `/scan` is outside the admin layout, so it sends no mode header unless it sets one. The scanner must carry its own mode, refuse mismatches with a distinct reason, and write `pass_events.mode` from the pass. Test scanners need a visible band. n6 adds `captured_emails`, `/api/v1/test-inbox`, `localStorage` key `passbook-mode`, SSR ribbon on `/p` and `/b`.

## 6. NFC and signing

- `PassNfc { message (<= 64 bytes), encryptionPublicKey (base64 SPKI P-256), requiresAuthentication? }`. `validateNfc` errors `NFC_NOT_ENTITLED` unless `identity.nfcEnabled`.
- Platform identity `pass.im.plrs.wallet`, team `48H7CLBV8Y`, cert expires 2027-11-30, `readEnvIdentity` hard-codes `nfcEnabled: false`. DB identities carry `signing_identities.nfc_enabled`, set by an admin; nothing verifies the certificate actually has the NFC entitlement [U: marker is under NDA].
- Needs an Apple NFC-entitled Pass Type ID (2 to 8 weeks, VAS-certified terminal) and a **new** signing identity. Passes keep their identity forever, so NFC applies to new passes only.
- `docs/security.md:17,68`: keep NFC off on every identity until the personalization fix is deployed; NFC identities must not use caller-chosen or guessable serials.
- The reader private key never signs passes and is not needed by the Worker unless it decrypts taps. Prefer not to store it; if stored, envelope-encrypt (`platform/crypto.ts`, AAD `credentialAad`) like `apns_keys`. KEK rotation does not cover `apns_keys`, so a new table inherits the gap.
- Scan code is 26 chars, so it fits in the 64-byte NFC message.
- Personalization (`modules/apple/personalize*.ts`) is modelled for NFC reward cards only.

## 7. CSP and security headers

`src/worker/platform/security-headers.ts` and `public/_headers` must agree (`security-headers.test.ts` fails on drift).

- Worker, API and SSR responses: `default-src 'none'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; style-src-attr 'unsafe-inline' (SSR only); img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests`.
- Static SPA (`public/_headers` `/*`): same, plus `https://challenges.cloudflare.com` in `script-src` and `frame-src` (Turnstile), and `object-src 'none'`.
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()` everywhere. Also HSTS, nosniff, COOP and CORP same-origin, XFO DENY, `noindex`, `no-store` for `/api/` and `/auth/`.
- SPA fallback: `app.ts` `spaPage()` serves any GET not in `WORKER_ONLY = /^\/(api|auth|wallet|p|b|hooks|assets|health)(\/|$)/` and without a dot from `ASSETS`. `/scan` HTML therefore gets `public/_headers`, not the Worker middleware.
- `NO_REFERRER_PREFIXES`: `/p/`, `/b/`, `/auth/`.
- Inline `<style>` and `<script>` are blocked; `vite.config.ts` patches sonner and Radix. A library that injects styles at runtime fails the same way.

What blocks a scanner:
1. `camera=()` denies `getUserMedia`. Needs `camera=(self)` on `/scan` only, in both `_headers` and `security-headers.ts`.
2. No `'wasm-unsafe-eval'`: WebAssembly cannot compile, so `zxing-wasm` fails. Add on `/scan` only, or use `BarcodeDetector` or pure JS. The `.wasm` must be same-origin and fetched, not `data:`.
3. `worker-src` falls back to `default-src 'none'`: a decode worker or service worker needs `worker-src 'self'` (and `blob:` for blob workers). Main-thread decoding needs none.
4. No service worker exists (no Workbox). A cold offline start has no app shell. IndexedDB works under the current CSP, so a queue survives once the page has loaded.
5. `<audio src>` needs `media-src`; WebAudio synthesis needs nothing. `navigator.vibrate` is unsupported on iOS Safari [U].
6. Wake lock and fullscreen need no policy change. Keyboard-wedge readers need none; `usb=()` blocks WebUSB, which is not needed.
7. `__Host-` cookies need `Secure`, `Path=/`, no `Domain`: compatible with a scanner cookie.
8. Camera cannot run in CI; the decoder needs an injectable seam.
9. Headers are foundation-owned (AGENTS.md): changes go through the integration agent.

## 8. Budgets

| Budget | Value | Where | State |
| --- | --- | --- | --- |
| Initial web load (entry plus modulepreloads), gzip | **228,500 B** | `tools/check-bundle.ts` `BUDGET_BYTES` | `next/dist/client/index.html` measured 228,495 B, about **5 B headroom** (dist may be stale; re-measure after `vite build`). n6 and n7 lazy-load their routes but touch `routeTree.gen.ts` and `nav.ts` |
| Forbidden in initial chunks | `cmdk-`, `getRowModel`, `measureElement` | same | admin-only libraries |
| Art kit | <= 15 kB gzip (CSS and TSX of `ui/art/*` except states and scenes, plus `scenes/rest.css`) | `ui/art/art.test.tsx` ~line 305 | |
| Buddy scenes (lazy, registry chunk) | <= 8.75 kB gzip; `scenes/*.css` raw total 51,367 B | `art.test.tsx` | Every scene file must be imported by `ui/art/registry.ts` (test checks). Past raises were 0.75 to 2 kB steps with a comment. Headroom not measured [U] |
| State parts | <= 2.5 kB | `art.test.tsx` | sign-in and SSR only |
| Art per entity | <= 40 SVG nodes | `motion-and-expression.md:316` | |
| Motion | `motion.css` + `stage.css` <= 4 kB gzip; art <= 8 kB; motion hooks <= 1.5 kB | `motion-and-expression.md:449` | |
| File size | soft 300, hard 330 lines | `tools/check-sizes.ts` | |
| Dependencies | exact pins, versions at least 2 weeks old | `next-wave.md` | `zxing-wasm`: WASM plus glue, hundreds of kB raw; load only on `/scan` after first frame |

Existing scenes: `search` (+`-beats`, `-steps`), `inspect`, `sweep`, `mend`, `tug`, `plug`, `peek`, `flip`, `cheer`, `wave`, `tear`, `nudge`, `tuck`, `count`, `face`, `hello`, `rest`, `common`. Reuse before adding: `cheer` (check-in), `tear` (voided), `peek` (not found), `tuck`, `count`, `nudge`, `wave`, `inspect`.

Buddy rules: one buddy per view via `ui/art/presence.ts` `useRegisterBuddy` (toasts check it); sits on a real bordered surface (`Buddy size at scene`); scenes play once, 700 ms after landing and when 60% in view, at most 3.2 s (search 4 s), end on the rest pose; transform and opacity only; reduced motion shows the final pose. The n8b result beat (<= 700 ms, cut off by the next scan) is shorter than any scene (min 1.8 s) and `useScene` starts after 700 ms, so a scanner needs a beat API that starts at once (`Buddy.replay` counter exists) plus its own timing test. Control sizes: 14 px text, 36 px controls, 44 px and 16 px field text on touch.

## 9. Leftovers: verdicts

| Leftover | Verdict |
| --- | --- |
| `passes.scan_code` and `passes_scan_code` | Keep. Add a backfill: a job or mint-on-lookup (SQLite has no base32 formatter; hex from `randomblob` would not match the app format) |
| `passes.barcode_hash` and index | Keep for templates whose barcode is not the scan code. Handle ambiguous hits; keep out of DTOs |
| `{{pass.scanCode}}` | Keep. Switch starters to it (not done) |
| `scan.checked_in|redeemed|adjusted|rejected` | Keep; reasons in `data.reason`. Consider new kinds for undo and manual lookup, plus a `scans` event group |
| `scanner` and `holder` event actors | Keep. Extend the two TS `Actor` types; `audit_log` CHECK needs a rebuild or audit as `device` |
| `PassSource` `scan` | Keep |
| `/scan`, `/admin/scanners`, nav entry | Replace. Review `isPublicPath` exact match and `BareLayout` |
| Migration 0014 | Use for the scanner |
| `docs/design/next-wave.md:305-345` | Predates the research; lacks amber state, reasons, undo, wedge input, camera-denied path |

## 10. Gaps for a scanner

Each is a decision or build item the design must cover.

**Principal and access**
1. **Scanner principal.** No device identity. Needs a third `AuthContext` kind (`scanner`) that never satisfies `requireAdmin`. Plan: `__Host-wallet_scan` cookie, 256-bit token hashed, 180 d, revocable, one org, one mode. Cookie needs its own CSRF rule (`csrfGuard` skips non-session kinds); alternative is a bearer token in IndexedDB. Pairing code needs strict per-IP limiting. Refused scanner tokens need their own denied-audit path (`reportDenied` ignores them).
2. **Shared device model.** Admin sessions idle out in 1 h (wrong for a door shift), user sessions last 30 d (wrong for a lost phone), and `sessions` has no device name or last-seen. Needs per-device name, `last_seen_at`, org, mode, allowed templates, revoke, rotation, kill switch in `/admin/scanners`.
3. **Org staff.** No membership table. Cashiers cannot be `admin` (cross-tenant) and as `user` have no org. Choose: device-only principal, or `org_members(org_id, user_id, role)` with `requireOrgRole`. Magic-link users already fit staff without Pocket ID. D1 membership also fixes frozen session roles.
4. **Operator attribution.** A device principal leaves staff unidentified. Options: PIN or operator picker per action.
5. **Admin scanning.** An admin's session is unscoped (`orgScopeOf` returns null), so the scan screen must make them pick an org and check it against the pass. Mode comes from the header. The 1 h idle breaks a shift.
6. **Per-action rights.** Only read and write exist. Needs capabilities (`lookup`, `check_in`, `redeem`, `increment`, `set`, `undo`) enforced server-side from the template `scan.actions`, with max amount, cooldown, undo window, and a manager override or PIN for `set` and `undo`. A compromised tablet must not rewrite balances.
7. **Per-template, per-venue, per-time limits.** No venue or location concept exists. Needs `scanners.template_ids`, optional venue label, time windows (event start and end), per-field checks (ticket date). Branch A must not redeem branch B's coupon.
8. **POS and third parties.** API keys are the only machine principal and `passes:write` is broader than redeem. No scan endpoint, no scan idempotency, no per-terminal rate class, no outbound webhook. Needs scopes `scan:lookup`, `scan:redeem`, `scan:adjust`, template-restricted keys, `Idempotency-Key`, a per-key limit sized for tills, and an event feed or webhook; mark POS scans (`actor_type` api_key, source `pos`).
9. **Rate limits.** New `RL_*` bindings (pairing per IP, scan per device, per-org ceiling), ids 1010+, in `wrangler.jsonc` and `env.ts`. Per-code limits to blunt enumeration.

**Correctness**
10. **Lookup.** Scan by `scan_code` (org and mode filtered first, no existence leak), by `barcode_hash` (ambiguous hits refused), and manual by member number, phone, last-4, name: needs an indexed column or convention. NULL `scan_code` on dormant passes.
11. **Mode and tenant checks.** By-id access ignores mode; the scanner must compare modes and emit `scan.rejected` with a reason. Must also check `isOrgActive`, `status`, `removed_at`, `deleted_at`, expiry from `pass_json`, not-yet-valid. A suspended org's scanner should say so.
12. **Single-use atomicity.** Two doors, one ticket. Ledger has no unique constraint; needs a CAS void, or a claim table `(pass_id, action_id)` PK, or both. Duplicate detection ("already in, 2 min ago") reads the last scan via `(pass_id, at DESC)`.
13. **Offline replay.** No service worker, no offline shell, no scan idempotency. Needs a client scan id, IndexedDB queue, batch sync with conflict outcomes and audit, `worker-src` decision, cold-start story.
14. **Undo and outcomes.** Kinds do not cover duplicate, wrong org, mode mismatch, voided, expired, removed, not yet valid, over limit, undo, manual lookup. Define reasons and whether new kinds are needed.
15. **Counters.** "412 of 600 in" needs a per-event dimension. Options: `platform/counters.ts`, a table in `0014`, or `count(*)` over `(org_id, kind, at)` with unindexed `data.eventId`. D1 single-writer load at a busy door.
16. **Proof retention.** Ledger default 90 days (min 7) deletes check-in proof; CASCADE removes scans with the pass. Decide a retained scan table or a longer setting (owner call).
17. **Push budget.** Scans share n7's 3-per-24 h notifying budget. Scan actions need `notify: false` or an explicit choice. Every state change is a version, R2 put and about 6 D1 writes.
18. **Field ownership.** Scan changes must mark inputs `manual`; who owns a counter on a connection-bound pass is a product call (owner call). No outbound write-back exists.
19. **Actor and audit.** Extend both `Actor` types with `scanner`; rebuild `audit_log` (safe, no children) or audit as `device`. `actorFor` currently folds `device` into `system`, and `pending_actor_*` and `pending_source` carry the actor into versions.
20. **Template `scan` manifest.** Type, validator (numeric input for `increment`, `set` value fits the schema, cooldown bounds, `redeem` needs a void or expiry path), persistence, designer section, starter updates (stale-reissue of all passes on a baked change).
21. **Decoder and barcode semantics.** No decoder in the repo (`bwip-js 4.11.4` is encode-only, and encoders live only in `shared/pass-view/barcode-svg.ts`). Choose `BarcodeDetector` or `zxing-wasm` (needs `'wasm-unsafe-eval'`, a lazy chunk). Formats: QR, PDF417, Aztec, Code128 minimum. Hash normalisation per `messageEncoding`. Keystroke-wedge input path.
22. **Result card.** Needs a scanner-scoped asset route (`/api/v1/scan/passes/{id}/assets/{name}`) built on `getPassAsset` and `brandingFiles` (`modules/public/*`), not a download token. Hide the barcode on the result card via an optional `PassCard` prop. Show bundle membership and last 3 scans.
23. **NFC.** Ship as data-only and off by default. Needs an Apple entitlement and a new identity, a `vas_keys` table (public key beside identity; private key only if the Worker decrypts), `buildArtifact` input injecting `nfc` with the scan code, and the `docs/security.md` serial rule. Owner call on the Apple application.
24. **Outbound.** No webhook or write-back. Roster export for offline seeding is likely more useful than a webhook.
25. **Metrics.** Add `scan.result` to `EventName`, scan totals and series to `MetricsOverviewSchema`, both an AE query and a D1 fallback. Platform-wide totals scan, so cache.
26. **Holder side.** Optional "Last used" from the ledger via a `me` endpoint; holders see the barcode in clear on `/p` and the portal.

**Platform and UI**
27. **Headers and CSP.** `camera=(self)`, `'wasm-unsafe-eval'` and maybe `worker-src 'self'` scoped to `/scan`, in both `_headers` and `security-headers.ts`; foundation-owned, via integration. Consider `/scan` in `NO_REFERRER_PREFIXES`. Never put a code in the URL.
28. **Bundle headroom.** About 5 B. Route, nav, entity and mode band additions must stay lazy, or the budget needs an owner-approved raise.
29. **Buddy beat.** Immediate-start beat API and its timing test; scene bytes inside 8.75 kB (headroom unmeasured); reuse existing scenes first; `useRegisterBuddy` so one buddy shows. New scenes named in n8b (punch hole, wrist tap, notepad, "Test" sign, camera-cover) each cost bytes.
30. **Routes and guards.** Widen `isPublicPath` beyond exact `/scan`; a full-screen scanner shell (safe areas exist in `AppShell`); `Scanners` nav needs an `entity` and art; admin pages follow the list, dialog-with-secret and tabbed-detail patterns.
31. **Docs and tests.** `docs/api.md` plus OpenAPI per route; tenant-isolation and mode tests per route; designer tests; e2e; refresh the n8 section of `next-wave.md` with the research deltas (amber state, reasons, undo, wedge input, camera-denied path).
32. **Logging.** A scan code is capability-like: never log it; log the pass id.

**Owner calls (everything else is decidable in design)**
- NFC Apple application and timeline.
- Counter ownership on connection-bound passes.
- Retention of check-in proof beyond 90 days.
- Whether foundation-owned files change (`audit_log` CHECK, `Actor` types, `_headers`, `security-headers.ts`, `platform/auth.ts`).
- Whether to raise the initial bundle budget.
