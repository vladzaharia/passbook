# Audit E: Cloudflare platform usage, configuration, and operations

Scope: `wrangler.jsonc`, `scripts/*`, the Worker entry points (`src/index.ts`, `src/jobs.ts`, `src/passes.ts`, `src/status.ts`, `src/email.ts`, `src/types.ts`), `migrations/0001_initial.sql`, `package.json`, `README.md`, `docs/deployment.md`. This was a read-only audit. I did not read `.secrets/` or `.dev.vars`. I ran no remote commands, deploys, smoke checks, or live checks.

How claims were verified. I checked them against current Cloudflare docs (developers.cloudflare.com, fetched 2026-10-31), the local `node_modules/wrangler/config-schema.json` (wrangler 4.116.0), and `node_modules/wrangler/wrangler-dist/cli.js`. Anything not verified is marked **(unverified)**.

---

## 1. Summary

1. The current single-tenant deployment is well made. Custom domain only (no workers.dev or preview URLs), invocation logs deliberately off for capability URLs, secrets shipped in the same version as the code, migrations applied before the code deploy, a transactional outbox with leases, and APNs over the Workers mTLS binding.
2. Operationally it is fragile. There is no git and no CI. Production deploys run from one workstation that holds the Pass Type ID private keys and re-uploads them on every deploy. There is no staging environment, and local development points passes at the production `webServiceURL`.
3. The biggest platform blocker for the multi-tenant goal: signing identities are static Worker secrets and APNs certificates are static `mtls_certificates` bindings. Every tenant with its own Pass Type ID would need a config change and a redeploy, and hits the 128 variables-per-Worker limit.
4. Several scripts reimplement what Wrangler and the dashboard now do: resource provisioning, email DNS onboarding, a JSONC "parser", and DNS-cache workarounds. Async work runs on two overlapping retry systems (outbox + cron, and Queue retries + DLQ) that partly fight each other.
5. Target: keep Workers + Static Assets (SPA mode, `run_worker_first` patterns), D1, R2, Queues, Cron, mTLS, and Email Sending. Add Workflows, Images, Turnstile, the Rate Limiting binding, Analytics Engine, Email Sending event subscriptions, Workers Builds + Previews, and traces (after URL hygiene). Durable Objects, Access, Secrets Store, and Smart Placement are case by case. Skip KV, Hyperdrive, Vectorize/AI, Browser Run, and Zero Trust Gateway.

---

## 2. What works well and should be kept

| What | Where | Why it is right |
|---|---|---|
| Custom Domain, `workers_dev:false`, `preview_urls:false` | `wrangler.jsonc:14-21` | No accidental second public hostname. Custom Domains are the documented choice when the Worker is the origin. |
| `invocation_logs:false`, structured logs with no PII | `wrangler.jsonc:70-75`, `src/index.ts:36`, `src/jobs.ts:17,52` | Capability URLs (`/p/:token`) never reach Workers Logs (`docs/deployment.md:73`). Errors carry only IDs and codes. |
| Secrets uploaded with the code version via `--secrets-file`, temp files removed in `finally` | `scripts/deploy.mjs:29-44` | Verified: `--secrets-file` "Existing secrets not included in the file are preserved". No window where the new code runs without its secrets. |
| Custom-domain publishing kept out of Wrangler's non-TTY path | `scripts/deploy.mjs:34-42` | Verified in `wrangler-dist/cli.js:140110-140114`: when `!process.stdout.isTTY`, Wrangler sets `override_existing_origin` and `override_existing_dns_record` to `true`. The workaround is justified. |
| Gated deploy: cert-expiry check, `npm run check`, remote migrations before code | `scripts/deploy.mjs:13-16,27-28` | Correct order for additive migrations. Fails before publishing. |
| R2-before-D1 compare-and-swap publish, D1 trigger writes the change cursor and outbox atomically | `src/passes.ts:56-64`, `migrations/0001_initial.sql:46-54` | Correct use of D1's single-writer transactions. No dual-write gaps. |
| Outbox leases, idempotency keys, bounded attempts | `src/jobs.ts:32-53`, `src/index.ts:142-153` | At-least-once delivery with safe dedupe. Keep this as the ledger. |
| APNs through the `mtls_certificates` binding, `redirect:'manual'`, timeouts | `wrangler.jsonc:80-85`, `src/jobs.ts:13-19` | The only Workers-native way to present the Pass Type ID client certificate. |
| Upstream fetch hygiene (HTTPS only, no redirects, 15 s timeout, 256 KB streamed cap) | `src/sources/http-json.ts:13-22` | Good basis for the future API-connection SSRF and size guardrails. |
| Least-privilege email binding | `wrangler.jsonc:57-64` (`allowed_sender_addresses`) | Restricts which From addresses this binding may send as. |
| `limits.cpu_ms` set | `wrangler.jsonc:76-78` | Protects against denial-of-wallet. The value is generous (see section 4). |
| Artwork in Static Assets, not bundled; streamed pass downloads with ETag/304 | `scripts/build-assets.mjs`, `src/passes.ts:68-77` | Bundle is about 994 KB (`dist/index.js`). Downloads stream from R2. |
| Real workerd signing test | `scripts/test-runtime.ts` | Exercises the actual runtime crypto path. |

