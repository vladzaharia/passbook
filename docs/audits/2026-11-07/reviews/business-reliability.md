# Partner reliability and incident operations audit

## Evidence boundary and verdict

Read-only baseline audit; these are not attributed to the unrelated working-tree patch. No edits, builds, tests, secret-value reads or external calls were performed. Account quotas, deployed alerts, log retention and backups remain unverified.

**Partners can inspect individual pass deliveries and broadcast outcomes, but cannot independently diagnose connector failures or reliably replay accepted webhook work.** This is not ready for an unattended, business-critical connector SLA.

Severity: **P1 blocker**, **P2 high**, **P3 gap/recommendation**. Implementation facts below are source-confirmed; failure consequences are inferred from those paths. Acceptance scenarios are proposed, not executed.

## Positive controls

- All four queue message kinds have explicit consuming dispatch branches: `src/worker/jobs/registry.ts:9-27`.
- Delivery has persisted outbox state, leases, expired-lease recovery and lost-enqueue redispatch: `src/worker/modules/delivery/jobs.ts:26-30`; `repo-outbox.ts:232-263`.
- Partners can read delivery states through pass details and inspect pass events/devices: `src/worker/modules/passes/detail.ts:161-196`; `src/worker/modules/events/routes.ts:12-48`.
- Broadcast APIs expose progress, per-pass outcomes and retry: `src/worker/modules/broadcasts/routes.ts:117-122,170-214`.
- Connector errors use stable codes without echoing upstream bodies: `src/worker/connectors/lib/http.ts:37-81`.

## Findings

### 1. P1 — Make accepted webhook work durably recoverable

**Persona / stage / action:** CRM integration operator; ongoing synchronization; recover an accepted update after infrastructure failure.

Deduplication is persisted before inbox storage and queue sends; duplicate deliveries subsequently return without dispatching (`src/worker/modules/connections/webhooks.ts:64-85`). Ordinary enqueue exceptions delete the dedup marker, but execution termination bypasses that catch. Separately, preparation failures return normally (`:111-120`), and exhausted non-delivery jobs are merely logged and acknowledged (`src/worker/modules/delivery/jobs.ts:43-46`; `src/worker/jobs/queue.ts:31-36`).

**Impact:** A webhook-only partner can receive acceptance yet permanently miss an update; resending the same event does not repair it.

**Fix:** Persist receipt, payload and dispatch progress transactionally; resume incomplete dispatch on duplicate intake; retain replayable terminal failures and retry transient preparation failures.

**Acceptance:** Interrupt intake after deduplication and between chunks; fail one credential read; exhaust processing retries. Every accepted reference must eventually apply or remain explicitly recoverable.

These materially affect interoperability and cross-reference prior reports **13-cloudflare-runtime §1–2**, **07-code-backend §5**, and **11-blue-platform §3**.

### 2. P2 — Prevent delayed snapshots from overwriting newer records

**Persona / stage / action:** Loyalty partner; retry recovery; update the same member repeatedly.

Webhook-push stores embedded snapshots (`src/worker/connectors/webhook-push/index.ts:78-104`). Processing loads the stored record without a source revision (`src/worker/modules/connections/webhooks.ts:122-131`); publication overwrites connection-owned fields (`src/worker/modules/passes/connection-passes.ts:48-56`).

**Impact:** If event A fails before application, event B succeeds, and A subsequently retries, A can restore older fields. Distinct event IDs and pass CAS do not establish source ordering. Manual-owned fields remain protected.

**Fix:** Carry a monotonic source revision and atomically reject older revisions at publication, or fetch authoritative current state instead of replaying snapshots.

**Acceptance:** Process B, then retry A for the same reference. The newer data must remain published and A must record a superseded outcome.

### 3. P2 — Persist refresh intent before reporting coalesced acceptance

**Persona / stage / action:** API integrator; transient outage; retry a refresh request.

`requestRefresh` commits its cooldown claim before sending the queue message (`src/worker/modules/passes/service.ts:254-260`). There is no persisted refresh dispatch intent or rollback here. A retry inside that window returns as coalesced, and the route answers 202 (`src/worker/modules/passes/routes.ts:159-164`).

**Impact:** A failed queue send can be followed by apparent acceptance despite no refresh being queued. The delivery outbox sweeper does not recover this separate job type.

**Fix:** Persist refresh requests with recoverable dispatch state; coalesce only against an outstanding operation.

**Acceptance:** Fail `JOBS.send`, immediately retry, then restore service. The accepted operation must execute without waiting for another manual request.

### 4. P2 — Expose refresh failure separately from attempted completion

**Persona / stage / action:** Partner support engineer; incident diagnosis; determine whether source data refreshed.

Upstream refresh errors are recorded in connection runs and swallowed (`src/worker/modules/connections/jobs.ts:75-80`). The handler still re-pushes and updates `lastRefreshedAt` (`:94-98`). Connection-run access requires an admin session (`src/worker/modules/connections/routes.ts:43,193-211`).

