# Blue Team 1 — Platform Defensive Controls Audit

## Inspected boundaries

Read-only review of platform authentication, crypto, safe-fetch, errors/logging/rate limits; Worker entrypoints/configuration; queues, cron and four workflows; audit/status; CI, dependencies and deployment/recovery references. Also independently counterchecked the requested test-key/production-connection flow.

Paths below are relative to `/Users/vlad/Repos/wallet`. **Acceptance checks are proposed, not executed.**

## Findings

### 1. P1 — Test API keys can obtain production connector data
**Confidence: confirmed-source.**

A test-mode `passes:write` key can create or bind its own test pass to a known same-org connection and unused upstream reference:

- `src/worker/modules/passes/routes-write.ts:56-60` accepts the binding while retaining the key’s test mode.
- `passes/create.ts:71-76,120-128` checks organization ownership only and marks inputs connection-owned.
- `passes/connection-bind.ts:34-50,65-66` also accepts the binding and queues refresh.
- `connections/jobs.ts:28-29,56-67` fetches using production connector credentials without checking pass mode.
- `connections/repo-passes.ts:26,49,77-81` omits mode from synchronization records/selectors.

Mapped production fields reach the test pass. Even **without `passes:read`**, `PATCH /passes/{testId}` with `{}` returns personalization through `passes/service.ts:104` and `passes/detail.ts:176`.

**Counter-controls:** Active organization, enabled connection, compatible mapped fields and known connection/reference are required. Cross-org access is blocked. The unique index at `migrations/0001_platform.sql:322-323` blocks references already bound to live passes—but permits unused references. A test binding can consequently intercept a future live import.

This conflicts with `docs/api.md:31-36` and `passes/scope.ts:5-7`.

**Fix:** Reject test-pass production bindings at creation/rebinding and enforce live-only connection execution, including legacy bindings.

**Acceptance:** With a test write-only key and distinctive upstream fixture, creation/rebinding must fail before fetching; refresh, polling and webhooks must not populate test passes. Live operations remain functional.

### 2. P2 — Daily job wrapper hides configured encryption keys
**Confidence: confirmed-source.**

`src/worker/jobs/query-counter.ts:53-54` constructs `Object.create(env)` with only an own `DB` property. `jobs/cron.ts:65-76` passes this object to daily hooks. However, `platform/crypto.ts:40-45` discovers KEKs using `Object.entries`, excluding inherited properties.

With cold caches, valid database signing identities fail decryption through `modules/identities/db-resolver.ts:47`; stored APNs keys fail through `push-key-store.ts:35`. Checks persist misleading unreadable/failing health.

**Counter-controls:** Environment-backed identities and warm key caches mask the defect. Stored ciphertext is not corrupted.

**Fix:** Preserve environment property enumeration when replacing DB.

**Acceptance:** Run daily checks with cold caches, a valid encrypted identity and APNs key; neither should report missing KEK/unreadable credentials.

### 3. P2 — Budget deferrals can exhaust retries before execution
**Confidence: inference; source path confirmed, rebatching unverified.**

`src/worker/jobs/queue.ts:68-71` calls `retry()` before dispatch when the query budget is exhausted. A 20-reference webhook costs 530 against an 800 budget (`query-budget.ts:4-16`), admitting only one per invocation.

With batch size 10 and eight retries (`wrangler.jsonc:93-97`), repeatedly batched deferred messages can reach DLQ without execution. `modules/delivery/jobs.ts:43-46` merely logs non-delivery dead letters; `jobs/queue.ts:35-36` acknowledges them. Webhook deduplication then suppresses sender retransmission (`connections/webhooks.ts:64-67`).

CloudflareRuntime corroborated delivery-attempt semantics against [Cloudflare’s primary documentation](https://developers.cloudflare.com/queues/configuration/batching-retries/#apply-a-backoff-algorithm).

**Fix:** Separate scheduling deferral from failure retries and retain recoverable webhook terminal state.

**Acceptance:** Process ten expensive jobs under constrained batching; every job must execute or remain durably recoverable—not disappear through deferral exhaustion.

### 4. P2 — Invalid API credentials bypass application throttling
**Confidence: confirmed-source.**

`src/worker/platform/auth.ts:166-172` resolves presented keys before any anonymous-request limiter. `modules/api-keys/service.ts:134-143` performs D1 prefix lookup and rejects invalid credentials **before** enforcing `RL_API_KEY`.

Anonymous callers can therefore generate unrestricted application-level database lookups using correctly shaped invalid keys.

**Counter-controls:** Authentication still fails; valid keys receive the configured quota. External WAF protections were not inspected.

**Fix:** Apply pre-authentication abuse limiting before credential-store access, retaining authenticated-key quotas.

**Acceptance:** Repeated shaped invalid keys receive early 429s with bounded D1 lookups; legitimate per-key accounting remains independent.

### 5. P2 — Safe-fetch deadlines exclude DNS resolution
**Confidence: confirmed-source.**

`src/worker/platform/safe-fetch.ts:177-188` performs sequential DoH requests without cancellation. `:209-211` creates the timeout and incorporates caller cancellation only **after** DNS completes. Save-time validation also uses this unbounded resolver (`modules/connections/validate.ts:57-63`).

Slow upstream DNS can exceed the advertised deadline and ignore cancellation before the actual fetch.

**Counter-controls:** HTTPS/443, private-address rejection, redirect blocking and response-byte caps remain effective; this is not evidence of private-network access.

**Fix:** Propagate one deadline/cancellation signal through DNS and HTTP, including save-time validation.

**Acceptance:** A stalled resolver must terminate within the configured deadline; an already-aborted caller must initiate no lookup.

### 6. P2 — Cron health can remain verified despite hook failures
**Confidence: confirmed-source.**

`src/worker/jobs/cron.ts:82-91` records a fresh minute heartbeat after rejected hooks. Daily health is recorded by the middle `audit.retention` hook (`modules/audit/jobs.ts:21`), before subsequent daily hooks finish. `modules/status/cron-check.ts:40-45` interprets freshness as verified.

Failed or skipped maintenance can therefore coexist with verified cron health.

**Counter-controls:** Hook failures and budget skips are logged; this is a dashboard/detection gap, not silent execution.

**Fix:** Persist per-hook outcomes and completion separately from scheduler liveness.

**Acceptance:** Inject a failure or budget skip before and after audit retention; Status must identify the affected hook rather than show unqualified verified health.

## Strengths and limitations

- Admins are intentionally platform-wide; scoped API keys have organization/mode controls. Session revocation, disabled-user checks, CSRF and secure host-only cookies were traced.
- OIDC validates signature, issuer, audience, nonce, freshness and browser-bound one-shot flows.
- Encryption uses fresh DEKs/IVs and record/tenant/kind AAD. Logging uses route templates and layered redaction; invocation logging is disabled.
- CI uses SHA-pinned actions, read-only default permissions, `npm ci` and production dependency auditing. Current advisory status and repository protection settings were not verified.
- Recovery documentation records D1 bookmarks and requires external KEK backup. **Operational recommendation, not a separately proven vulnerability:** demonstrate coordinated D1/R2/KEK restoration after retention deletion and measure recovery objectives.

No edits, secret-value reads, external network calls, payload execution, builds or tests were performed. Urgent scanner disclosures supplied by BlueScannerNative were relayed separately and are not counted as independently reviewed findings here.
