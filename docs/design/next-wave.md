# Next wave: build spec

Status: approved by the owner on 2026-11-04 ("execute on this vision"). Calls marked **(lead)** were made by the team lead.
Read with `AGENTS.md` and `docs/design/platform-architecture.md`. This file wins where they differ.

## Scope

| # | Feature | Stream |
| --- | --- | --- |
| 1 | Sync log and device details | n1 |
| 2 | Remote remove | n1 |
| 3 | Own Apple identity, push without a deploy | n2 |
| 4 | Multi-event passes (`upcomingPassInformation`) | n3 |
| 5 | Beacons | n3 |
| 6 | Pass bundles outside the portal | n4 |
| 7 | Template designer | n5 |
| 8 | Sandbox (test) mode | n6 |
| 9 | Broadcasts and scheduled changes, with a push budget | n7 |
| 10 | Scanner | n8 |

Not in scope: Android shims (WalletPasses, PassWallet). Google Wallet comes later as a native integration, so keep
the pass model wallet-neutral where it costs nothing. Also out: org-scoped admin roles, loyalty programs beyond the
scanner's increment and set actions, and billing.

## Order

1. **Foundation** (one stream, `next/foundation`): shared schema, event ledger core, mode plumbing,
   placeholders and ownership. The other streams branch from it.
2. **Wave 1**, in parallel: n1, n2, n3, n4, n5.
3. **Wave 2**, in parallel after wave 1 merges: n6, n7, n8.
4. Final review by specialists, then fixes, then merge to `main`.

Each stream works on its own branch `next/<stream>` in its own worktree, branched from `next/integration`. The
integration lead merges.

## Shared decisions (foundation builds these)

### Migration numbers

| File | Owner |
| --- | --- |
| `0010_events.sql` | foundation |
| `0011_bundles.sql` | n4 |
| `0012_identities.sql` | n2 |
| `0013_broadcasts.sql` | n7 |
| `0014_scan.sql` | n8 |
| `0015_sandbox.sql` | n6 |
| `0016_sync.sql` | n1, only if needed |
| `0017_designer.sql` | n5, only if needed |

Never rebuild a table that other tables reference. `DROP TABLE` runs an implicit `DELETE` that fires
`ON DELETE CASCADE` on children. Where a `CHECK` list must grow and the table has children, add a new nullable
column or a new table instead. `workflow_runs`, `template_imports` and other tables with no children may be rebuilt,
as `0002_templates.sql` did.

### `0010_events.sql`

- `pass_events` columns:
  - `id` TEXT PK, UUIDv7
  - `org_id`
  - `pass_id` REFERENCES passes ON DELETE CASCADE
  - `mode` `live|test`
  - `kind`
  - `device` (short device hash or NULL)
  - `actor_type`, `actor_id`
  - `data` JSON, default `{}`
  - `at` ms

  Indexes: `(pass_id, at DESC)`, `(org_id, kind, at DESC)`.
- `passes` gains these columns:
  - `mode TEXT NOT NULL DEFAULT 'live'`
  - `barcode_hash TEXT`: SHA-256 hex of the primary barcode message, set on every publish. Index it on
    `(org_id, barcode_hash)`.
  - `scan_code TEXT`: an unguessable code, 128-bit base32, created with the pass and bindable in templates as
    `{{pass.scanCode}}`. Unique partial index.
  - `removed_at INTEGER`
  - `pending_source TEXT`
- `pass_versions` gains `source TEXT`. The publish trigger copies `pending_source` into it, next to `cause`. Sources
  are free text, validated in the app: `scan`, `broadcast`, `schedule`, `remove`, `restore`, `designer`. Keep `cause`
  inside its existing CHECK list: scan, broadcast, schedule, remove and restore use cause `admin` or `api` by actor.
- `api_keys` gains `mode TEXT NOT NULL DEFAULT 'live'`.
- `workflow_runs.kind` gains `broadcast`. Nothing references `workflow_runs`, so rebuild it.
- Backfill `scan_code` for existing passes, or have the app create it lazily on next publish.

### Event ledger (`modules/events`, foundation, then n1 owns it)

- `recordPassEvent(ctx, { orgId, passId, mode, kind, device?, actor?, data? })` never throws into the caller. It
  logs `events.record_failed` with a code. `recordPassEvents` handles batches.
