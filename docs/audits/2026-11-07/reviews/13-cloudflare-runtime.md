# Cloudflare usage I — runtime correctness and fit

## Scope and inventory

Read-only baseline audit of configuration, Worker entrypoints, platform helpers, queue/cron dispatch, all four Workflows, delivery, connections, and scanner live transport. Paths below are relative to `/Users/vlad/Repos/wallet`. The current diff is Android-only; these are **baseline findings, not attributed patch regressions**.

| Binding/service | Configuration and actual consumers |
|---|---|
| **D1 `DB`** | `wrangler.jsonc:74-82`; tenant repositories, authentication, scans, outbox, workflow tracking. Atomic batch/CAS helpers: `src/worker/platform/db.ts:45-56,85-102`. |
| **R2 `BUCKET`** | `wrangler.jsonc:83`; signed passes, template staging/assets, branding and photos. Publication: `modules/passes/publish.ts:188-226`; imports: `modules/templates/import-pipeline.ts:72-229`. |
| **Queues `JOBS`, `JOBS_DLQ`** | `wrangler.jsonc:85-99`; push, email, refresh and webhook handlers explicitly dispatched in `src/worker/jobs/registry.ts:9-32`. DLQ finalization: `modules/delivery/jobs.ts:43-61`; DLQ producer binding also supplies status metrics. |
| **Four Workflows** | `wrangler.jsonc:103-115`; template import, bulk reissue, broadcast and connection sync are exported by `src/worker/index.ts:8-11` and launched by their owning modules. Minute/daily crons: `wrangler.jsonc:150`, `src/worker/jobs/cron.ts:26-46`. |
| **Durable Object `SCAN_HUB`** | `wrangler.jsonc:11-12`; one object per org/mode (`modules/scan/live.ts:10-11`), providing bounded history and hibernating WebSockets. |
| **Email `EMAIL`** | Sender-restricted binding, `wrangler.jsonc:118`; shared mailer (`modules/delivery/mailer.ts:31-55`) serves pass/bundle and authentication email. |
| **Analytics** | `EVENTS` and remote `ANALYTICS_SQL`, `wrangler.jsonc:145-147`; event writer and metrics query/fallback consumers exist. |
| **13 rate limiters** | `wrangler.jsonc:125-142`; login, magic links, public assets/downloads, Apple, API keys, webhook, refresh and scanner flows. Missing bindings fail closed (`platform/rate-limit.ts:21-30`). |
| **mTLS `APNS`** | `wrangler.jsonc:156-161`; delivery transport uses the identity-selected binding, otherwise a team push key (`modules/delivery/apns.ts:151-163`). |
| **Other bindings** | `ASSETS` serves documents/static resources; `IMAGES` processes template/branding/pass images; `CF_VERSION` labels logs/status (`wrangler.jsonc:20,123,148`). |

## Findings

### 1. P1 — Persist recoverable webhook dispatch before deduplicating
**Confidence: confirmed-source.** `modules/connections/webhooks.ts:64-67` permanently records an event before inbox persistence and queue sends (`:77-85`). Termination between those operations leaves subsequent sender retries acknowledged as duplicates, with no recovery dispatcher. Webhook-only connections can permanently miss updates. The catch-and-delete control handles ordinary exceptions, not termination.

**Fix:** transactionally persist the event, payload and pending dispatch chunks; resume incomplete dispatch on duplicate delivery or sweep.

**Acceptance:** interrupt after event insertion, resend the same signed event, and confirm every reference eventually applies.

### 2. P1 — Retry deferred records before advancing the change cursor
**Confidence: confirmed-source.** `modules/connections/records.ts:192-194` converts exhausted publish CAS conflicts into `deferred`. `addOutcome` ignores that variant (`:41-46`), so processing reports no failure and `sync-runner.ts:149-155` advances the page cursor. For `listChanges` connectors, leaving the pass “due” does not recover it: that execution branch does not read due-pass references. Webhook processing similarly acknowledges the unapplied record.

**Fix:** propagate a retryable incomplete outcome and prevent cursor advancement/acknowledgement until applied.

