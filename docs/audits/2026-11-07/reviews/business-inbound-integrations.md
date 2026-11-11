# Inbound integrations — IT/CRM/AMS readiness

## Evidence boundary and verdict

Read-only source audit at `8f5bee02`: no edits, builds, tests, secret-value reads or production calls. Acceptance scenarios below are **not executed**. The working-tree patch is Android-only; these are baseline findings, not patch regressions. Implementation facts are source-confirmed; operational consequences are **[INFERENCE]** until exercised. Production credentials, upstream contracts and owner-only account controls remain unverified.

**Verdict:** generic JSON/HMAC paths support operator-assisted integrations. Do not promise unattended, business-critical synchronization until the inherited gates and confirmed defects below are resolved.

## What partners can actually launch

- **HTTP JSON:** per-record GET for bound references; an optional resumable cursor feed discovers records when auto-create/default template are configured. Initial loading works if the upstream supplies an initial listing. HTTP webhooks invalidate references and fetch current records. Built-in authentication is none/bearer/basic/custom header, not OAuth refresh or mTLS (`src/worker/connectors/http-json/index.ts:70-163,172-183,205-278,281-302`).
- **Signed push:** complete records/deletion indicators, with no upstream fetch. Maximum 100 items and 256 KiB. HMAC-SHA256 covers seconds timestamp plus exact body, accepting five minutes past/one minute future (`src/worker/connectors/webhook-push/index.ts:11-12,46-105`; `src/worker/connectors/lib/hmac.ts:5-9,23-34,53-77`). Deletions invoke configured keep/flag/void policy, not database erasure (`src/worker/modules/connections/records.ts:128-136`).
- **Adapters/onboarding:** only demo, HTTP JSON and webhook-push ship (`src/generated/connectors.ts:3-7`). Other CRM/AMS adapters require application-code deployment or external transformation/machine-API integration, not tenant-uploaded plugins (`docs/extending.md:79-99`; `docs/design/platform-architecture.md:252`). Connection setup, tests and run history require administrator sessions (`src/worker/modules/connections/routes.ts:41-43,143-213`): intentionally operator-assisted, not partner self-service.
- **Operating envelope:** public HTTPS/443 only; private hosts, IP literals and redirects are blocked. Default response cap is 256 KiB; HTTP timeout is 15 seconds, excluding the previously audited DNS-deadline gap (`src/worker/platform/safe-fetch.ts:29-30,141-170,193-230`). HTTP defaults: 15-minute polling, concurrency four, 60 requests/minute. Runs select at most 500 due passes or 200 list pages (`src/worker/connectors/http-json/index.ts:216`; `src/worker/modules/connections/sync.ts:19-20`).

## Positive controls and delivery semantics

Credentials are write-only, encrypted with credential/org/kind AAD, and decrypted into limited plugin contexts—not the Worker environment (`src/worker/modules/connections/secrets.ts:15-35,44-71`; `src/worker/modules/connections/runtime.ts:47-90`). Mapping pointers/transforms and template schemas are validated (`src/worker/modules/connections/mapping.ts:13-45`; `src/worker/modules/connections/deps.ts:41-47`). Manual overrides survive; claimed holders are not moved by source-email changes (`src/worker/modules/passes/connection-passes.ts:49-69`). Unique org/connection/reference binding prevents duplicate issuance (`migrations/0001_platform.sql:322-323`).

Webhook jobs have an explicit consuming dispatch branch (`src/worker/jobs/registry.ts:9-26`). Event-ID dedupe/inbox retention is seven days; retries need stable IDs and fresh signatures (`src/worker/modules/connections/webhooks.ts:63-85`; `src/worker/modules/connections/jobs.ts:16-18,111-113`). HTTP 202 means queued acceptance, not successful application. Scheduled failures respect numeric retry-after and open a breaker after five failures (`src/worker/modules/connections/health.ts:80-116`). Webhook backoff/replay/order limitations are separately covered in `docs/audits/2026-11-07/reviews/business-reliability.md`.

## P1 — Existing partner release gates

These materially block inbound readiness; they are cross-references, not new discoveries:

- **Test key → live connector data:** `docs/audits/2026-11-07/reviews/10-red-pass-delivery.md:26-39`; independently checked in `docs/audits/2026-11-07/reviews/11-blue-platform.md:11-31`.
- **Revoked source authority can publish after binding/configuration changes:** `docs/audits/2026-11-07/reviews/07-code-backend.md:27-34`.
- **Accepted webhook work can be lost, or deferred records acknowledged/cursors advanced before application:** `docs/audits/2026-11-07/reviews/13-cloudflare-runtime.md:22-34`.

Urgent security relevance was relayed to the parent. Retain those reports’ deterministic acceptance scenarios; enqueue success alone is insufficient.

## Additional confirmed-source defects

### P2 — Propagate explicit clears of connection-owned fields