- `GET /api/v1/passes/{id}/events?kind=&cursor=&limit=` takes the `passes:read` scope and returns newest first.
- Kinds are a closed zod enum in `src/shared/contracts/events.ts`. Define all of these now:
  - `pass.issued`, `pass.updated`, `pass.voided`, `pass.unvoided`, `pass.removed`, `pass.restored`,
    `pass.link_rotated`
  - `email.queued`, `email.sent`, `email.failed`, `email.captured`
  - `page.opened`, `pass.downloaded`, `bundle.opened`, `bundle.downloaded`
  - `device.registered`, `device.unregistered`, `device.fetched`, `device.log`
  - `push.queued`, `push.sent`, `push.failed`
  - `scan.checked_in`, `scan.redeemed`, `scan.adjusted`, `scan.rejected`
  - `message.applied`, `schedule.applied`
- `data` never holds emails, tokens, push tokens or personalization values. Device ids are stored as the first 12
  hex characters of `SHA-256(device_id)`.
- Retention defaults to 90 days through a `settings` key, enforced by a daily cron hook.

### Mode (sandbox plumbing)

- `AuthContext` gains `mode: 'live' | 'test'`.
  - An API key's mode comes from `api_keys.mode`.
  - An admin session reads the `x-passbook-mode: test` header; anything else means live.
  - A user (holder) session has no mode filter: holders see all their passes, and test ones carry a badge.
- A pass's mode is set when the pass is created, from the creator's mode. Connection syncs always create live passes.
- Every admin or API **list or aggregate** filters by the caller's mode: passes, metrics, bundles, broadcasts, scans
  and anything new. A **get by id** works in either mode and returns `mode` so the UI can badge it.
- Safety default: an email for a test-mode pass is never sent. Until n6 adds the test inbox, the outbox row ends
  `cancelled` with `error_code` `TEST_MODE`, and the ledger gets `email.captured`.
- Contracts: `ModeSchema` in `common.ts`. `mode` is added to the pass, API key and event DTOs. Creating an API key
  accepts `mode`.

### Placeholders and ownership

- Add nav entries and placeholder pages: **Messages** `/admin/messages` (n7), **Scanners** `/admin/scanners` (n8),
  and the staff app `/scan` (n8, outside the admin layout). Placeholders are an empty state, nothing more.
- Add rows n1–n8 to the AGENTS.md ownership table, using the paths in this file.

## Streams

Each stream owns the paths listed. "Touches" lists shared files it may edit in small, additive ways. The
integration lead resolves conflicts there.

### n1: Sync log, device details, remote remove

Owns: `modules/events/**`, `modules/apple/**`, the event hooks in `modules/delivery/{push,email,jobs}.ts`,
`modules/passes/remove*.ts`, and `src/web/admin/passes/detail/**` (devices and activity).
Touches: `modules/public/routes.ts` (open and download events) and `modules/passes/{service,routes}.ts`.

- **Record events** at every point listed under the kinds above:
  - apple: register, unregister, latest-pass fetch with 200 or 304 and the version served, and log lines;
  - delivery: push queued, then sent or failed per device with HTTP status and APNs reason; email sent or failed;
  - passes: issue, update (version, cause, source, `notified` true or false), void and unvoid, link rotation;
  - public: page open and `.pkpass` download.
- **Device log lines:** Apple's log endpoint carries no device or pass. When a line names a serial of that identity,
  attach it to that pass (`device.log`, with the line redacted and capped). Otherwise keep it identity-level, as today.
- **Devices tab on pass detail**, one row per registration:
  - short device id, registered time;
  - last fetch: time, version, 200 or 304;
  - last push: time, result, APNs reason;
  - a status pill: *Up to date* (fetched version = current), *Waiting* (pushed after the last fetch), *Push failing*,
    or *Removed from device* (unregistered).
- **Sync log tab:** a timeline from the ledger with filters for All, Delivery, Devices and Changes, newest first,
  paged. A grouped row reads like "Pushed v7 to 2 devices · 1 fetched in 12 s · 1 Unregistered". Use the entity art
  and motion rules, and keep copy terse.