---

## 3. Problems

Severity reflects both today and the planned multi-tenant platform.

| # | Sev | Location | Problem and why it matters |
|---|---|---|---|
| P1 | **High** | Whole repo (not a git repo); `scripts/deploy.mjs:10-24,37` | **No version control, review, or CI.** Every deploy reads `.secrets/identities.json` and `.secrets/admin-token` on the operator's laptop and re-uploads the private keys. This means no history or rollback of source, one person can deploy, private keys sit on a workstation, and secrets are coupled to every deploy. Cloudflare recommends CI/CD to "simplify managing access to production credentials". |
| P2 | **High** (blocks multi-tenancy) | `src/signing-identities.ts:5-10`, `src/identity-names.ts`, `scripts/deploy.mjs:20-24`, `wrangler.jsonc:80-85`, `src/jobs.ts:10`, `scripts/provision.mjs:48-53`, `docs/extending.md` ("A different Pass Type ID needs its own certificate and binding") | **Per-tenant identities do not scale on this design.** Each Pass Type ID needs 2-3 Worker secrets plus a static mTLS binding, so onboarding a tenant means a config edit and a redeploy. Workers allow 128 vars+secrets per Worker (verified). Secrets Store is capped at 100 secrets per account and its bindings are also static (verified). Admin-uploaded certificates cannot be supported. |
| P3 | **Medium** | `wrangler.jsonc:22-25` (no `env`/`previews`); `README.md:68` | **No staging or preview environment.** Local development uses the production `PUBLIC_BASE_URL` and the real signing key. A pass issued locally embeds the production `webServiceURL` and a token production doesn't know, so devices register against prod. Every change is tested in production. |
| P4 | **Medium** | `src/index.ts:162-163` (`/p/:token`), `src/jobs.ts:13` (APNs URL contains the push token) | **Bearer secrets in URLs constrain observability.** Logging is correct today, but turning on traces records `url.full` and `url.path` on the fetch-handler root span and on outbound fetch spans (verified, spans-and-attributes doc). D1 spans record `db.query.text`, and R2 spans record object keys. Separately, Email Sending "Email preview" keeps message content about 7 days and is on by default for domains onboarded on or after 2026-07-02 (verified). Pass emails contain the bearer download link. **Check this setting on plrs.im (unverified for this account).** |
| P5 | **Medium** | `src/jobs.ts:46-53, 65-67, 84-91`; `wrangler.jsonc:47-55` | **Two retry systems overlap.** `processOutbox` catches every error, so the queue message is always acked: Queue retries and the DLQ never apply to email or push jobs, and only the cron re-enqueues them. `syncPass` does both things on failure: it sets `next_sync=+5min` and rethrows, which triggers `message.retry({delaySeconds:60})` up to 5 times. That is up to 6 upstream calls plus the cron re-dispatch per failure, then the message lands in a DLQ with no consumer (messages there expire after 4 days, verified). `docs/deployment.md:73` asks operators to "inspect wallet-jobs-dlq", but nothing in the app surfaces it. |
| P6 | **Medium** (scale) | `src/jobs.ts:73-82` | **The cron sweeper caps throughput.** Each minute it handles at most 100 due outbox rows and 100 due syncs, sending them with one `JOBS.send` each instead of `sendBatch` (up to 100 messages / 256 KB per call, verified). With the 900 s interval (`src/sources/index.ts:7`), at most about 1,500 passes can stay fresh. Polling is per pass, not per connection. |
| P7 | **Medium** (cost at scale) | `src/index.ts:66-88`, `src/status.ts:16-18` | **Full-scan queries on every admin view.** `json_extract(...) LIKE '%q%'` plus a separate `count(*)` per list page, and four `count(*)` scans per status refresh. D1 bills per row read. Thousands of tenants polling an admin console would cost rows-read on every view. |
| P8 | **Medium** | `scripts/deploy.mjs:8`, `scripts/provision.mjs:7,56`, `scripts/smoke.mjs:5`, `scripts/live-check.mjs:11`, `scripts/browser-check.mjs:7` | **JSONC treated as JSON.** Five scripts `JSON.parse` `wrangler.jsonc`, and `provision.mjs:56` rewrites it with `JSON.stringify`. The first comment anyone adds breaks every script, and the next provision run strips it. This also blocks JSONC-only documentation in the config. |
| P9 | Low-Med | `wrangler.jsonc:5-9`; `src/index.ts:30, 43-58` | **Every asset request runs the Worker.** `run_worker_first:true` routes all assets through the Worker. The Worker then re-buffers them (`Uint8Array.from(await loadAsset())`) and stamps `Cache-Control: no-store` on all responses. So every studio JS/CSS load and every email image open is a billed invocation with no edge caching, where direct asset requests would be free and unlimited (verified). "Private" template PNGs sit in the public asset directory and are protected only by Worker-first routing (`scripts/smoke.mjs:21`). |
| P10 | Low-Med | `src/types.ts:38-51`; `tsconfig.json:7` | **Hand-written `Env`.** It uses a `[binding: string]: unknown` index signature (needed for the dynamic `SIGNER_*` / `apnsBinding` lookups) and a custom `EMAIL` type. That defeats binding type safety. The `@cloudflare/workers-types` package is used instead of `wrangler types`, and there is no `secrets.required`. |
| P11 | Low | `scripts/deploy.mjs:28, 37, 45`; `docs/deployment.md:53` | **Deploys are all-or-nothing.** No D1 Time Travel bookmark is recorded before `migrations apply --remote`, and nothing enforces that migrations are backward-compatible. `wrangler deploy` goes straight to 100%: no `versions upload`, no smoke test on a version, no gradual rollout. A smoke failure "does not roll back". |
| P12 | Low | `src/passes.ts:23-24`, `README.md:91`, `src/email.ts:10-17` | **Unbounded storage growth with large passes.** Each `.pkpass` is about 5.7 MB (`artifacts/henrys-demo.pkpass`). Every edit writes a new R2 object and none are deleted. The `changes` table grows forever. Each email carries a 5.7 MB attachment, about 7.7 MB base64, which is under the 25 MiB cap (verified) but bad for deliverability at volume. |
| P13 | Low | `package.json` (wrangler 4.116.0, miniflare, sharp); `scripts/test-runtime.ts:14` | **Tooling behind and drifting.** Wrangler is behind the features this target needs: `wrangler preview` needs 4.135+, Workflow `exports` 4.139+, the Analytics SQL binding 4.145+ (all verified in docs). The compatibility date is duplicated in the workerd test config, so it drifts. `sharp` and `miniflare` are unused devDependencies (grep found no imports). |
| P14 | Low | `tests/helpers.ts:9-31` | **Tests run against fakes.** They use a hand-rolled `node:sqlite` D1 fake and a Map-based R2. Queue, cron, and email consumers never run in workerd. The fakes already needed special handling for D1 `meta.changes` trigger semantics, which shows the drift risk. |
| P15 | Low | `scripts/cloudflare.mjs:14-19`, `scripts/provision.mjs:31-81`, `scripts/dns-records.mjs`, `scripts/check-dns.mjs:18-23`, `scripts/live-check.mjs:16-22` | **Reimplemented tooling.** The scripts scrape the Wrangler OAuth token for raw REST calls (and accept the legacy Global API Key). They hand-create D1, R2, Queues, and the mTLS certificate, and reconcile Email DNS. Wrangler now auto-provisions D1, R2, KV, and Queues on deploy (verified), `wrangler mtls-certificate upload` exists, and Email Service onboarding writes and locks its own DNS records (verified; Cloudflare DNS is required anyway). The scripts also monkey-patch `dns.lookup` to get around a local negative DNS cache. |
| P16 | Low | `wrangler.jsonc:50-51`; `src/index.ts:99,114,132,139,152` | **Batching delay will hurt login emails.** `max_batch_timeout:5` adds up to 5 s before a message is processed. That is fine for pass emails but wrong for the planned magic-link emails. Each write also fires `dispatch()` in `waitUntil`, and concurrent dispatches enqueue duplicate IDs. Leases make that harmless but it wastes Queue operations. |
| P17 | Low | `wrangler.jsonc` (missing keys) | **Missing low-cost settings:** `upload_source_maps`, `version_metadata`, `observability.traces`, and explicit `head_sampling_rate` values. All are recommended in the current best-practices page (verified). |
| P18 | Info | `wrangler.jsonc:76-78` | `cpu_ms: 10000` applies to fetch, queue, and cron alike. Signing (native RSA, SHA-1 over about 5.5 MB, zip level 0) should take tens of ms **(unverified; measure with `cloudflare.cpu_time_ms` on trace root spans)**. Lowering the cap to about 2-3 s after measuring gives a tighter denial-of-wallet guard. |

