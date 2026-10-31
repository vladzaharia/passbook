# Audit B: update pipeline, Apple Wallet web service and data model

Scope: `src/index.ts`, `src/passes.ts`, `src/jobs.ts`, `src/sources/*`, `src/email.ts`, `src/status.ts`, `src/types.ts`, `src/util.ts`, `migrations/0001_initial.sql`, `tests/service.test.ts`, `tests/helpers.ts`, `docs/api.md`, `docs/extending.md`, `wrangler.jsonc`. This was a read-only audit. `npm run typecheck` passes. To test suspected races I wrote probe scripts in the scratchpad and ran them against the real migration SQL using the repo's SQLite fixture (`tests/helpers.ts`). Each finding below is marked **verified by probe**, **verified by reading**, or **unverified**.

Scope change from the owner, applied throughout: existing passes and data can be wiped. Section 5 therefore proposes a clean target schema (a fresh `0001`), not a backward-compatible migration.

---

## 1. Summary

1. The core publish pipeline is unusually careful and correct for its size. It signs the pass, writes it to R2, then does a compare-and-swap in D1 with `RETURNING`. A trigger assigns a monotonic revision cursor, and push jobs go through a transactional outbox with leased, at-least-once delivery. **Keep this design.**
2. Three delivery defects undermine "passes update remotely":
   - A single bad device token aborts the push to every other device of the pass (verified by probe).
   - `apns-expiration: 0` means devices that are offline when the push is sent never get it.
   - Concurrent syncs mark a pass as failed even when the update succeeded (verified by probe).
3. The scheduling layer is the weak part. Every write and every minute, the system scans globally and re-enqueues the same work (verified by probe). It polls per pass rather than per connection. It retries twice in parallel with no backoff or circuit breaker, and the dead-letter queue (DLQ) has no consumer. Capacity is about 1,500 linked passes before the backlog grows without bound.
4. Nothing is multi-tenant. There are no orgs, users, roles, audit log, settings or template tables. The serial is a global primary key. Signing keys, APNs mTLS, `webServiceURL` and connector credentials all come from deploy-time env and bindings. Connectors receive the whole `env` and have one global config per connector type.
5. Recommendation: a clean multi-tenant D1 schema built around an internal pass `id` with `UNIQUE(pass_type_id, serial)`, connection *instances* with encrypted credentials and a run history, and email-linked `pass_holders`. Connectors should be code plugins. Use a Durable Object per connection for scheduling, rate limiting and circuit breaking; Queues for push and email fan-out; Workflows for bulk and user-visible jobs. Cron becomes a sweeper only.

---

## 2. What works well and should be kept

| Area | Why it's good | Where |
|---|---|---|
| **R2-then-D1 compare-and-swap publish** | Signed bytes go to a fresh R2 key first, then `UPDATE … WHERE serial=? AND version=? AND source_version=? RETURNING`. A loser deletes its object. On an ambiguous D1 error the object is kept because the commit may have succeeded. The previous version stays downloadable on any failure (tested: "R2 failure leaves the previous pass downloadable"). | `src/passes.ts:56-65`, `:33-44` |
| **Trigger-generated revision cursor** | `passesUpdatedSince` uses a DB sequence (`changes` AUTOINCREMENT), not timestamps, so there are no clock-skew or same-millisecond gaps. D1 has a single writer, so commit order equals revision order. | `migrations/0001_initial.sql:46-54`, `src/index.ts:187-194` |
| **Transactional push outbox** | The push job is inserted by the same trigger that bumps the revision, so a published version can never lose its notification. The id `push:<serial>:<version>` is idempotent. | `migrations/0001_initial.sql:50-54` |
| **Outbox lease and claim** | The claim is atomic (`UPDATE … WHERE state IN(…) AND available_at<=? RETURNING *`) with a 120 s lease and backoff from 30 s to 1 h. Errors are stored as codes only, never provider text. A stale lease cannot overwrite the result. Duplicate queue messages are harmless. | `src/jobs.ts:32-54` |
| **Apple registration semantics** | Returns 201 for new and 200 for existing registrations. A token rotation updates every registration of that device for the pass type. 410 cleanup is guarded by APNs' `timestamp`, so a newer re-registration survives (tested). | `src/index.ts:171-181`, `src/jobs.ts:22-27` |
| **Conditional GET** | ETag is preferred. `modified_collision` deliberately returns bytes when two versions share one HTTP second, so an update is never hidden behind a 304. | `src/passes.ts:68-78` |
| **Separate capabilities** | The `download_token` (bearer link) is independent of `authentication_token` (ApplePass). Both are stable across updates (tested). | `src/passes.ts:31`, `tests/service.test.ts:70` |
| **Stale-source fencing** | Changing or detaching a source increments `source_version`, so in-flight refreshes from the old source cannot publish (tested). | `src/index.ts:131`, `src/jobs.ts:63-66` |
| **Email idempotency** | The `Idempotency-Key` is tied to the recipient payload: same key and different recipient returns 409. | `src/index.ts:142-154` |
| **HTTP connector hardening** | HTTPS only, redirects refused, 15 s timeout, 256 KB streaming cap, content-type check. Connector output is re-validated against the template schema on every update. | `src/sources/http-json.ts:11-24`, `src/passes.ts:50-54` |
| **Template input safety** | Protected identity keys can't be mapped, prototype keys are blocked, and featured actions are validated before signing. | `src/personalize.ts:25-32`, `src/sign.ts:28-38` |
| **Tests on real SQL** | The fixture runs the actual migration and triggers in `node:sqlite` with batch transactions. There is also a workerd signing test. | `tests/helpers.ts:8-23` |
| **Privacy-minded logging** | No URLs, tokens or recipients in logs. Wallet device logs are counted, not stored. | `src/index.ts:36`, `:202` |

---

## 3. Problems and bugs

Severity reflects impact on the target platform. The "Verified" column says how each finding was checked.