- **Remote remove.** Apple has no API to delete a pass from a device. First verify current behavior on the web and
  record the sources in `docs/research/remote-remove.md`: what iOS 18 to 27 does with `voided` and a past
  `expirationDate`, and the Expired passes and hide-expired behavior. Then build:
  - `POST /api/v1/passes/{id}/remove` `{ message? }` (`passes:write`), the admin action **Remove from Wallet** on pass
    detail, and a bulk action.
  - It publishes a final version with:
    - `voided: true` and `expirationDate` set to now;
    - no barcodes, `locations`, `beacons`, `relevantDates`, `featuredActions` or `nfc`;
    - an optional message on a back field with a `changeMessage`.

    It then pushes, sets `removed_at`, writes `pass.removed`, and uses source `remove`.
  - The admin shows progress per device: "Removed on 1 of 2 devices" means fetched after removal.
  - **Restore** reverses it: it republishes the current input with source `restore` and writes `pass.restored`.
  - UI copy states the limit in one sentence: the pass moves to Expired passes in Wallet, and the holder can delete
    it there.
- Add the events retention cron hook.

### n2: Own Apple identity, push without a deploy

Owns: `modules/identities/**`, `modules/delivery/apns*.ts`, and `src/web/admin/identities/**`.

- APNs token auth with a `.p8` key works for Wallet passes, with the Pass Type ID as the topic (catalog §21).
- New table `apns_keys` (`0012`): `id`, `team_identifier` UNIQUE, `key_id`, the envelope fields from
  `platform/crypto.ts`, `created_by`, `created_at`, `rotated_at`. Do not reuse `credentials`, because its kind CHECK
  is closed. One key serves every identity of that team.
- Transport: `createApnsTransport` tries the identity's mTLS binding first, then the team's push key. The key path
  signs an ES256 JWT with WebCrypto (`{alg: ES256, kid}`, `{iss: team, iat}`) and caches it per isolate for
  20–50 minutes. It sends `authorization: bearer`. Keep the same per-device result handling.
- Admin identities:
  - A **Push** section shows the method (Certificate binding / Push key / Not set up), an upload of `.p8` plus key ID
    (the team comes from the identity), rotate and remove, and the existing APNs probe for either method.
  - When an identity is uploaded, prompt for a push key when its team has none.
- Status and expiry checks report push per identity honestly.
- Risk to call out in the report: APNs needs HTTP/2. The mTLS binding already works in production. The plain-fetch
  path must be proven by the probe after deploy, so log a clear code on failure.

### n3: Multi-event and beacons

Owns: `src/passkit/behaviors/{upcoming-events,beacons}/**`, `templates/starter-*`, `src/shared/pass-view/**`,
`src/web/pass-card/**`, `src/web/admin/passes/schema-form/**`.

- The expression language has no loops, so arrays come from **behavior plugins** configured in the manifest.
- `upcoming-events`:
  - maps an input array of events (name, start, end, venue, optional URLs and image keys) to
    `upcomingPassInformation`;
  - enforces the catalog's limits, and `validatePass` still runs;
  - drops past events.
- `beacons`:
  - static beacons from config, plus an optional input array (`proximityUUID`, `major`, `minor`, `relevantText`);
  - capped at 10, with UUIDs validated.
- Schema form: an editor for arrays of objects (`x-widget: list`) with add, remove and reorder, fields from `items`,
  per-row validation and keyboard support. It is used in the new-pass wizard and on the Fields tab.
- Renderer: PassCard shows upcoming events on the event-ticket back, approximating Wallet's list. Beacons appear in
  no visual surface.
- Starters: `starter-event-ticket` gets an upcoming-events input (a season or series ticket). `starter-store-card`
  gets optional beacons. Update goldens and the sample.
- Tests: behavior unit tests, golden `pass.json`, renderer tests, form tests including axe.

### n4: Pass bundles

Owns: `modules/bundles/**`, `src/worker/ssr/bundle*`, `src/worker/email/bundle*`, `src/shared/contracts/bundles.ts`,
and `src/web/admin/passes/bundle*`.
Touches: the passes list selection bar and pass detail (an "In bundles" list).

- A bundle is 1–10 passes of one org and one mode, with a name and a capability link at `/b/:token`. The token is
  256-bit and stored retrievably, like `download_token`, because links are re-sent. It can be rotated and revoked.