---

## 4. Not modern best practice (and the modern alternative)

| Today | Modern alternative (verified unless marked) |
|---|---|
| Laptop deploys via `npm run deploy` with keys re-uploaded each time | Git (GitHub or GitLab) plus **Workers Builds**: the production branch runs `npx wrangler deploy`, and other branches run `npx wrangler preview` (the default Preview command for new Workers), with Preview URLs posted on PRs. Set secrets once with `wrangler secret put` or `versions secret put`, and declare them in `"secrets": {"required": [...]}` so deploy fails if any are missing. No secrets go in CI or on laptops. |
| No staging | **Worker Previews** (Sept 2026): a `previews` block with its own D1, R2, and queue bindings. Durable Objects get isolated namespaces per Preview automatically. Or a classic `env.staging`. Protect previews with Access "Previews only" so `preview_urls` can be turned on safely. |
| `wrangler deploy` at 100%, no backup point | `wrangler d1 time-travel info DB` to capture a bookmark → expand-only migration → `wrangler versions upload` → smoke test the version → `wrangler versions deploy` gradually. Rollback works across the 100 most recent versions (verified). Migrations follow expand/contract so the previous version keeps working. |
| `provision.mjs` + `cloudflare.mjs` REST calls | Bindings without IDs (D1, R2, KV, Queues are auto-provisioned on deploy), `wrangler mtls-certificate upload`, dashboard or `wrangler` Email onboarding. Keep a tiny idempotent script only for the mTLS upload and certificate-rotation bookkeeping. Or manage everything as code with Terraform or the new `cf` CLI. `cf` is in beta and needs wrangler 4.136+; I would not migrate config to `cloudflare.config.ts` yet. |
| `JSON.parse(wrangler.jsonc)` | Wrangler's own config reader, or `jsonc-parser`. Never rewrite the file programmatically. Let auto-provisioning write the IDs back. |
| Hand-written `Env` + `@cloudflare/workers-types` | `wrangler types` (generates both the `Env` and runtime types), driven by `secrets.required`. Remove the `[binding:string]: unknown` index signature by moving dynamic identities out of env (see section 5). |
| `run_worker_first: true` + Worker-served assets with `no-store` | `assets.not_found_handling: "single-page-application"` plus a `run_worker_first` array for `/api/*`, `/auth/*`, `/wallet/*`, `/p/*`, `/webhooks/*`, `/health` (globs and `!` negations supported, max 100 entries). Baked template art moves out of the public asset directory, into R2 or excluded with `.assetsignore`. Built with the **Cloudflare Vite plugin** for the new admin and portal SPA. |
| Node-side D1/R2 fakes | `@cloudflare/vitest-plugin` (named in the current best-practices page). Tests run in workerd with real local D1, R2, and Queue simulators and the real migration. |
| Outbox swallow + cron redelivery | Keep the outbox as the ledger. On transient errors, `throw` or `message.retry({delaySeconds: backoff})`; delays go up to 24 h (verified), and `retry_delay` can be set in config. Then `max_retries` and the DLQ actually work. Add a DLQ consumer that marks the outbox row `failed` and alerts. Keep the cron only as a lease-recovery sweeper. |
| Per-message `send` in a loop | `JOBS.sendBatch()` (100 messages / 256 KB per call). |
| "Email accepted ≠ delivered" caveat (`README` Verification section) | **Email Sending event subscriptions → Queue** (July 2026): `message.delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained`, joined to the outbox by `messageId`. Delivery state becomes real and visible to admins. |
| `count(*)` dashboards from D1 | **Workers Analytics Engine** events with `indexes:[tenantId]`. Writes are fire-and-forget. Read through the SQL API, or the new `analytics` Analytics SQL binding (wrangler 4.145+), which needs no API token. |
| Logs only | Turn on `observability.traces` (for example `head_sampling_rate: 0.05`) *after* fixing P4. `upload_source_maps: true`. OpenTelemetry export to Sentry/Grafana if wanted (`persist:false` keeps data out of Cloudflare storage). From 2026-12-01, persisted logs and traces count against 50 GB ingestion / 10 GB-month included, then $0.25/GB and $0.10/GB-month (verified). |
| `timingSafe` via hash + manual XOR (`src/util.ts:18-24`) | Fine as written. Workers exposes `crypto.subtle.timingSafeEqual` after hashing, as the docs pattern shows. Optional. |