**Impact:** A partner can observe a recent refresh timestamp and successful push while the source fetch failed. This does not establish data freshness.

**Fix:** Return an operation ID and expose scoped attempted/succeeded timestamps, terminal outcome and sanitized error code. Preserve the useful catch-up push independently.

**Acceptance:** Force upstream 401, 429 and timeout. Partner credentials must distinguish each failure from an unchanged successful refresh.

### 5. P2 — Honor upstream backoff during webhook processing

**Persona / stage / action:** Upstream API owner; throttling incident; recover without repeated quota violations.

HTTP 429 captures `retryAfterMs` (`src/worker/connectors/lib/http.ts:65-72`). Scheduled sync respects it (`src/worker/modules/connections/health.ts:85-97`), but webhook processing throws a new error without that delay (`webhooks.ts:138-140`); queue retry uses generic exponential backoff (`src/worker/jobs/queue.ts:85`; `retry.ts:4-6`).

**Impact:** A partner requesting a ten-minute pause can receive another attempt after thirty seconds. The parser also accepts only numeric `Retry-After`, not HTTP-date values (`connectors/lib/http.ts:32-34`).

**Fix:** Preserve retry disposition and not-before time through queue dispatch; support both header forms.

**Acceptance:** Return 429 with numeric and dated ten-minute delays. No retry for that failed operation should reach the upstream early.

### 6. P2 — Distinguish execution completion from business success in Status

**Persona / stage / action:** Operations owner; incident detection; decide whether synchronization recovered.

A failed connection run is marked `error`, while its Workflow is marked `complete` (`src/worker/modules/connections/health.ts:52-64`). Bulk reissue likewise records `complete` with `PARTIAL_FAILURE` (`src/worker/workflows/bulk-reissue.ts:47-53`). Workflow health counts only `errored` statuses (`src/worker/modules/status/checks.ts:108-123`).

Queue health also loses its terminal-failure signal after the DLQ drains, as documented in prior **14-cloudflare-ops §3**. Connection-health components and retained delivery rows provide partial countercontrols.

**Fix:** Aggregate business failures, overdue operations and unresolved dead letters separately from runtime completion. Define alert ownership and acknowledgement; account alert configuration is unverified.

**Acceptance:** Fail a sync, partially fail a rebuild, drain a dead letter, and fail a cron hook. Each unresolved impact must remain discoverable. Cron heartbeat limitations are already covered by **11-blue-platform §6**.

### 7. P3 — Provide narrow partner diagnostics and controlled backfill

**Persona / stage / action:** Partner incident responder; recovery; locate and repair missing updates.

Status and connection management are intentionally admin-only (`src/worker/modules/status/routes.ts:12`; `connections/routes.ts:43`). “Sync now” resumes the existing cursor (`connections/sync.ts:102`); the update schema provides no cursor reset or replay operation (`src/shared/contracts/connections.ts:153-164`).

HTTP requests receive correlation IDs, but queue envelopes omit them; webhook runs generate unrelated IDs (`platform/context.ts:54-63`; `jobs/types.ts:4-18`; `connections/webhooks.ts:106-108`).

**Recommendation:** Preserve admin-only configuration. Add narrowly scoped receipt/outcome lookup and bounded replay/backfill, carrying request, event, operation, run and queue-message identifiers without payloads or credentials.

**Acceptance:** A partner can diagnose and repair its own failed reference, cannot access another organization, and cannot accidentally replay successful work.

## Cloudflare and partner operating contract

Publish these existing bounds and their recovery implications:

- **Capacity:** Worker CPU cap 10,000 ms; queue batches ten with eight retries (`wrangler.jsonc:90-99,152-154`). Webhooks allow 256 KiB and 100 records/references; processing chunks contain twenty (`connectors/lib/hmac.ts:9`; `webhook-push/index.ts:12`; `http-json/index.ts:19`; `connections/sync.ts:43`).
- **Deadlines:** HTTP defaults to fifteen seconds and 256 KiB, but DNS precedes deadline creation (`platform/safe-fetch.ts:209-211`). Fix and verify the previously reported DNS-deadline gap before promising an end-to-end timeout.
- **Signing/statuses:** HMAC covers timestamp plus body; freshness is five minutes past/one minute future (`connectors/lib/hmac.ts:23-34,63-65`). Document stable event IDs, fresh signatures on retransmission, and acceptance versus application. Intake operational preparation errors currently become 404 (`connections/webhooks.ts:51-60`), so a blanket “never retry 4xx” policy is unsafe.
- **Recovery window:** Inbox/dedup retention is seven days; runs are limited to thirty days/1,000 per connection (`connections/jobs.ts:16-18,111-113`). Define replay retention, reconciliation frequency, support escalation and measurable RPO/RTO.
- **Failure semantics:** Treat disconnects and non-JSON platform errors as ambiguous, not proof of rollback. `/health` is liveness only (`src/worker/app.ts:122`), not connector readiness. Verify account caps, alert delivery and coordinated D1/R2/KEK restoration separately.