- Public `/b/:token` is server-rendered and reuses the pass page shell:
  - compact cards for each pass, each with its own add button;
  - **Add all to Apple Wallet**, which serves `/b/:token/passes.pkpasses` (voided passes excluded) and reuses the
    portal's bundle packaging;
  - QR hand-off on desktop;
  - `noindex`, `no-referrer` and rate limits as for `/p/`.
- API: `POST /api/v1/bundles { orgId, passIds, name, holderEmail?, sendEmail? }`, list (filtered by mode), get,
  `POST /{id}/send-email`, `POST /{id}/rotate-link`, `DELETE`. Scopes are `passes:read` and `passes:write`.
- Email: an org-branded "Your passes" message with the Add all badge and one row per pass, through the outbox.
- Admin: in the passes list, multi-select then **Share as bundle** opens a dialog for the name and an optional email.
  It returns the link, a QR and copy. Pass detail lists the bundles a pass is in.
- Events: `bundle.opened`, and `bundle.downloaded` per pass.

### n5: Template designer

Owns: `src/web/admin/templates/designer/**`, the designer route under `src/web/routes/admin/templates/`, and new
files in `modules/templates/` for saving a version from JSON.

- `POST /api/v1/templates/{id}/versions` takes `{ passJson, manifest, assets: [{ name, sha1 } | { name, upload }] }`
  for uploaded templates. It runs the same validation, image checks, dry-run build and persist as an upload, returns
  the report, and can activate. Built-in templates are read-only: the designer offers **Duplicate to edit**, which
  uses the existing clone.
- Designer, with the live PassCard front and back and validation through a dry-run endpoint:
  - **style:** every style and the poster schemes;
  - **colors:** with a contrast check;
  - **logo text;**
  - **images:** per slot, with size rules from `passkit/schema/image-rules.ts`;
  - **fields:** per area, with add, remove and drag reorder, and key, label, value (static or bound to an input),
    `changeMessage`, alignment and date/number styles;
  - **inputs:** name, label, type, required, default; this generates the manifest `inputs` and `bindings`;
  - **barcode:** format, message (static, an input or `{{pass.scanCode}}`) and alt text;
  - **relevance:** locations and beacons list editors, and relevant dates;
  - **back fields and links.**
- Drafts live in the browser, with the unsaved-change guard. **Save version** creates a version and offers
  **Activate**.
- It follows the expressive-design rules: templates assemble. It works on desktop and tablet. On phones it shows a
  read-only preview with a note.

### n6: Sandbox mode (wave 2)

Owns: `src/web/ui/layout/mode*`, `modules/sandbox/**`, test-inbox pages, and `0015_sandbox.sql`.
Touches: metrics queries, list pages and badges.

- A **Test mode** switch in the admin top bar. It is stored per browser, sends `x-passbook-mode: test`, and shows a
  persistent amber band, "Test mode".
- Test API keys are created with `mode: test`. Show them with a Test badge and the `wlt_test_` prefix in the display
  only; the key format is unchanged.
- **Test inbox:** emails for test passes are captured as rendered HTML and text in `captured_emails`, never sent.
  They are listed and previewed in the admin, with **Send to me**, which sends to the signed-in admin's verified
  email.
- Metrics exclude test passes. Analytics Engine events carry mode, and D1 fallbacks filter it.
- Badges:
  - a **Test** pill on pass rows, pass detail and bundle rows;
  - a ribbon on SSR pass and bundle pages;
  - a pill on portal cards.
- A daily purge deletes test passes older than 30 days (a settings key), along with their objects.

### n7: Broadcasts and scheduled changes (wave 2)

Owns: `modules/broadcasts/**`, `src/worker/workflows/broadcast.ts`, `src/web/admin/messages/**`, the messages routes,
`modules/passes/change-messages.ts` (push budget) and `0013_broadcasts.sql`.

- **Message field:**
  - A template opts in with `manifest.messaging = { input: '<inputName>' }`. That input is bound to a back field
    whose `changeMessage` is `%@`.
  - Starters and Henry's templates gain a `message` input and a back field named "Message".
- **Broadcast:**
  - Fields: `{ orgId, mode, target, patch, notify, at?, clearAfter? }`.
  - `target` filters on templates, status active, on-device only, holder state and search.
  - `patch` holds input values: for a message it is `{ [messagingInput]: text }`; for a scheduled change it is any
    inputs.
  - States: `draft → scheduled → sending → sent | partial | failed | cancelled`.
  - Counts: targeted, updated, unchanged, over budget, failed.
  - The `Broadcast` Workflow publishes in chunks of 100, using CAS and the existing publish path, with source
    `broadcast` or `schedule`. It writes `message.applied` or `schedule.applied`.