---

## 5. Product adoption and target architecture

### 5.1 Verdicts

| Product | Verdict | One-line reason | Where it plugs in |
|---|---|---|---|
| Workers + Static Assets (SPA mode) | **ADOPT (keep)** | Single Worker serving the API, the Wallet protocol, and both SPAs; asset requests free and direct | `assets.not_found_handling:"single-page-application"` + `run_worker_first` array |
| Cloudflare Vite plugin | **ADOPT** | Standard toolchain for the new admin and portal SPA plus Worker in one project, with workerd in dev | Replaces `scripts/build-assets.mjs` esbuild step for the client |
| D1 | **ADOPT (keep)** | Relational, transactional; 10 GB per DB is enough for a shared multi-tenant schema (`tenant_id` on every row) | Add indexed generated columns or FTS5 for search, counters, sessions table |
| D1 Time Travel | **ADOPT** | Free 30-day point-in-time restore; just record a bookmark before each migration | `deploy` step: `wrangler d1 time-travel info` |
| D1 read replication / Sessions API | **CONSIDER** | Helps global Wallet GET traffic and `/p` pages; little benefit for one Seattle gym | Wallet protocol GETs, portal reads |
| R2 | **ADOPT (keep)** | Signed versions, template uploads, normalized template assets | Prefixes `passes/`, `templates/<tenant>/<id>/<ver>/`, `uploads/` with lifecycle (expire uploads, abort multipart uploads after 1 day) |
| R2 event notifications | **CONSIDER** | Only needed if browsers upload directly (presigned PUT needs extra R2 S3 credentials). Streaming `request.body` → `R2.put` from the Worker is simpler | `uploads/` object-create → queue → Workflow |
| Queues | **ADOPT (keep, fix)** | Fan-out for APNs and email, consumer for Email Sending events, DLQ | `wallet-jobs`, `wallet-jobs-dlq` (with consumer), `wallet-email-events` |
| Cron Triggers | **ADOPT (keep)** | Every minute costs about 43,200 invocations/month, under 0.5% of the included 10M; a fine lease sweeper. Add a daily cron for cert-expiry alerts and retention | `["* * * * *", "17 3 * * *"]` |
| Workflows | **ADOPT** | Durable multi-step jobs with per-step retries and visible status (`instance.status()`; `.subscribe()` streams events, which makes it a good source for live admin progress). 500k steps/month included, then $0.80/100k (verified) | Template import (unzip → validate → Images → R2 → publish), bulk re-issue on template change (`createBatch`), full connection sync runs |
| Durable Objects (SQLite) | **CONSIDER (strong, for connections)** | One object per API connection gives an alarm-driven schedule, a mutex (no overlapping poll and webhook), webhook dedupe, an upstream rate budget, last-N run log, and optional WebSocket hibernation for live admin status. New namespaces must be SQLite-backed (verified). Not needed for per-pass serialization: D1 CAS already covers that | `ConnectionCoordinator` DO; optional `AdminLive` hub |
| Images (binding) | **ADOPT** | `.info()` is free and validates format and dimensions. `.transform()` derives `@1x/@2x` from `@3x`. PNG output supported; 20 MB input cap; billed per unique transformation (verified) | Template-import Workflow step |
| Turnstile | **ADOPT** | Free; stops email-bombing through the magic-link form, which protects Email Sending quota and reputation | `/auth/magic-link` request + Siteverify in the Worker |
| Rate Limiting binding | **ADOPT** | GA; per-key, per-location approximate limits in code (verified). Use a DO if strict global limits are ever needed | Magic-link requests (per email and per IP), OIDC callback, `/wallet/v1/log`, device registration, tenant API keys, inbound webhooks |
| Workers Analytics Engine | **ADOPT** | High-cardinality event metrics per tenant without D1 scans | Pass issued, downloaded, registered, unregistered, push result, email event, sync result |
| Email Sending | **ADOPT (keep)** | Already integrated; add event subscriptions; consider per-tenant sending subdomains to isolate reputation (a zone allows up to 30 sending/routing domains, verified) | `send_email` with login + passes senders |
| Email Routing | **SKIP** (for now) | No inbound-mail requirement yet. Revisit for support@ forwarding | n/a |
| Workers mTLS | **ADOPT (keep)** | Still the only way to do certificate-based APNs; see P2 and open question Q1 | `APNS` binding(s) |
| Secrets Store | **CONSIDER** | Useful only if you split into several Workers that share platform secrets (KEK, OIDC client secret). **Not** a home for per-tenant certificates (100-secret account cap, static bindings) | KEK, OIDC secret |
| Per-tenant signing keys | **ADOPT pattern** | Store certificate and key envelope-encrypted in D1 (AES-GCM via WebCrypto), with a KEK in a Worker secret, rotated by version (`KEK_V1`, `KEK_V2`) | Replaces `SIGNER_<ID>_*` secrets |
| KV | **SKIP** (v1) | Sessions and magic-link tokens need single-use, strongly consistent revocation (D1). JWKS/discovery fit the isolate memory or Cache API. Revisit only for hostname→tenant lookups if you adopt custom hostnames | n/a |
| Cache API / Workers Caching | **CONSIDER (Cache API only)** | Cache API for Pocket ID JWKS/discovery. Workers Caching bills cache hits as requests (verified), so serving public images as assets is better | OIDC module |
| Access | **CONSIDER (narrow)** | Use for platform-operator surfaces and to protect Preview URLs. **Not** for tenant admins or members: per-seat Zero Trust pricing, and in-app Pocket ID OIDC + magic links is the requirement. Note `ctx.access` is not passed through the Static Assets router (verified), so you would have to validate `Cf-Access-Jwt-Assertion` yourself | Previews, `/ops/*` |
| Zero Trust (Gateway/Tunnel/WARP) | **SKIP** | No private network or workforce-egress problem | n/a |
| Workers Logs | **ADOPT (keep)** | Keep `invocation_logs:false`; set explicit sampling | config |
| Traces + OpenTelemetry export | **ADOPT after P4** | Root spans record `url.full` and D1 spans record SQL text; remove bearer tokens from paths or accept the 7-day retention | config |
| Tail Workers | **CONSIDER** | Only if you want redaction or aggregation into Analytics Engine | separate small Worker |
| Logpush | **SKIP** | OpenTelemetry export covers the need; Logpush now has GB-based pricing (verified) | n/a |
| Smart Placement / targeted placement | **CONSIDER** | Requests do 3-5 sequential D1 round trips; measure first. Only with the narrowed `run_worker_first` (docs warn Worker-first assets get slower when Smart Placement moves the Worker) | `placement` |
| Custom Domains | **ADOPT (keep)** | Already used | `wallet.plrs.im` |
| Cloudflare for SaaS (custom hostnames) | **CONSIDER, decide early** | Tenants may want `passes.<theirdomain>`. `webServiceURL` is baked into every signed pass, so it is hard to change later | Q2 |
| WAF managed rules / rate limiting rules | **CONSIDER** | Zone-level defense in depth for `/auth/*`, `/wallet/*`; depends on the plrs.im plan **(unverified)** | zone |
| Workers Builds + Previews | **ADOPT** | Fixes P1 and P3 with native tooling | repo |
| Version metadata binding | **ADOPT** | Free; put the version ID in logs, status, and Analytics Engine | `version_metadata` |
| Hyperdrive | **SKIP** | No external Postgres or MySQL. Revisit only if a "connection" ever means a customer database | n/a |
| Vectorize / AI Search | **SKIP** | No retrieval use case | n/a |
| Workers AI | **SKIP** (v1) | The only honest use is an optional "suggest field mapping from a sample API response" helper in the connection wizard; not worth it yet | n/a |
| Browser Run (Rendering) | **SKIP** (v1) | iOS renders passes, so an HTML screenshot is only an approximation. Maybe later for template-gallery thumbnails | n/a |
| Flagship, Pipelines, Workers for Platforms, Containers | **SKIP** | No requirement; this would be product-stuffing | n/a |

