# Backend and Pass Engine Audit

**Scope:** pass creation/publishing/deletion, template registries, connection synchronization, broadcasts, delivery, Workflows, cron/queue dispatch, platform error handling, and pass-engine composition. Paths below are relative to `/Users/vlad/Repos/wallet`.

These are **baseline findings at `8f5bee02`**, not claims introduced by the unrelated working-tree patch. Confidence is **confirmed-source**, without runtime reproduction. No P0 established.

## Strongest findings

### 1. P1 — Authorize templates against current tenant metadata

**Evidence:** `src/worker/modules/templates/registry.ts:112-125`, `org-assignment.ts:33-34`; `src/worker/modules/passes/builder.ts:88-91`.

The version cache retains mutable `orgId` indefinitely. Reassigning a shared template privately invalidates only the handling isolate’s cache. Another warm isolate can return the old global scope, and pass creation authorizes against that cached scope—even the uploaded-template path reads fresh metadata before returning the stale object.

**Fix:** cache immutable version content separately; obtain tenant authorization metadata fresh.  
**Acceptance:** warm a global template in isolate B, assign it privately in A, then confirm foreign-org creation fails through both baked and uploaded resolution paths.

### 2. P1 — Fence publishing against soft deletion

**Evidence:** `src/worker/modules/passes/service.ts:157-177`, `repo-ops.ts:165-172`, `repo-write.ts:137-142`; `src/worker/modules/apple/service.ts:50-58`, `routes.ts:117-125`.

An unvoid operation can pause after reading a voided pass. Concurrent deletion skips the already-voided publish and sets `deleted_at` without changing its version. The delayed unvoid CAS still succeeds because it checks only ID/version, committing an active package into the deleted row. Apple intentionally serves soft-deleted rows during the grace period, so the installed credential can retrieve that active package.

**Fix:** make deletion a terminal, version-fenced transition and reject publishes against tombstones.  
**Acceptance:** interleave unvoid/deletion deterministically; Apple must never receive an active package after deletion.

### 3. P1 — Enforce connection fencing in the committing write

**Evidence:** `src/worker/modules/passes/connection-passes.ts:35-48`, `repo-write.ts:142,228-230`; `src/worker/modules/connections/service-update.ts:126-127`.

Connection identity/generation is checked before the asynchronous build, not when committing. A configuration change or rebinding during the build does not invalidate the pass CAS; its mutation also runs again against fresh personalization without rechecking the original binding. Consequently, an old connection operation can overwrite fields after its authority changed.

**Fix:** atomically predicate the commit on the expected connection/binding and generation.  
**Acceptance:** pause after validation, change configuration or rebind, then resume; the stale operation must write neither fields nor holder assignment.

### 4. P1 — Advance scheduling for flagged missing records

**Evidence:** `src/worker/modules/connections/records.ts:128-136`, `repo-passes.ts:94-98`, `sync.ts:19,284`; `src/worker/modules/passes/connection-passes.ts:129-141`.

The `flag` missing-record path sets `RECORD_MISSING` but never advances `next_sync_at`. These passes remain active and permanently oldest in the polling selection. With 500 such records—the run limit—every poll selects the same missing records, starving later valid passes indefinitely.

**Fix:** advance missing-record scheduling while preserving its error, with connection/generation guards.  
**Acceptance:** seed over 500 due records, make the first 500 missing, and confirm subsequent runs reach the remaining valid records.

### 5. P2 — Retry transient webhook preparation failures

**Evidence:** `src/worker/modules/connections/webhooks.ts:111-120`, `runtime.ts:59-66`, `secrets.ts:50-59`; `src/worker/jobs/queue.ts:75-85`.

Any preparation exception is recorded and followed by a normal return. A transient credential-read failure therefore acknowledges the queue message instead of retrying. For webhook-only connections, the corresponding record is lost; intake deduplication prevents the same event from being queued again.

**Fix:** apply the existing transient-versus-terminal disposition to preparation failures too.  
**Acceptance:** fail one credential lookup transiently; the job must retry and eventually apply its stored record exactly once.

### 6. P2 — Keep transient rebuild failures retryable

**Evidence:** `src/worker/modules/passes/bulk.ts:63-70`; `src/worker/modules/templates/repo-stale.ts:25-40`; `src/worker/workflows/bulk-reissue.ts:47-53`.

Bulk rebuilding treats every `AppError` as a terminal per-pass failure, including exhausted publish conflicts and 503 errors. The Workflow retry policy never sees them. Automatic template reissue has already marked the version queued, so affected passes remain on the old version and are classified as blocked rather than retried.

**Fix:** skip deterministic validation failures; propagate transient conflicts/infrastructure errors and retain recoverable reissue tracking.  
**Acceptance:** inject one transient failure, recover, and confirm automatic rebuilding eventually upgrades every valid pass.

### 7. P2 — Bound retention by the remaining cron budget

**Evidence:** `src/worker/modules/passes/jobs.ts:38-46`, `repo-ops.ts:14-32`; `src/worker/jobs/cron.ts:63-75`.

Deleted-pass retention permits 1,000 passes per hook. Each deletion requires at least four separate reads plus one D1 batch: 200 passes already consume 1,000 queries before earlier cleanup work. The cron counter checks only between hooks, so it cannot prevent overflow or protect later hooks.

Cloudflare documents [1,000 D1 queries per Paid invocation](https://developers.cloudflare.com/d1/platform/limits/), counting a batch as one.

**Fix:** batch deletion reads or stop/resume within the remaining invocation budget.  
**Acceptance:** process at least 200 eligible passes without exceeding the budget; subsequent daily hooks still execute and later invocations finish cleanup.

### 8. P2 — Persist display metadata on no-content-change updates

**Evidence:** `src/worker/modules/passes/builder.ts:144-159,268-277`, `publish.ts:146-170`, `repo-write.ts:177-200`, `repo-list.ts:68-69`.

Display title/subtitle are derived independently from pass content. A display-only template upgrade or an input used only by `display.title` takes the metadata-only path, which omits both derived columns. Personalization/template version advances while lists, search, filenames and emails retain stale display text.

**Fix:** include derived title/subtitle in metadata comparison and `casMeta`.  
**Acceptance:** change display-only expressions and inputs; displayed/searchable text updates without a new package or push.

## Counter-controls and strengths

Ordinary publishing has bounded CAS retries; version/outbox writes share transactional persistence. Delivery uses leases and stale-lease recovery. The engine validates assembled passes before initial signing. Event-ledger failures are contained rather than failing the action they describe. These controls are valuable, but do not cover the lifecycle boundaries above.

## Limitations

No edits, builds, tests, lint, formatters, production calls or hardware checks were performed. Generated artifacts were inspected, not regenerated. Multi-isolate races, fault recovery and volume thresholds require central verification. Explicit behavior-version warnings were not treated as unintended defects, and no product-only recommendations are counted as bugs.