- **Scheduling:** the minute cron starts due broadcasts with deterministic instance ids. `clearAfter` schedules the
  follow-up that clears the message.
- **Push budget:**
  - At most 3 notifying updates per pass per rolling 24 h, counted from `pass.updated` events where `notified` is
    true. The limit is a settings key.
  - Over budget, publish without `changeMessage`, so the update is silent.
  - The editor and the composer warn before a send goes over. Never push when the pass didn't change: iOS 27
    disables updates for issuers that do.
- **Admin Messages:**
  - list and detail with progress;
  - a composer with a target picker, a live count and a preview of the lock-screen notification and the pass back;
  - **Send now** or **Schedule**, and cancel while it is scheduled.
- API: `/api/v1/broadcasts`, with a new `messages:write` scope.

### n8: Scanner (wave 2)

The full spec is in `docs/design/scanner/`: `scanner-plan.md` (build order, streams, contracts),
`scanner-architecture.md` (access, data, API) and `scanner-design.md` (screens). Where this section differs, those win;
the paths below are the original ones. Ownership is per stream in `AGENTS.md`.

Owns: `modules/scan/**`, `modules/nfc/**`, `src/web/scan/**`, `src/web/admin/scanning/**` and `0014_scan.sql`.
Touches: `src/passkit/template/manifest.ts` (the `scan` block) and pass detail (scans in the sync log).

- **Who scans:**
  - platform admins, from `/scan` with their own session;
  - **scanner devices** paired per org.
- **Pairing:**
  1. An admin creates a scanner (org, name, allowed templates, mode) and gets a one-time pairing code and QR, valid
     for 10 minutes.
  2. The staff phone opens `/scan` and enters or scans the code.
  3. The phone gets a `__Host-wallet_scan` cookie: a 256-bit token stored hashed, valid 180 days, revocable, scoped
     to scanning in one org.

  `scanner_devices` stores `last_seen_at`.
- **Lookup:**
  - by `scan_code`, or by `barcode_hash` within the scanner's org;
  - an ambiguous hash is refused with a clear error.
- **Manifest `scan.actions`:** `[{ id, label, kind: 'check_in' | 'redeem' | 'increment' | 'set', input?, amount?,
  value?, cooldownSeconds? }]`, with a default of a single `check_in`.
  - `redeem` voids a single-use pass.
  - `increment` and `set` change an input and publish with source `scan`, so stamps and points update on the
    device.
- **Result screen:**
  - PassCard preview, holder display title, status (active, voided, expired, removed, test) and the last 3 scans;
  - the action buttons;
  - success and refusal feedback: the buddy cheers or looks sad, with haptic-style motion and reduced-motion
    respected;
  - a guard against repeat scans within the cooldown.
- **Camera:** `BarcodeDetector` where present. Otherwise lazy-load `zxing-wasm`, pinned exactly and at least 2 weeks
  old, for QR, PDF417, Aztec and Code 128. Manual entry is always available.
- Events: `scan.*` with the action id and outcome, the scanner id as actor, and mode from the pass.
- Admin **Scanners:** a list with last seen and revoke, a create-and-pair dialog, and scans per scanner.
- Templates bind `{{pass.scanCode}}` into the barcode for unguessable codes. The coupon and event-ticket starters
  switch to it.

## Rules for every stream

- Branch `next/<stream>` from `next/integration`, in `<scratchpad>/wt/<stream>`. Never edit the owner's checkout at
  `/Users/vlad/Repos/wallet`.
- Small Conventional Commits. `npm run check` is green before handing back. Never deploy and never use `--remote`.
- Copy follows the brand guide and the no-cruft rule. The brand guide is not on `main` yet. Read it from the owner's
  checkout (read-only): `/Users/vlad/Repos/wallet/docs/design/brand-guide.md`. Also follow `docs/design/ux-principles.md` and
  `docs/design/ui-consistency.md`. Art and motion follow
  `docs/design/motion-and-expression.md`. A buddy cameo is fine at real moments.