### 5.2 Recommended target `wrangler.jsonc` (bindings sketch)

Requires wrangler ≥ 4.145 for `analytics`, ≥ 4.139 if you use `exports` for Workflows or DOs, and ≥ 4.135 for `wrangler preview`. Treat it as a sketch. Field names are checked against the 4.116 schema and the current docs.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "wallet",
  "main": "src/worker/index.ts",
  "compatibility_date": "<date of upgrade>",
  "compatibility_flags": ["nodejs_compat"],
  "upload_source_maps": true,
  "workers_dev": false,
  "preview_urls": true,                       // only with Access "Previews only" enabled
  "routes": [{ "pattern": "wallet.plrs.im", "custom_domain": true }],
  "assets": {                                 // directory supplied by the Vite plugin build
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/auth/*", "/wallet/*", "/p/*", "/webhooks/*", "/health"]
  },
  "vars": { "PUBLIC_BASE_URL": "https://wallet.plrs.im", "EMAIL_FROM": "passes@plrs.im",
            "LOGIN_FROM": "login@plrs.im", "OIDC_ISSUER": "https://id.plrs.im", "TURNSTILE_SITE_KEY": "…" },
  "secrets": { "required": ["SESSION_KEY", "OIDC_CLIENT_SECRET", "KEK_V1", "TURNSTILE_SECRET",
                            "PLATFORM_SIGNER_CERTIFICATE", "PLATFORM_SIGNER_PRIVATE_KEY"] },
  "d1_databases": [{ "binding": "DB", "database_name": "wallet", "database_id": "…", "migrations_dir": "migrations" }],
  "r2_buckets":   [{ "binding": "BUCKET", "bucket_name": "wallet-passes" }],   // prefixes: passes/ templates/ uploads/
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "wallet-jobs" }],
    "consumers": [
      { "queue": "wallet-jobs", "max_batch_size": 10, "max_batch_timeout": 1, "max_retries": 8,
        "retry_delay": 30, "dead_letter_queue": "wallet-jobs-dlq" },
      { "queue": "wallet-jobs-dlq" },          // marks outbox failed + alerts admins
      { "queue": "wallet-email-events" }       // Email Sending event subscription
    ]
  },
  "workflows": [
    { "name": "wallet-template-import", "binding": "TEMPLATE_IMPORT", "class_name": "TemplateImport" },
    { "name": "wallet-bulk-reissue",    "binding": "BULK_REISSUE",    "class_name": "BulkReissue" },
    { "name": "wallet-connection-sync", "binding": "CONNECTION_SYNC", "class_name": "ConnectionSync" }
  ],
  "durable_objects": { "bindings": [{ "name": "CONNECTIONS", "class_name": "ConnectionCoordinator" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ConnectionCoordinator"] }],  // or the newer `exports` form
  "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["passes@plrs.im", "login@plrs.im"] }],
  "mtls_certificates": [{ "binding": "APNS", "certificate_id": "…" }],             // see Q1
  "images": { "binding": "IMAGES" },
  "ratelimits": [
    { "name": "RL_LOGIN",   "namespace_id": "1001", "simple": { "limit": 5,   "period": 60 } },
    { "name": "RL_PUBLIC",  "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } },
    { "name": "RL_API_KEY", "namespace_id": "1003", "simple": { "limit": 600, "period": 60 } }
  ],
  "analytics_engine_datasets": [{ "binding": "EVENTS", "dataset": "wallet_events" }],
  "analytics": { "binding": "ANALYTICS_SQL" },          // wrangler ≥ 4.145
  "version_metadata": { "binding": "CF_VERSION" },
  "triggers": { "crons": ["* * * * *", "17 3 * * *"] },
  "observability": {
    "enabled": true,
    "logs":   { "invocation_logs": false, "head_sampling_rate": 1 },
    "traces": { "enabled": true, "head_sampling_rate": 0.05 }   // only after P4 is addressed
  },
  "limits": { "cpu_ms": 3000 },                          // after measuring
  "previews": { /* separate D1/R2/queue bindings + full trace sampling */ }
}
```

Architecture notes:

- **Identities.** Option A: one platform Pass Type ID, one mTLS binding, `organizationName` per tenant. That is the simplest and scales to unlimited tenants. Option B (BYO Apple certificate per tenant): certificates and keys stored encrypted in D1 for signing. APNs still needs one static mTLS binding per Pass Type ID, which means a provisioning pipeline that uploads the certificate and ships a new Worker version. That can be automated through Workers Builds, but it is heavyweight. Apple requires certificate-based APNs auth for Wallet pass pushes; token (.p8) auth is not accepted. **(High confidence, unverified in this session against Apple docs.)**
- **Jobs.** The outbox stays as the ledger. Queue consumers throw on transient errors and use `delaySeconds` backoff; the DLQ consumer finalizes failures; the cron is only a sweeper. Bulk operations become Workflows that enqueue in `sendBatch` chunks.
- **Connections.** Poll per connection, not per pass. One `ConnectionCoordinator` DO per connection holds the schedule (alarm), lock, status, and webhook dedupe, and starts a `ConnectionSync` Workflow run for multi-page work. Admins read status from the DO or D1, and live progress from `instance.subscribe()`.
- **Templates.** Upload streams to `R2 uploads/` from the Worker, with a size cap enforced by the Worker instead of the global 32 KB `bodyLimit` (`src/index.ts:22`). The `TemplateImport` Workflow then unzips (fflate), runs `IMAGES.info()` and transforms, writes normalized assets to `templates/<tenant>/<id>/<ver>/`, and records the version in D1. Baked templates use the same path from a seed.
- **Pass size.** Enforce Apple's recommended image dimensions in import. The current 1.7 MB `@3x` backgrounds make every pass about 5.7 MB, which multiplies R2, email, and download costs. Delete superseded R2 versions after a grace period (a delayed queue message), not with a blanket lifecycle rule.

### 5.3 Cost and limits notes

| Concern | Assessment |
|---|---|
| Cron every minute | About 43,200 invocations/month, each with 2 indexed D1 queries. Negligible against 10M included requests and 30M CPU-ms (verified pricing). Keep it. |
| CPU for signing | Native WebCrypto RSA + SHA-1 over about 5.5 MB per pass. Expected well under 100 ms **(unverified; measure)**. Paid default is 30 s, configurable up to 5 min (verified). Bulk re-issue belongs in Workflows or Queues, not request handlers. |
| D1 | 10 GB per DB, 1 TB per account, 100 bound params per query, 30 s max query, 1,000 queries per invocation (a batch counts as 1), 2 MB per row (verified). A 50 MB result cap is enforced from 2026-11-04 (verified); the list endpoints are fine. Rows-read cost is the real risk (P7). |
| Queues | 128 KB per message, batch ≤ 100, `sendBatch` ≤ 100 / 256 KB, delay ≤ 24 h, retention 4 days by default (up to 14 on Paid), $0.40/M ops at about 3 ops per message (verified). Current volume is trivial. |
| Email Sending | 25 MiB per message including attachments, ≤ 50 recipients, conservative daily quota for new accounts that rises with reputation (verified, no published number). One tenant's bounces hurt all tenants: use sending subdomains, plus Turnstile and rate limits on login emails. |
| Workflows | 10k steps per instance by default (up to 25k), 1 MiB step result, 50k concurrent instances, 30-day max retention (7-day default for new Workflows) (verified). |
| Observability | 50 GB/month ingestion included from 2026-12-01 (verified). Logs at 100% plus traces at 5% are comfortably inside that at gym scale. |
| Workers vars | 128 vars+secrets per Worker, 5 KB each (verified). This drives the P2 redesign. |

---

## 6. Open questions only the owner can answer

1. **Q1 Apple identities.** Will tenants bring their own Apple Developer Pass Type IDs and certificates, or will all passes be issued under a platform-owned Pass Type ID (team 48H7CLBV8Y or a new one)? This decides between one mTLS binding and a redeploy per tenant (P2).
2. **Q2 Domains.** Will all tenants share `wallet.plrs.im`, or do any need their own hostname (Cloudflare for SaaS)? `webServiceURL` is signed into every pass.
3. **Q3 Email identity.** Send everything from `passes@plrs.im` with a per-tenant display name, or per-tenant sending subdomains or domains? Tenant domains must be on Cloudflare DNS to onboard.
4. **Q4 Scale targets.** In 12 months: how many tenants, passes, updates per day, connections, and what polling intervals? This decides whether one shared D1 and the cron sweeper suffice, or DO-per-connection is needed now.
5. **Q5 Plans and budget.** Is the account on Workers Paid (implied by `docs/deployment.md:27`)? What is the plrs.im zone plan (WAF rate-limit rules)? Is Zero Trust seat count or Access in scope? Is Images on the current (non-legacy) billing?
6. **Q6 Source control and CI.** GitHub or GitLab? Workers Builds or GitHub Actions? Can production signing keys live only in Cloudflare secrets, removed from laptops after import?
7. **Q7 Staging certificates.** Is a separate Pass Type ID acceptable for staging and previews, or will staging use test certificates and never touch real devices?
8. **Q8 Data residency.** Any EU or other residency needs? D1, R2, Queues, and Workflows all support jurisdictions (D1 `us` added Oct 2026). These must be chosen at creation time.
9. **Q9 Retention.** How long to keep superseded pass versions, `changes` rows, outbox and delivery history, and email previews?
10. **Q10 Bearer links.** Once member sign-in exists, may `/p/:token` links become short-lived or session-gated? That unblocks safe tracing (P4).
11. **Q11 Webhooks.** For API connections, which upstreams push webhooks, and with what signing scheme (HMAC secret per connection)?
12. **Q12 Pocket ID.** Does `id.plrs.im` issue a `groups` claim usable for the admin and user roles? Should the platform-operator console also sit behind Access?