| # | File:line | Sev | Problem and why it matters | Verified |
|---|---|---|---|---|
| B1 | `src/jobs.ts:12-28` | **High** | **One bad token blocks the push to all devices of a pass.** The loop throws on the first non-OK response other than 410 Unregistered or 400 BadDeviceToken. Examples: 400 `DeviceTokenNotForTopic`, 429 per-token `TooManyRequests`, transient 5xx. Later tokens are never attempted. `SELECT DISTINCT push_token` ordering is stable, so the same token fails first on every retry. After 8 attempts the job is `failed` and the bad registration is never removed. Anyone holding the pass (the auth token is inside the `.pkpass`) can register an arbitrary token. In the probe, token `aa` returned `DeviceTokenNotForTopic`, `bb` was never pushed, and both registrations remained. | probe |
| B2 | `src/jobs.ts:14` | **High** | **`apns-expiration: '0'`** tells APNs to try once and not store the notification. A device that is off, in airplane mode or without signal misses the update. Nothing re-pushes later, so the pass stays stale until the next change or a manual pull-to-refresh. Fix: set expiration to now plus 1–7 days. APNs keeps only the latest notification per topic, so this adds no extra pushes. | probe (headers) |
| B3 | `src/jobs.ts:56-69`, `src/index.ts:117-122` | Med | **Spurious `SOURCE_REFRESH_FAILED`.** Two refreshes of the same pass can overlap: a manual `/sync` (which does not claim `next_sync`) plus a scheduled sync, or a queue redelivery. The loser's compare-and-swap returns 409, and the catch block then writes `sync_error='SOURCE_REFRESH_FAILED'` *after* the winner cleared it. In the probe the pass moved to version 2 with the new name but showed `sync_error=SOURCE_REFRESH_FAILED`. A race with an admin PATCH is recorded as an upstream failure in the same way. Fix: catch the 409, re-read and re-apply (up to 3 tries), and only record upstream errors. | probe |
| B4 | `src/jobs.ts:71-74` | Med | **Dispatch re-enqueues duplicates.** Due outbox rows are sent to the queue without being marked `enqueued`. While a row waits for a consumer, every cron tick and every API write enqueues it again (probe: two dispatches gave two identical `push:p1:2` messages). The lease prevents double side effects, but Queue operations scale with backlog × write rate. Sends are sequential; `sendBatch` is unused. | probe |
| B5 | `src/jobs.ts:66`, `:84-91`, `wrangler.jsonc:47-55` | Med | **Failing sources are retried twice in parallel, with no backoff.** A failed sync both sets `next_sync=now+5 min` and calls `message.retry({delaySeconds:60})` up to 5 times. A down upstream is called about 6 times per pass every ~10 minutes, indefinitely. Nothing tracks failures at the connection level, so there is no circuit breaker. The DLQ `wallet-jobs-dlq` has no consumer, so messages vanish after the default 4-day retention and nobody is alerted. | reading |
| B6 | `src/jobs.ts:75-82` | Med | **Throughput ceiling.** At most 100 sync claims per cron minute with a 900 s interval means about 1,500 linked passes before the backlog grows without bound. The design makes one upstream HTTP call per pass, with no per-connection batching, delta cursor or concurrency limit. The consumer has no `max_concurrency`, so it can flood an upstream API's rate limit. | reading |
| B7 | `src/passes.ts:19-22` | Med | **Identity fields are not pinned on rebuild.** `webServiceURL` is rebuilt from `env.PUBLIC_BASE_URL`, and `passTypeIdentifier`/`teamIdentifier` come from the *current* template code, not from the row's `pass_type`. Changing the domain or a template's pass type silently changes the identity of every rebuilt pass, which Wallet treats as a different pass. The row's `pass_type` would then disagree with the signed JSON. With uploaded templates this becomes a real risk. | reading |
| B8 | `docs/extending.md:50` | Med | **Webhook guidance leaks the global admin token.** The docs say "a webhook can invoke the authenticated `/sync` endpoint", which means giving a third party the all-powerful `ADMIN_TOKEN`. Webhooks need per-connection secrets and a dedicated route. | reading |
| B9 | `src/sources/types.ts:2-12`, `src/sources/index.ts:6-14` | Med | **Connectors get the full `env`** (signing keys, `ADMIN_TOKEN`, other connectors' tokens). Config and credentials are global env vars per connector *type*, so two connections of one type can't coexist. The output mapping is hard-coded to Henry's field names (`memberName`, `membership`). | reading |
| B10 | `src/jobs.ts:66`, `src/status.ts:45-48` | Med | **Sync errors can't be diagnosed.** There is a single constant code with no timestamp, HTTP status, error class or history. The status check only says "a linked pass failed its last sync" and never probes the upstream. | reading |
| B11 | `src/index.ts:73-87` | Med (at target) | **Henry-specific search with full scans.** The admin list runs `json_extract(personalization,'$.memberName'/'$.memberId'/'$.homeClub')` with LIKE, plus a `count(*)` on every page. Generic API code depends on one template's fields, and there is no index or FTS. | reading |
| B12 | `migrations/0001_initial.sql:22,36` | Low | **Foreign-key and index gaps.** `outbox.serial REFERENCES passes` has no `ON DELETE`, so a pass with outbox rows can never be deleted (latent, since no delete route exists). There are no indexes on `outbox(serial)` (used by `GET /api/passes/:serial`), `changes(serial)` or `registrations(push_token)` (used by the delete at `src/jobs.ts:25`), so FK checks and cleanup scan whole tables. | reading |
| B13 | `src/jobs.ts:34`, `:49` | Low | **No attempt cap at claim time.** If processing crashes the isolate before the catch block runs, attempts keep incrementing, the row returns to `processing` after each lease expiry, and it never becomes `failed`. | reading |
| B14 | `src/index.ts:199-204` | Low | **`/v1/log` discards content** and returns 400 for more than 50 entries or lines over 2,000 chars. These logs are the only device-side diagnostics (signature errors, 401s). The endpoint is unauthenticated with no rate limit, though only counts are logged. | probe (51 entries → 400) |
| B15 | `src/index.ts:30` | Low | The security-header middleware sets `Cache-Control: no-store` after the handler runs, which overrides the `private, no-cache` that `passResponse` sets on pkpass responses (`src/passes.ts:69`). It is harmless for Wallet but contradicts the intent. | probe |
| B16 | `src/index.ts:32-37` | Low | `onError` logs only a random requestId, with no error class, code or stack. Production 500s can't be debugged. | reading |
| B17 | `src/index.ts:209` | Low | `scheduled` wraps `dispatch` in `waitUntil` without awaiting it, so cron failures don't show as failed invocations. | reading |
| B18 | `migrations/0001_initial.sql:53` | Low | Each version creates its own push job, so N quick edits send N pushes per device. There is no coalescing. | reading |
| B19 | `src/passes.ts:28-31` | Low | `POST /api/passes` without a `serial` is not idempotent. A client retry creates a second pass and a second email. | reading |
| B20 | `src/types.ts:39`, `:64`, `src/jobs.ts:24,63,77` | Low | `Env` has an index signature `[binding:string]:unknown`, so typos in binding names aren't caught. Timestamp units are mixed: `passes.modified` is in seconds, while `next_sync`, `available_at` and `registered_at` are in milliseconds. | reading |
| B21 | `src/jobs.ts:14` | Low, unverified | `apns-push-type: background` with `apns-priority: 5` is accepted by APNs (transport verified live per `docs/deployment.md`). Priority 5 is power-throttled, though, and actual Wallet refresh latency hasn't been device-tested. If updates lag, try priority 10. | unverified |
| B22 | `src/passes.ts:74` | Low | `If-None-Match` is compared as an exact string, so weak (`W/"1"`) or list values never match. Only an extra download results. | reading |

Notes on protocol conformance (Apple "Adding a web service to update passes"):

- Register, unregister, list, get and log routes, the `ApplePass <token>` header and the 200/201/204/304/401 codes all conform. Pass type is checked together with serial (`src/index.ts:166`).
- Push uses the pass-type certificate over mTLS, topic = pass type id, and an empty `{}` payload. This is correct (`src/jobs.ts:13-14`).
- Unknown device or serial returns 401, not 404, which is acceptable and avoids enumeration.

---

## 4. Not modern best practice (and the modern alternative)

| Current | Modern alternative |
|---|---|
| Every-minute cron is both the outbox sweeper and the per-pass poll scheduler (`wrangler.jsonc:65-69`). | Enqueue the specific job right after commit. Keep a cron sweeper every 5 minutes for rows still `pending` or `enqueued` after 2 minutes. Run per-connection schedules on Durable Object alarms. Put maintenance on a separate daily cron. |
| `waitUntil(dispatch())` after every write scans the whole outbox (`src/index.ts:99,114,132,139,152`). | `JOBS.send({outboxId})` for the row just written. `sendBatch` (up to 100 messages) for fan-out. |
| Retries in two places: Queue retries and D1 `next_sync` (B5). | One owner of the retry policy. Use D1 or Durable Object state with exponential backoff and jitter plus a per-connection circuit breaker. Queue retries only for infrastructure faults. |
| A single shared `ADMIN_TOKEN` is the only identity (`src/index.ts:59-63`). | OIDC (Pocket ID) and magic-link sessions with RBAC per org, scoped and hashed API keys for integrations, per-connection webhook secrets, and an audit log. |
| Hand-rolled validators (`src/util.ts`) and an untyped `Env`. | A schema library (valibot or zod) shared by the API, connector config schemas and the admin UI form generator. Generate `Env` with `wrangler types`. Optionally OpenAPI via `hono-openapi` or `chanfana`. |
| Custom D1 shim over `node:sqlite` for tests. | `@cloudflare/vitest-pool-workers` (Miniflare D1, R2, Queues, Durable Objects, Workflows in workerd). Keep the OpenSSL CMS verification test. |
| Secrets as Worker env vars per connector and per signer (`src/sources/index.ts:9`, `src/signing-identities.ts:7`). | Envelope encryption in D1: AES-GCM with a key-encryption key (KEK) in Secrets Store or a Worker secret, AAD bound to `{credential id, org, kind}`. Secrets are write-only in the API. Secrets Store alone is unsuitable per connection (100 secrets per account, static bindings). |
| Personalization JSON searched with `json_extract` and LIKE. | Denormalized, indexed `display_name` and `external_id` columns, filled from fields the template declares, plus D1 FTS5 if needed (FTS5 support on D1: verify). |
| Opaque error logging. | Structured logs with error code, class and redacted context. Workers traces are already enabled through observability. Write per-connection metrics to Analytics Engine. |
| Push results stored per job, all-or-nothing. | Push results per device (status, reason, apns-id), with retry of failed devices only. |
| Henry-specific code in core paths (`src/views.ts:16-17`, `src/email.ts:16`, `src/status.ts:46`, `src/index.ts:77,86`). | Hooks owned by each template (landing page, email and preview renderers), status checks owned by each connector, and template-declared search fields. |

---

## 5. Gaps against the target, with concrete recommendations

### 5.1 Architecture: which Cloudflare primitive for what

| Concern | Recommendation | Why |
|---|---|---|
| Source of truth | **D1** (one database), with the outbox pattern kept. | Relational queries for admin lists, ownership joins and Apple's device queries. D1 batches are atomic. |
| Signed pass bytes, uploaded template bundles | **R2**. Keys `passes/<passId>/v<version>-<rand>.pkpass` and `templates/<templateId>/v<n>/bundle.zip`, plus a `staging/` prefix with an R2 lifecycle rule (delete after 1 day). | Lifecycle rules can then target staging without touching live objects. |
| Push and email delivery | **Queues** with the D1 outbox as source of truth. Batches of up to 100, a DLQ **with a consumer** that marks the outbox row and alerts. | High volume, at-least-once, cheap. |
| Per-connection scheduling, rate limiting, circuit breaker, coalescing | **Durable Object per connection** (`ConnectionDO`). | Its alarm holds `next_run_at`. A token bucket and concurrency cap protect the upstream. It holds breaker state, coalesces refresh requests for many refs (debounced about 2 s), and owns the delta cursor. Status is read from the DO or mirrored to `connections` in D1. The alarm handler has a 15-minute wall time and retries with backoff. This replaces the global per-pass scan and fixes B5 and B6. |
| Per-pass serialization | **Not a Durable Object.** Keep the D1 compare-and-swap. Coalesce force refreshes with a `refresh_requested_at` claim (below). | The compare-and-swap is correct and cheap. A DO per pass would add cost and complexity for little gain. |
| Bulk and long-running jobs: rebuild all passes for template version N, initial connection import, certificate rotation re-sign, org offboarding and deletion | **Workflows.** Use `createBatch` (up to 100 instances per call) and deterministic instance ids for dedupe. Steps are durable and the status can be shown in the admin UI. | Limits: 10k steps by default (25k max), 50k concurrent instances, 100 creates/s per workflow, retention 7 days by default for new workflows. |
| User force refresh needing visible progress | A Queue job by default. If the UI should stream progress, use a Workflow with id `refresh:<passId>:<30s-bucket>`: `create` throws on an existing id within retention, so it doubles as dedupe, and `instance.subscribe()` streams progress. | Either works; the Workflow gives a better UX. |
| Cron | `*/5 * * * *` sweeper for stuck outbox rows and lost enqueues, and `0 3 * * *` for retention and certificate expiry warnings. Drop the every-minute scheduler once Durable Object alarms exist. | Cron becomes a safety net, not the scheduler. |
| Abuse control | **Rate Limiting binding** (10 s or 60 s windows) on magic-link requests, user refresh, `/wallet/v1/log` and `/p/:token`. **Turnstile** on the magic-link form. | |
| Sessions and magic-link tokens | **D1**, not KV. | KV's eventual consistency (about 60 s) breaks one-time token consumption and session revocation. |
| Metrics for health charts | **Analytics Engine**: connection run latency and outcome, APNs reason codes, Wallet log counts, downloads. | Cheap time series that keeps high-volume writes out of D1. |
| Audit retention beyond D1 | Optional: Pipelines to R2 (Iceberg), or Logpush. | |
| Per-org branded pages | Cloudflare for SaaS custom hostnames for `/p/:token` pages and emails only. **Never** use them for `webServiceURL`. | |
| APNs for many pass types | See 5.5. This is the hardest multi-tenant constraint. | |

Pipeline shape:

```mermaid
flowchart LR
  A[Admin PATCH / API key / user refresh / webhook] -->|enqueue refresh(ref)| CDO[ConnectionDO\nalarm schedule\nrate-limit + breaker\ncoalesce]
  CDO -->|fetchRecord / listChanges| UP[(Upstream API)]
  CDO -->|refresh jobs| Q[[Queue: work]]
  A -->|manual edit| PUB
  Q --> PUB[publish(): sign → R2 put → D1 CAS\n(retry on conflict ×3)]
  PUB -->|trigger: revision++, pass_versions, outbox push (coalesced)| D1[(D1)]
  PUB -->|send outboxId| Q2[[Queue: delivery]]
  Q2 --> APNS[APNs per device\nper-device results]
  Q2 --> EM[Email Sending]
  CRON[cron */5 sweeper] --> D1
  Q2 -. DLQ consumer .-> D1
```

### 5.2 Proposed clean D1 schema (fresh `0001`)

Conventions:

- IDs are TEXT ULID/UUIDv7.
- All timestamps are INTEGER milliseconds (`*_at`).
- Emails are stored normalized: trimmed, lower-cased, NFC. Do not strip `+tags` or dots.
- D1 enforces foreign keys. Every FK child column is indexed.

```sql
-- ── Tenancy & identity ────────────────────────────────────────────────
CREATE TABLE orgs (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  primary_email TEXT NOT NULL UNIQUE,
  name TEXT,
  platform_role TEXT CHECK (platform_role IN ('owner','admin')),   -- NULL = ordinary user
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL, last_login_at INTEGER);

CREATE TABLE user_emails (                 -- verified addresses; the join key for pass ownership
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_via TEXT NOT NULL CHECK (verified_via IN ('magic_link','oidc')),
  verified_at INTEGER NOT NULL);
CREATE INDEX user_emails_user ON user_emails(user_id);

CREATE TABLE auth_identities (             -- Pocket ID (OIDC) and future IdPs
  provider TEXT NOT NULL, subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_claim TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_used_at INTEGER,
  PRIMARY KEY (provider, subject));
CREATE INDEX auth_identities_user ON auth_identities(user_id);

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  created_at INTEGER NOT NULL, PRIMARY KEY (org_id, user_id));
CREATE INDEX org_members_user ON org_members(user_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,                 -- SHA-256 of the cookie value
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amr TEXT NOT NULL,                        -- 'oidc' | 'magic_link'
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER, ip_prefix TEXT, user_agent TEXT);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY, email TEXT NOT NULL,
  redirect_path TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,   -- ~15 min
  consumed_at INTEGER);                     -- single use: UPDATE … WHERE consumed_at IS NULL RETURNING
CREATE INDEX magic_links_email ON magic_links(email, created_at);

CREATE TABLE oidc_flows (                   -- state/nonce/PKCE; or a signed, short-lived cookie
  state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL,
  redirect_path TEXT, expires_at INTEGER NOT NULL);

CREATE TABLE api_keys (                     -- replaces the shared ADMIN_TOKEN for machines
  id TEXT PRIMARY KEY, org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,  -- NULL = platform key
  name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,  -- JSON array
  created_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL,
  last_used_at INTEGER, expires_at INTEGER, revoked_at INTEGER);

-- ── Secrets (envelope-encrypted) ─────────────────────────────────────
CREATE TABLE credentials (
  id TEXT PRIMARY KEY, org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pass_signer','connector','webhook')),
  kek_id TEXT NOT NULL, iv BLOB NOT NULL, ciphertext BLOB NOT NULL,   -- AES-256-GCM, AAD = id|org_id|kind
  fingerprint TEXT,                          -- shown in UI (cert SHA-256 / last4); never the secret
  created_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL, rotated_at INTEGER);
CREATE INDEX credentials_org ON credentials(org_id);

-- ── Apple identities & templates ─────────────────────────────────────
CREATE TABLE pass_types (
  id TEXT PRIMARY KEY,                       -- Apple passTypeIdentifier
  org_id TEXT NOT NULL REFERENCES orgs(id),
  team_id TEXT NOT NULL,
  web_service_url TEXT NOT NULL,             -- frozen at creation; every pass of this type embeds it
  signer_credential_id TEXT REFERENCES credentials(id),   -- NULL ⇒ baked env signer
  signer_env_name TEXT,                      -- e.g. 'henrys' for baked identities
  apns_binding TEXT,                         -- deploy-time mTLS binding name (see 5.5)
  cert_not_after INTEGER, apns_health TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL);
CREATE INDEX pass_types_org ON pass_types(org_id);

CREATE TABLE templates (
  id TEXT PRIMARY KEY, org_id TEXT REFERENCES orgs(id),       -- NULL org = platform-baked/shared
  pass_type_id TEXT NOT NULL REFERENCES pass_types(id),
  slug TEXT NOT NULL, name TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('baked','uploaded')),
  current_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  search_fields TEXT NOT NULL DEFAULT '[]',  -- which inputs feed display_name / external_id
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (org_id, slug));
CREATE INDEX templates_pass_type ON templates(pass_type_id);

CREATE TABLE template_versions (             -- immutable; baked rows are upserted by deploy sync only
  template_id TEXT NOT NULL REFERENCES templates(id),
  version INTEGER NOT NULL,
  bundle_key TEXT,                           -- R2 key (uploaded); NULL for baked (assets in Static Assets)
  bundle_sha256 TEXT NOT NULL,
  pass_json TEXT NOT NULL,                   -- validated base pass.json (passTypeIdentifier must = templates.pass_type_id)
  input_schema TEXT NOT NULL,
  validation_report TEXT,
  created_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version));
CREATE TRIGGER template_versions_immutable BEFORE UPDATE ON template_versions
BEGIN SELECT RAISE(ABORT, 'template versions are immutable'); END;
-- The application refuses admin writes to templates WHERE origin='baked'.

-- ── Connections ──────────────────────────────────────────────────────
CREATE TABLE connections (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL,              -- code plugin id, e.g. 'membership-api'
  connector_version INTEGER NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',         -- non-secret; validated by connector.configSchema
  credential_id TEXT REFERENCES credentials(id),
  webhook_credential_id TEXT REFERENCES credentials(id),
  mapping TEXT,                              -- {templateField: {from:'/json/pointer', transform?}}
  mode TEXT NOT NULL DEFAULT 'poll' CHECK (mode IN ('poll','webhook','hybrid','manual','snapshot')),
  interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds >= 60),
  enabled INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,     -- bump on config/credential change ⇒ fences in-flight runs
  health TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health IN ('unknown','healthy','degraded','failing','paused','disabled')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0, breaker_open_until INTEGER,
  cursor TEXT, next_run_at INTEGER, last_run_at INTEGER, last_success_at INTEGER,
  last_error_code TEXT, last_error_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX connections_org ON connections(org_id);

CREATE TABLE connection_runs (               -- error history & health; prune to 30 d / N per connection
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','webhook','admin','user','test','backfill')),
  actor_id TEXT, pass_id TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running','unchanged','changed','error','skipped')),
  records_seen INTEGER, passes_changed INTEGER,
  error_code TEXT, error_detail TEXT, http_status INTEGER, duration_ms INTEGER);
CREATE INDEX connection_runs_recent ON connection_runs(connection_id, started_at DESC);
CREATE INDEX connection_runs_pass ON connection_runs(pass_id, started_at DESC);

CREATE TABLE webhook_events (                -- dedupe; prune after 7 d
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, event_id));

-- ── Passes ───────────────────────────────────────────────────────────
CREATE TABLE passes (
  id TEXT PRIMARY KEY,                       -- internal id used by admin/user APIs and R2 keys
  org_id TEXT NOT NULL REFERENCES orgs(id),
  pass_type_id TEXT NOT NULL REFERENCES pass_types(id),
  serial TEXT NOT NULL,                      -- Apple serialNumber; immutable
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  auth_token TEXT NOT NULL,                  -- ApplePass token (needed in clear to re-sign)
  download_token TEXT NOT NULL UNIQUE,       -- bearer link; rotatable
  download_token_rotated_at INTEGER,
  personalization TEXT NOT NULL,             -- canonical JSON validated by template_version
  field_sources TEXT NOT NULL DEFAULT '{}',  -- {field:'manual'|'connection'}: manual overrides win
  display_name TEXT, external_id TEXT,       -- denormalized from template.search_fields
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided','expired','revoked')),
  version INTEGER NOT NULL DEFAULT 1,        -- optimistic lock + ETag
  revision INTEGER NOT NULL DEFAULT 0,       -- Apple passesUpdatedSince tag
  object_key TEXT NOT NULL, object_sha256 TEXT,
  modified_at INTEGER NOT NULL, modified_collision INTEGER NOT NULL DEFAULT 0,
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  external_ref TEXT,
  link_generation INTEGER NOT NULL DEFAULT 1, -- was source_version: fences stale refreshes
  next_sync_at INTEGER, last_synced_at INTEGER, sync_error_code TEXT,
  sync_failures INTEGER NOT NULL DEFAULT 0,
  refresh_requested_at INTEGER,              -- coalesces user/admin force-refresh
  created_by TEXT, created_at INTEGER NOT NULL,
  UNIQUE (pass_type_id, serial),
  FOREIGN KEY (template_id, template_version) REFERENCES template_versions(template_id, version));
CREATE INDEX passes_org_list ON passes(org_id, template_id, status, display_name);
CREATE INDEX passes_external ON passes(org_id, external_id);
CREATE INDEX passes_connection_ref ON passes(connection_id, external_ref) WHERE connection_id IS NOT NULL;
CREATE INDEX passes_template ON passes(template_id, template_version);   -- bulk rebuild

CREATE TABLE pass_versions (                 -- audit of every published version; R2 retention driver
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  object_key TEXT, object_sha256 TEXT,
  template_version INTEGER NOT NULL, personalization TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('create','admin','connection','user_refresh','template_upgrade','resign')),
  actor_type TEXT, actor_id TEXT, created_at INTEGER NOT NULL, purged_at INTEGER,
  PRIMARY KEY (pass_id, version));

CREATE TABLE pass_holders (                  -- email-linked ownership (polaris-key style assignment)
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  email TEXT NOT NULL,                       -- normalized; joined to user_emails at read time
  role TEXT NOT NULL DEFAULT 'holder' CHECK (role IN ('holder','viewer')),
  source TEXT NOT NULL CHECK (source IN ('admin','api','connection','import')),
  assigned_by TEXT, assigned_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (pass_id, email));
CREATE INDEX pass_holders_email ON pass_holders(email) WHERE revoked_at IS NULL;

-- ── Apple device protocol ────────────────────────────────────────────
CREATE TABLE devices (                       -- push token is per (device, pass type)
  device_id TEXT NOT NULL,
  pass_type_id TEXT NOT NULL REFERENCES pass_types(id),
  push_token TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, pass_type_id));
CREATE INDEX devices_token ON devices(push_token);

CREATE TABLE registrations (
  device_id TEXT NOT NULL, pass_type_id TEXT NOT NULL,
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, pass_type_id, pass_id),
  FOREIGN KEY (device_id, pass_type_id) REFERENCES devices(device_id, pass_type_id) ON DELETE CASCADE);
CREATE INDEX registrations_pass ON registrations(pass_id);

CREATE TABLE revisions (                     -- sequence generator only; prune freely
  revision INTEGER PRIMARY KEY AUTOINCREMENT, -- sqlite_sequence keeps the high-water mark after deletes
  pass_id TEXT NOT NULL, at INTEGER NOT NULL);

-- ── Delivery outbox ─────────────────────────────────────────────────
CREATE TABLE outbox (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('push','email')),
  pass_id TEXT REFERENCES passes(id) ON DELETE CASCADE,
  coalesce_key TEXT UNIQUE,                  -- 'push:<passId>' while pending; NULLed on claim
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','enqueued','processing','sent','partial','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 8,
  available_at INTEGER NOT NULL DEFAULT 0, enqueued_at INTEGER, lease TEXT,
  provider_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX outbox_due ON outbox(state, available_at);
CREATE INDEX outbox_pass ON outbox(pass_id, created_at DESC);

CREATE TABLE push_results (                  -- per-device outcome; retry only failed devices
  outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, http_status INTEGER, reason TEXT, apns_id TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (outbox_id, device_id));

-- ── Audit & settings ────────────────────────────────────────────────
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, org_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','api_key','system','connection','device')),
  actor_id TEXT, action TEXT NOT NULL,       -- 'pass.update', 'connection.credential.rotate', ...
  target_type TEXT, target_id TEXT, request_id TEXT, ip_prefix TEXT,
  detail TEXT);                              -- JSON diff with secrets/PII redacted
CREATE INDEX audit_org ON audit_log(org_id, at DESC);
CREATE INDEX audit_target ON audit_log(target_type, target_id, at DESC);

CREATE TABLE settings (
  scope TEXT NOT NULL,                       -- 'platform' | 'org:<id>'
  key TEXT NOT NULL, value TEXT NOT NULL,    -- JSON; validated by a typed settings registry
  updated_by TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key));

-- ── Publish trigger (keeps today's atomic pattern, extended) ─────────
CREATE TRIGGER pass_published AFTER UPDATE OF object_key ON passes
WHEN NEW.object_key != OLD.object_key BEGIN
  INSERT INTO revisions(pass_id, at) VALUES (NEW.id, NEW.modified_at);
  UPDATE passes SET revision = last_insert_rowid() WHERE id = NEW.id;
  INSERT INTO pass_versions(pass_id, version, object_key, object_sha256, template_version,
                            personalization, cause, created_at)
    VALUES (NEW.id, NEW.version, NEW.object_key, NEW.object_sha256, NEW.template_version,
            NEW.personalization, 'admin', NEW.modified_at);   -- real cause passed via a column or the app batch
  INSERT OR IGNORE INTO outbox(id, org_id, kind, pass_id, coalesce_key, created_at)
    VALUES ('push:' || NEW.id || ':' || NEW.version, NEW.org_id, 'push', NEW.id,
            'push:' || NEW.id, NEW.modified_at);           -- coalesces bursts into one pending push
END;
-- A matching AFTER INSERT trigger handles 'create' (revision + pass_versions; no push).
```

Notes on the schema:

- **Ownership by email.** A user's passes are:
  ```sql
  SELECT p.* FROM passes p
  JOIN pass_holders h ON h.pass_id = p.id AND h.revoked_at IS NULL
  JOIN user_emails e ON e.email = h.email
  WHERE e.user_id = ?
  ```
  Resolving at read time means a pass assigned before the user signs up, or to a second verified email, just works. Revoking an assignment takes effect immediately. Never trust an unverified OIDC `email` claim for this join (see open question 5).
- **Apple routes.** `authorizedPass` looks up by `(pass_type_id, serial)` through the UNIQUE index. Admin and user APIs use `passes.id` only. This removes the global serial collision (`migrations/0001_initial.sql:2`) and lets org-supplied serials coexist.
- **`webServiceURL`** lives on `pass_types` and is copied into every build. Use a platform-owned host that will never change. Optionally include a per-pass-type path, e.g. `https://wallet.plrs.im/wallet/t/<passTypeId>`, so one tenant can later be routed to another Worker without changing the URL.
- **Field ownership.** `field_sources` records whether each field was last set manually or by a connection. A connection refresh skips fields marked `manual` unless an admin chooses "reset to connection". Today a refresh silently overwrites manual edits.
- **Indexes.** Every FK child column is indexed (D1 enforces FKs, and an unindexed child forces table scans on parent update or delete). `devices(push_token)` keeps the 410 cleanup fast.

**Retention** (daily cron or a Workflow):

| Data | Rule |
|---|---|
| `pass_versions` and R2 objects | Keep the current version plus the last 3, or 30 days. Delete R2 objects in batches, then set `purged_at`. Never touch `passes.object_key`. |
| `revisions` | Delete rows older than 7 days. `sqlite_sequence` keeps the cursor monotonic. Verify that D1 export/import preserves `sqlite_sequence` before ever restoring into a new database: a reset sequence would leave devices' `passesUpdatedSince` tags ahead of every revision, and they would never see updates again. |
| `outbox` | Delete `sent` rows after 30 days and `failed` rows after 90 days. |
| `connection_runs` | Keep 30 days, or the last 1,000 per connection. Aggregate into Analytics Engine. |
| `webhook_events`, `magic_links`, `oidc_flows`, `sessions` | Delete once expired or older than 7 days. |
| `audit_log` | 1 year in D1, optionally exported to R2. |
| Holder deletion (GDPR) | Must also purge `pass_versions.personalization` and old R2 objects for that pass. |

**D1 limits to design around:**

| Limit | Value | Consequence |
|---|---|---|
| Bound parameters per query | 100 | Chunk `IN` lists in bulk jobs. |
| SQL statement length | 100 KB | |
| Row / string / BLOB size | 2 MB | Never store template bundles in D1. |
| Queries per invocation (paid) | 1,000 | A `batch()` counts as one; use batches in Workflows. |
| Query duration | 30 s | |
| Query result size | 50 MB (enforced from 2026-11-04) | Paginate admin exports. |
| Database size | 10 GB on Workers Paid (from memory; confirm on the limits page) | Ample for passes; retention keeps logs bounded. |
| Writers | single writer | Keep Apple GET routes read-only. If D1 read replication or the Sessions API is enabled, the `/wallet/v1/*` reads that follow a push must use `first-primary` or a bookmark. A lagging replica returning 204 would make the device skip the update. |

### 5.3 Connector registry: type versus instance

- A **connector type** is trusted code, registered at build time, one file per connector.
- A **connection** is an instance an admin configures per org, with its own encrypted credentials, mapping, schedule, health and run history.
- One org can have several connections of the same type.

```ts
// src/connectors/types.ts
export interface ConnectorDefinition<C = unknown, S = unknown> {
  type: string;                 // stable id, e.g. 'membership-api'
  version: number;              // bump when config/secret shape changes (with migrate())
  displayName: string;
  capabilities: { poll?: true; delta?: true; webhook?: true; import?: true; snapshot?: true };
  configSchema: Schema<C>;      // non-secret fields; also drives the admin form
  secretSchema?: Schema<S>;     // write-only fields; never returned by the API
  outputFields: Record<string, { type: 'string'|'number'|'boolean'|'date'; description?: string }>;
  defaults: { intervalSeconds: number; maxConcurrency: number; requestsPerMinute: number; timeoutMs: number };
  migrate?(oldVersion: number, config: unknown): C;

  test?(ctx: ConnectorContext<C, S>): Promise<{ ok: true; detail?: string }>;          // "Test connection" + health probe
  fetchRecord(ctx: ConnectorContext<C, S>, ref: string): Promise<RecordResult>;          // per-pass refresh
  listChanges?(ctx: ConnectorContext<C, S>, cursor: string | null):                     // bulk/delta polling
    Promise<{ changes: { ref: string; record?: UpstreamRecord; deleted?: boolean }[]; cursor: string; hasMore: boolean }>;
  verifyWebhook?(ctx: ConnectorContext<C, S>, req: Request):                             // throws ConnectorError('AUTH')
    Promise<{ eventId: string; refs: string[]; records?: Record<string, UpstreamRecord> }>;
  importRecords?(ctx: ConnectorContext<C, S>, cursor: string | null):                    // initial backfill (Workflow)
    Promise<{ records: { ref: string; record: UpstreamRecord; holderEmail?: string }[]; cursor: string | null }>;
}

export type UpstreamRecord = Record<string, Json>;   // shaped by outputFields; mapped to template inputs by core
export type RecordResult =
  | { status: 'ok'; record: UpstreamRecord; holderEmail?: string; etag?: string }
  | { status: 'not_modified' }
  | { status: 'not_found' };                          // core decides: keep, void, or flag — never auto-void on AUTH errors

export interface ConnectorContext<C, S> {
  connection: { id: string; orgId: string; generation: number; config: C };
  secrets: S;                   // decrypted per run; NOT the Worker env
  fetch: SafeFetch;             // HTTPS-only, no redirects, timeout, size cap, egress allow-list from config
  signal: AbortSignal;
  log(event: string, data?: Record<string, string | number>): void;   // redacted, goes to connection_runs + AE
}

export class ConnectorError extends Error {
  constructor(public code: 'AUTH' | 'FORBIDDEN' | 'RATE_LIMITED' | 'UPSTREAM' | 'TIMEOUT' | 'INVALID_PAYLOAD' | 'CONFIG',
              public opts: { permanent?: boolean; retryAfterMs?: number; httpStatus?: number } = {}) { super(code); }
}

// src/connectors/registry.ts
export const connectors = defineRegistry([membershipApi, httpJsonGeneric, memberspotSnapshot]);
```

How the core uses connectors:

1. **Mapping is applied by core, not by the connector.** `connections.mapping` maps `templateField ← upstreamField` with small transforms (enum map, `bool→status`, date format, constant). The result is then validated by the template's `input_schema`, as `updatePass` does today. A connector stays template-agnostic, and a second org using the same upstream product needs no code.
2. **Scheduling.** `ConnectionDO.alarm()` runs `listChanges` if the connector supports it (one call per connection) and otherwise fans out `fetchRecord` for due passes, respecting `maxConcurrency` and `requestsPerMinute`. It writes a `connection_runs` row, updates health, and opens the breaker after N consecutive failures (5 min growing to 1 h, then auto half-open). `generation` fences any run started before a config or credential change.
3. **Webhooks.** `POST /hooks/:connectionId` calls `verifyWebhook` with the connection's own secret, dedupes through `webhook_events`, finds affected passes via `passes_connection_ref`, enqueues refresh work on the Durable Object and returns 202 immediately.
4. **Manual and user refresh.** `POST /api/passes/:id/refresh` (admin or API key) and `POST /me/passes/:id/refresh` (holder):
   - Check authorization (org RBAC, or a `pass_holders` × `user_emails` join).
   - Apply the Rate Limiting binding, e.g. 3/min per user and pass.
   - Claim the refresh:
     ```sql
     UPDATE passes SET refresh_requested_at=? WHERE id=?
       AND (refresh_requested_at IS NULL OR refresh_requested_at < ?-30000) RETURNING connection_id
     ```
   - Hand off to `ConnectionDO.refresh([ref], {trigger:'user'})` and return 202 with a run id the UI can poll.
   - If the connection returns unchanged data, **still enqueue a re-push**. A device that missed an earlier push has an older tag, so the push makes it re-query the serials list and fetch the current version. A push without a revision bump is harmless for devices that are already current.
   - If the pass has no connection, "refresh" means re-push only.
5. **Health shown to admins.** For each connection: `health`, last success and age compared with the interval, consecutive failures, breaker state, the last 20 runs with error code and HTTP status, p50/p95 latency and error rate from Analytics Engine, and a "Test connection" button that calls `test()`.
6. **Never interpret an auth or transport failure as membership state.** `AUTH` and `TIMEOUT` mark the connection unhealthy and leave passes untouched. Only an explicit upstream record may void a pass. This also follows `investigations/memberspot/README.md`.
7. **Snapshot connectors** (MemberSpot via Shortcut) are `capabilities.snapshot`. They have no schedule. A holder submits data through an authenticated user endpoint, and it is stored with provenance (`cause='user_refresh'`, `actor_type='user'`).

Adding a connector becomes: one file in `src/connectors/<type>/`, one line in `registry.ts`, and a contract test run through a shared kit (`connectorContract(def, fixtures)`).

### 5.4 Publish and delivery fixes (independent of the redesign)

1. Make the push loop per device. Collect results and handle each APNs reason:
   - 410 `Unregistered`, 400 `BadDeviceToken`, 400 `DeviceTokenNotForTopic`: delete that device registration.
   - 429 or 5xx: retry only that device.
   - 403 or certificate/topic errors (`BadCertificate`, `TopicDisallowed` and similar): set `pass_types.apns_health='failing'`, keep the registrations, back off.

   Finish the job as `sent` or `partial` (fixes B1).
2. Set `apns-expiration` to now plus about 7 days (fixes B2).
3. In connection refresh, catch the 409 conflict, re-read and re-apply up to 3 times, and never write an upstream error code for a lock conflict (fixes B3).
4. On dispatch, mark rows `enqueued` with `enqueued_at`, send the specific id after commit, use `sendBatch`, and run the sweeper every 5 minutes (fixes B4).
5. Keep a single retry policy, add a DLQ consumer, and add a `max_attempts` guard in the claim (fixes B5 and B13).
6. Pin `passTypeIdentifier`, `teamIdentifier` and `webServiceURL` from the pass and pass-type rows at build time, and assert they match the template (fixes B7).
7. Coalesce pending pushes per pass (fixes B18). Accept an `Idempotency-Key` on create (fixes B19).
8. Store redacted Wallet logs, accept up to about 100 lines with truncation, and rate-limit the endpoint (fixes B14). Structured error logging (fixes B16).

### 5.5 Multi-tenant signing and APNs

- **Signing.** Fully runtime-capable. Decrypt the PKCS#8 key from `credentials` and `importKey` it per pass type, exactly as `sign.ts` already does with env strings. Track `cert_not_after` and warn 30 days before expiry with a daily job.
- **APNs.** This is the hard constraint. Wallet pushes must use each pass type's certificate over mTLS. Workers mTLS bindings are declared statically by `certificate_id` in Wrangler config (Cloudflare docs; I found no runtime client-certificate API). Every new pass type therefore needs a certificate upload plus a new Worker version with a binding. Options:
  - **(a)** Deploy-time bindings `APNS_<hash>`, added by an admin-triggered CI deploy. Simple, but onboarding a tenant means a deploy.
  - **(b)** Workers for Platforms: one small "apns-gateway" user Worker per pass type, uploaded through the Cloudflare API with its own mTLS binding and reached via a dispatch namespace binding. Fully self-service, but it needs a Cloudflare API token held by the platform and has its own base cost. Unverified: that user Workers accept `mtls_certificate` bindings.
  - **(c)** A Container-based APNs sender holding encrypted certificates. Fully dynamic, but adds a container.
  - **(d)** A shared platform pass type for all orgs. Only one certificate, but passes are branded under the platform's Apple team.

  This choice is the biggest open architectural decision (open question 2).

---

## 6. Open questions only the owner can answer

1. **Serials:** platform-generated only, or org-supplied (imports from other providers)? The schema supports both, but the UX and validation differ.
2. **Apple identity model:** does each org bring its own Pass Type ID certificate (needs per-type APNs, see 5.5 a–c), or is there a shared platform pass type (5.5 d)? Is tenant onboarding allowed to require a deploy?
3. **`webServiceURL` host:** which platform-owned host will be frozen forever (e.g. `wallet.plrs.im`)? Should it include a per-type path for future routing? Are per-org custom domains wanted for pages and emails?
4. **Manual edits versus connection data:** should manual edits lock a field against connection overwrite (`field_sources`), or should the connection always win?
5. **Email-linking trust:** is Pocket ID's `email` claim verified (does `email_verified` exist and get enforced)? If not, should an OIDC sign-in require one magic-link verification before passes are linked? Can a pass have several holder emails (family), and can a user have several emails?
6. **Force refresh semantics and limits:** what rate per user? Should a user see refresh progress live (favours Workflows) or just "requested / last updated"? Should a user be able to refresh a pass without a connection (re-push only)?
7. **Upstream reality:** which providers need webhooks or delta feeds versus per-record polling? Is MemberSpot snapshot-only? This decides how soon `ConnectionDO` and `listChanges` are needed.
8. **Connector extensibility:** are connector types always first-party code (deploy to add), or will third parties supply them? The latter needs sandboxing such as Workers for Platforms or dynamic workers.
9. **Retention and privacy:** how long to keep pass version history, audit logs and delivery logs? What are the GDPR or deletion obligations for holder data, including old R2 versions?
10. **Scale targets:** expected orgs, passes per org and update frequency. This decides whether a single D1 is enough (likely) or databases must be sharded per org.
11. **Org-admin visibility:** may org admins see device registration counts or push outcomes per pass (useful support data, mild privacy concern)?
12. **Email sender:** platform `passes@plrs.im` for everyone, or per-org verified sender domains? `allowed_sender_addresses` is static in `wrangler.jsonc:57-64`.
13. **Admin roles:** are `owner/admin/editor/viewer` per org plus `platform owner/admin` enough, or are per-template or per-connection permissions needed?