**Partner/stage/action:** CRM administrator; steady-state updates; clear an optional mapped value.

`src/worker/modules/connections/mapping.ts:86-90,119-124` discards null/missing outputs. `src/worker/modules/passes/connection-passes.ts:49-56` merges only supplied fields. An old optional value therefore survives a source clear; whole-record on-missing policy cannot repair it. Manual locks protect overrides but do not implement source clearing.

**Fix:** distinguish explicit clear from omitted patch data; remove only connection-owned values and validate resulting input. **Acceptance:** synchronize an optional message, then explicit null. Stored input and built pass must lose the old message while a manual override remains unchanged.

### P2 — Apply manual locks before validating source changes

**Partner/stage/action:** AMS support operator; exception correction; retain an override while other fields update.

`src/worker/modules/connections/records.ts:154-161` validates the raw incoming merge before `src/worker/modules/passes/connection-passes.ts:51-54` filters manual fields. A schema-invalid upstream value for a locked field rejects the entire record, including valid unlocked changes. The override stays safe, but unrelated updates fail.

**Fix:** validate the same lock-filtered projection that publication uses. **Acceptance:** manually lock a required string; send a non-string there plus a valid change elsewhere. Preserve the lock and apply the other change without RECORD_ERRORS.

### P2 — Share upstream quotas across concurrent runs

**Partner/stage/action:** IT administrator; incident recovery; use Sync now during scheduled work.

Scheduled/admin instance IDs differ (`src/worker/modules/connections/schedule.ts:29-35`); startup has no connection execution lease (`src/worker/modules/connections/sync.ts:81-105`). Executions independently consume concurrency/RPM (`src/worker/modules/connections/sync-runner.ts:105-112,166-179`; `src/worker/modules/connections/sync.ts:288-315`). Overlap can exceed configured upstream concurrency and aggregate request budget. Same-instance dedupe and per-run pacing do not prevent this.

**Fix:** share connection-level admission/rate accounting across polling, refresh and webhook work. **Acceptance:** overlap these paths against a counting fixture; aggregate in-flight requests and rate must satisfy the configured shared contract.

## P3 — Product gaps and launch conditions

1. **Import/snapshot are not implemented launch paths.** Flags and `importRecords` exist (`src/worker/connectors/types.ts:7-12,85-93`), but the runner dispatches only listChanges or due-reference fetches (`src/worker/modules/connections/sync-runner.ts:122-179`). No shipped connector advertises snapshot/import; snapshot is explicitly future work (`docs/design/platform-architecture.md:386`). Do not promise full-roster/CSV reconciliation. **Acceptance for future support:** import multiple pages, detect absent members, and restart at the correct full-roster boundary next run.
2. **Mapped rehearsal/backfill is missing.** Test previews source fields, not mapped template/lifecycle outcomes (`src/worker/modules/connections/test-config.ts:61-111`). Connector issuance always creates live passes (`src/worker/modules/passes/create.ts:83`), disclosed by `src/web/admin/connections/test-mode-note.tsx:4-17`. Mapping edits retain the delta cursor; config/secret edits reset it (`src/worker/modules/connections/service-update.ts:45-72`). Provide mapped dry-run and bounded backfill/replay. **Acceptance:** repair mapping without a new upstream event, recover the failed record, and preview without live pass/email creation.
3. **Invitation caps require staged onboarding.** Limits are three/recipient/hour and 500/org/day (`src/worker/modules/delivery/service.ts:24-26,153-169`). Creation deliberately logs capped email and succeeds without a pending send (`src/worker/modules/passes/create.ts:179-191`); later synchronization finds the existing pass. Surface suppressed-send outcomes/recovery. **Acceptance:** a 501-member import accounts for every invitation and permits explicit recovery, without claiming all were queued.
4. **Offboarding is not source-authoritative reconciliation.** Connection deletion detaches rather than voids passes (`migrations/0001_platform.sql:293`; `src/worker/modules/connections/service.ts:179-182`). Voided references are excluded from ordinary sync (`src/worker/modules/connections/repo-passes.ts:49,67,95`); source reappearance is not automatic reactivation. Document deliberate detach/revoke/rejoin policy. **Acceptance:** exercise deletion and member return; observable pass state must match that policy.
5. **Reject colliding event IDs.** Both built-ins accept empty IDs and truncate supplied IDs at 200 characters (`src/worker/connectors/http-json/index.ts:297-302`; `src/worker/connectors/webhook-push/index.ts:99-104`). Distinct deliveries can collide and be suppressed; absent-ID fallback changes when a retry is re-signed with a new timestamp. Reject empty/oversized IDs and document stable IDs. **Acceptance:** empty IDs and IDs sharing a 200-character prefix must not silently acknowledge distinct records as duplicates.

Detailed safe local fixture scenarios: `local://inboundpartner1-acceptance.md`; none were executed.