- Tests sit beside the code. Every new route gets tenant-isolation and mode tests.
- Report: what was built, files touched outside ownership, migrations, open risks and anything unverified.

## Wave 1 status

Merged into `next/integration` on 2026-11-04, in order: n3, n2, n1, n4, n5. None skipped. `npm run check` is green
(299 test files, 3417 tests) and e2e passes (51 tests, setup included). Migrations 0011, 0012 and 0016 apply in
order on a fresh local D1.

Integration decisions:

- `delivery/push.ts`: n2's awaited `isAvailable` keeps n1's `push.failed` event with code `PUSH_UNAVAILABLE`.
- `delivery/service.ts`: n4's shared `queueEmail` takes `mode` and event data, and records `email.queued` before
  dispatch. Pass emails log `{outboxId, attached}`. Bundle emails log `{outboxId, bundleId}` on the bundle's first
  pass, the same pass that gets `email.captured`.
- Pass detail: devices sit in n1's Devices tab. The Delivery tab keeps n4's In bundles card.
- Selection bar: Send email, Share as bundle, Void, Remove from Wallet, Export CSV.
- Designer: array and object inputs (n3's `upcomingEvents` and `beacons`) read as List inputs. Their schema and
  sample are kept as they are, and the field, barcode and list title pickers offer only scalar inputs. Before this
  change, any input edit turned the array sample into a string, which broke the event ticket and store card starters.
- e2e: `07-public-link` matches the More menu exactly, because the pass tabs now overflow into "More tabs" at 1280 px.
  New: `12-bundles` (anonymous bundle page, archive, one pass, rotate) and `13-remove` (remove, sync log, restore).
- `docs/api.md` covers remove, restore, the sync log, devices and bundles.

Open risks:

- Not verified on a device: whether Wallet moves a removed pass to Expired, whether it shows the removal message,
  and how it renders `upcomingPassInformation`.
- The push key path (ES256 JWT over `fetch`, which needs HTTP/2 to APNs) is untested against Apple. After deploy,
  run Check on an identity that has a push key. KEK rotation does not cover `apns_keys`.
- Until n6 sends `x-passbook-mode`, the admin UI is live-only, including bundles.
- No browser check at tablet and phone widths, or in both themes, for the n1, n2, n3 and n4 UI. n5 was checked.
  At 1280 px the pass detail tabs already overflow.
- n1 credits a pass-file fetch to the devices that checked in during the last 2 minutes. `bundle.opened` also
  counts link-preview fetches. n3's `isActive` is set at publish, so it flips only when the pass is republished.
- Gaps 0013 to 0015 are kept for wave 2. Wrangler applies any missing name, so on a database that already has 0016
  they run after it and must not depend on running before it.

## Wave 2 status

Merged into `next/integration` on 2026-11-04, in order: n6, n7. n8 (scanner) was withdrawn from this wave and will
be designed from scratch; nothing scanner-specific was built, and `0014` stays reserved for it. `npm run check` is
green (311 test files, 3491 tests) and e2e passes (53 tests, setup included), with the new `14-sandbox` and
`15-messages`. Migrations 0013 and 0015 apply in order on a fresh
local D1, and also after 0016 on a database that already has it.

Integration decisions:

- Conflicts: `settings.ts` keeps both `sandbox.purgeDays` and `push.budgetPerDay`; `app.ts` mounts both
  `/api/v1/test-inbox` and `/api/v1/broadcasts`. Both streams raised the bundle budget, to 230,000 and 230,500 B.
  It is now 232,500 B; the merged entry measures 229,823 B.
- Test mode reaches Messages: test messages carry the shared Test pill on rows and detail, and a page test proves
  the list request sends `x-passbook-mode`. The server already filtered lists and counts by mode.
- The daily sandbox purge also deletes finished test broadcasts (not scheduled or sending) past `sandbox.purgeDays`,
  with their per-pass rows. `0013` gains the `broadcasts_test_age` partial index for it.
- Captured mail: wave 2 adds no email kind. Broadcasts only push, so the pass and bundle capture paths cover every
  pass email.
- The designer keeps `manifest.messaging` on save (n7's designer and version tests).
- Fix: the composer navigated while its unsaved-changes guard was still armed, so the guard cancelled the
  navigation and Send left the admin on the form. It now navigates after the guard re-renders clean, as the
  new-pass wizard does. Found by `15-messages`; a page test covers it.
- Audit labels for `broadcast.create`, `broadcast.send` and `broadcast.cancel`. The composer asks for an
  organization before it lists templates.
- Under a heavily loaded runner, two tests timed out: the 90-pass purge backlog test now has 60 s, and the audit
  drawer wait 5 s. `unzip.test.ts`'s 500 ms bound also failed once under that load and was left as it is.
- Browser check at 1280, 820 and 390 px in light and dark: passes list and detail in Test mode, Test inbox
  (off, list, preview), Messages list, detail and composer, API keys, and the SSR pass and bundle ribbons.

Open risks:

- The `Broadcast` workflow ran under local Workflows (miniflare) in e2e, not on Cloudflare. Real APNs pushes,
  the cron start path and `clearAfter` follow-ups are covered by Worker tests only.
- The sandbox purge's batches are bounded by a query-count test, not by a run against a large dataset.
- A test-mode outbox row cancelled before n6 has no captured email.
- The sidebar still has a **Scanners** placeholder (`/admin/scanners`) and `/scan` exists as a placeholder route.
  Hide them or keep them as the scanner design decides.
- For the scanner design: `scan.*` event kinds, the `scanner` actor type, the `scan` pass source,
  `passes.scan_code` and `passes.barcode_hash` already exist. There is no scan scope or scanner credential yet.
- The broadcast entity reuses the `wallet` art; a dedicated art would fit better.
- `isActive` on upcoming events still flips only on republish.

## Final review

Reviewed on 2026-11-05 against every screen, flow and module in the review inventory (63 surfaces, 35 flows, 36
modules), with enforced coverage. Merged into `next/integration` in this order: worker-broadcasts, worker-passes,
shared-ui, admin-core, admin-passes, designer-templates, holder-ssr-email, messages-inbox. `npm run check` is green
(329 test files, 3674 tests, build and dry run), and e2e passes (53 tests, setup included). Migrations 0001 to 0018
(16 files, `0018_broadcasts_mode.sql` new) apply in order on a fresh local D1.

Findings per specialist (blocker / major / minor):

| Specialist | Findings | Blocker | Major | Minor |
| --- | --- | --- | --- | --- |
| UX designer | 118 | 2 | 67 | 49 |
| UI designer | 103 | 1 | 45 | 57 |
| Motion designer | 12 | 0 | 6 | 6 |
| Apple HIG and Wallet | 12 | 0 | 5 | 7 |
| Security engineer | 46 | 0 | 12 | 34 |
| Coding standards engineer | 57 | 0 | 15 | 42 |
| **Total** | **348** | **3** | **150** | **195** |

Triage merged duplicates into 167 findings (2 blockers, 94 majors, 71 minors) in 8 fix areas and dropped 9.
Verifiers added 8 more across rounds, for 175 tracked. 171 were fixed by the fix areas. The other 4 were deferred
on another area's work and were closed at integration.

What was fixed:

- Mode wall: by-id writes on passes, bulk actions, bundles, holders and broadcasts. Another mode is 404 for an API
  key and 409 `MODE_MISMATCH` for a session. Pass detail is read-only for a pass of the other mode and offers the
  switch.
- Broadcasts: edit (`PATCH /{id}`), send again (`POST /{id}/retry`) and per-pass outcomes (`GET /{id}/items`, needs
  `passes:read` for a key). Follow-ups settle on retry and chunks fit the query budget. The Messages detail page
  shows a Passes card, one send confirm and a buddy that keeps its seat. Change messages name the field.
- Removal: one removal callout on every tab, Restore in the header and the Fields tab, the removed state on `/p`,
  `/b` and My passes, and a removal version from the pass version.
- Delivery and sandbox: per-mode email caps, one outcome path for bundle email, captured email served with its own
  CSP, and Test inbox email styles.
- Shared UI: the scanner pages, route and nav item are gone. Broadcasts and bundles have their own art and entity.
  There is one ProgressBar, and one Test strip shared by the console band and the SSR ribbon. Errors name what
  failed, toasts clear the bottom bars, and tables, segmented controls and toggles fit at 390 px.
- Designer and templates: built-ins open read only, one image slot row is shared with the pass Images tab, relevance
  lists reuse the schema-form ListInput, a blank barcode text is flagged, row ids are ident-safe and Add or Replace
  names each slot. Starters keep the message field and season pass dates.
- Admin core: audit names messages, bundles and test emails. Status links message runs and rates a failing push as
  failing. Settings checks ranges and has a push budget field. API keys show the real prefix and a Mode column.
  Connections note Test mode. Push key removal names its dependents.
- Holder surfaces: the email test strip comes from tokens, dark-client lines and links are fixed, there is one
  no-access page, the add block is centred below 1024 px and the card text steps down only beside a thumbnail.

Integration decisions:

- `broadcasts/{guards,service,service-edit,routes}.ts`: worker-broadcasts and worker-passes walled broadcasts by
  mode in two ways. They now share `PassScope`: `requireBroadcast` reads (keys their mode, sessions either) and
  `requireWritableBroadcast` writes. Edit and retry follow the passes rule, so two tests changed: a session on the
  other mode gets 409 `MODE_MISMATCH` rather than 404, and a Test session may read a live message's items, as it may
  read the message.
- `status/checks-identity.ts`: admin-core's "a failing APNs is failing" moved with the function worker-passes split
  out.
- Pass detail: removal progress lives in `callouts.tsx` and uses the shared ProgressBar. The stacked table keeps
  shared-ui's 44 px lead column. The Images tab keeps the other-mode guard on the shared ImageSlotRow. Design uses
  the design glyph in the header and the phone menu.
- Messages merged last, after the routes it calls existed. The Passes card reads the contract's `BroadcastItem`
  (`title`, `holderEmail`). Cancelling a draft says Cancel message on the button, the confirm and the toast, because
  the server moves it to Cancelled. `broadcast.update` and `broadcast.retry` have audit labels.
- Deferred items closed here: the Removed status filter (R058), the bundle art for "Not in a bundle" (R059) and
  versions named by their source (R061).
- Tests: the pass Images size error is matched on its own line (the new needs line also matched; this failed on the
  designer branch alone too). A bad UUID reads "Check the format." `13-remove` restores from the Fields callout,
  because the header and the callout both offer Restore.

Browser check after the merge: 56 surfaces at 1440, 820 and 390 px in light and dark, 824 screenshots, with
WebKit at 1440 and 390 px for login, the portal and the public pages. No scene failed. The check found three
defects, all fixed:

- Designer: from 1280 px, the Expiry field's date and time zone sat side by side (472 px). That widened every section
  past its 22rem column and under the preview. The row now wraps, and the section list is held to its column. This
  predates the merge.
- Designer: a dry run with an error builds no pass, and the preview fell back to its loading skeleton. It now keeps
  the last card that built while the Issues list says what to fix.
- Audit: bundle chips used a different glyph from "Bundle created", because admin-core chose one before shared-ui
  added the bundle entity. Both now use the bundle icon.

Dropped at triage:

- Capture-harness gaps and WebKit tiles broken by `upgrade-insecure-requests` over http: harness artifacts, not
  product defects.
- Quantizing the APNs token `iat` across isolates: speculative, with no 429 observed.
- A conditional template activate (409 `TEMPLATE_CHANGED`): an unlikely two-admin race that needs an API change.
- A draft asset store for designer dry runs: an admin-only performance redesign.
- One RelTime/useNow: it spans four fix areas, so it is a follow-up.
- Mixed import styles in Messages: no user impact.
- Keeping Scanners behind a flag: it contradicts removing the scanner from this release.
- Treating a device with no fetch of the current version as waiting: wrong. That device downloaded the version when
  it added the pass. R046 says "Added with v{n}" instead.

Open risks:

- A version row names its source but does not link to its message, because versions carry no broadcast id.
- A Test session can press Send or Cancel on a live draft it opened by URL. It gets the 409 toast, but the buttons
  are not disabled the way pass detail's are.
- "Status: Removed" truncates in the half-width filter at 390 px.
- The capture harness was lost in the reboot and rebuilt for this pass (`scratchpad/review/capture`). It covers
  fewer states than the review corpus: loading and error states held by route stubs are not reliable, and selection
  actions under the More menu below 1024 px were not opened. Those were reviewed in code.
- The earlier risks stand: Wallet's handling of removed passes and `upcomingPassInformation` is unverified on a
  device, push keys are untested against Apple, and the Broadcast workflow ran only under local Workflows.