**Acceptance:** inject `PASS_CONFLICT`, then remove contention; verify the original record applies without another upstream change.

### 3. P2 — Fence connection generation in the committing SQL
**Confidence: confirmed-source.** `modules/passes/connection-passes.ts:40-44` checks generation before asynchronous building/publication. The final write checks only pass ID/version (`modules/passes/repo-write.ts:142`). A mapping/configuration change during the build increments connection generation but need not change pass version; the obsolete run can still publish its old mapped values.

**Fix:** enforce connection identity/generation atomically with the content write, including metadata-only publication.

**Acceptance:** pause an old-generation build, change mapping, resume it, and verify no obsolete content/version/outbox write commits.

### 4. P1 — Preserve creation artifacts after ambiguous D1 failures
**Confidence: inference grounded in source/platform failure semantics.** `modules/passes/create.ts:143-144` deletes the uploaded object for every insertion error. If the insert committed but its response was lost, the persisted pass references a deleted `.pkpass`; an idempotent retry can return that broken pass. Publication already explicitly protects this ambiguity (`modules/passes/publish.ts:220-223`).

**Fix:** delete immediately only for definitive rolled-back failures; preserve ambiguous artifacts for reconciliation.

**Acceptance:** lose the D1 response after committing insertion; the persisted pass must remain downloadable. [D1 failure guidance](https://developers.cloudflare.com/d1/observability/debug-d1/).

### 5. P2 — Do not complete bulk reissue with an outstanding cursor
**Confidence: confirmed-source.** `src/worker/workflows/bulk-reissue.ts:30-39` stops after 1,000 pages and then unconditionally marks complete (`:47-55`). With pages of 100 (`modules/passes/bulk.ts:12`), larger selections leave eligible passes unprocessed. Automatic template reissue records the version as queued, so ordinary cron does not enqueue the remainder.

**Fix:** continue through a persisted continuation, or explicitly fail/incomplete rather than report success.

**Acceptance:** exercise 1,001 synthetic pages; completion must require the final null cursor.

### 6. P2 — Consume emitted scanner analytics
**Confidence: confirmed-source.** `modules/scan/ledger.ts:74` emits `scan.result`, but `modules/metrics/service.ts:80-113` has no consuming branch. D1 fallback also omits scans (`:32-68`), while totals/refusals/scanner counts remain zero (`:221-226`). The API reports false zero activity rather than unavailable data.

**Fix:** implement both Analytics Engine projection and D1 aggregation.

**Acceptance:** accepted/refused scans in both modes produce correctly scoped totals and series with either backend.

Queue retry-budget exhaustion and daily counted-environment KEK enumeration were independently counterchecked with **BluePlatform**; its report contains those findings.

## Strengths and service recommendations

- **Keep the current division:** D1 owns transactional truth; R2 owns artifacts; Queues deliver; Workflows checkpoint long operations; `ScanHub` coordinates displays. No wholesale KV/database/DO migration is justified.
- Live recipients are reauthorized before delivery (`scan/live-auth.ts:24-57`); customer frames remove identity/photo data (`live-render.ts:19-35`), and customer reconnects never replay history (`scan-hub.ts:82`). Ping uses automatic responses, not the rejecting message handler (`:31`). This matches [hibernation guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- Existing outbox leases, lost-enqueue sweeps, provider-ID preservation and test-mail capture are meaningful counter-controls—not exactly-once delivery guarantees. [Queues are at-least-once](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).
- Add per-credential DO coordination **only if strict upstream quotas require it**; per-run pacing does not coordinate overlapping runs. Native rate limits are approximate/location-local: [official limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
- Retain primary reads for revocation/action decisions. Read replication requires deliberately scoped [D1 Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/); enabling replication alone does not accelerate current raw binding reads.

## Limitations

No edits, builds, tests, production calls or hardware verification. Scenarios above are proposed acceptance checks, not executed results. Deployed queue behavior, workload ceilings, Analytics entitlement, Email Sending onboarding/quotas, and APNs certificate/HTTP/2 operation remain unverified. Binding presence alone proves none of those operational prerequisites.
