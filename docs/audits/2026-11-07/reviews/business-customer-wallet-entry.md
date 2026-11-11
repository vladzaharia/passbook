## Summary

The three additional findings are confirmed in source. The key qualifiers are: manual field locks protect values but are applied **after** template validation; request limits pace each execution, not all work for a connection; and import/snapshot are declared extension surfaces, not implemented ingestion paths. HTTP JSON can still seed records through `listChanges(null)` if the partner endpoint supplies an initial listing.

## Files

- `src/worker/modules/connections/mapping.ts:86-124`; `records.ts:139-175`; `src/worker/modules/passes/connection-passes.ts:45-69` — map, validate, publish and ownership behavior.
- `src/worker/modules/connections/schedule.ts:29-64`; `sync.ts:71-105,288-315`; `sync-runner.ts:100-179`; `jobs.ts:20-67` — execution identity, per-run limits and refresh path.
- `src/worker/connectors/types.ts:7-13,78-94`; `sync-runner.ts:115-179`; `service-update.ts:45-73`; `test-config.ts:42-59,61-111` — importer contract, actual dispatch, cursor reset and test preview.
- Built-in capabilities: `http-json/index.ts:205-210,248-278`; `webhook-push/index.ts:46-54`; `demo/index.ts:102-110`.

## Architecture

Per-run polling selects `listChanges` or due linked refs, applies records through mapping/template validation, then publishes passes. Signed push has a separate webhook/inbox/queue path. The connection test probes and samples source data; it does not exercise the configured mapping against the target template.

## Report

1. **P2 — Explicit upstream clears are dropped.** `mapping.ts:93-123` omits null/undefined mapped values; `connection-passes.ts:49-56` merges only fields that arrive, retaining the prior personalization value. Manual PATCH can delete a field with `null` and mark it manual (`passes/service.ts:52-80`), but that does not provide a source-side clear. Manual-field locking is a useful countercontrol, not a remedy for stale source values. **[INFERENCE]** A CRM clear of an optional value can leave old personal data on the pass.

2. **P2 — A bad value for a locked field can block other updates.** `records.ts:154-161` validates `{...pass.personalization, ...fields}` before calling the pass service; `connection-passes.ts:51-54` filters manual fields only during publish. Thus an invalid upstream value for a manually locked field can fail the record before otherwise valid, unlocked fields are applied. The lock still protects the override. Fix by validating the same lock-filtered projection that will publish.

3. **P2 — RPM/concurrency are per execution, not aggregate per connection.** Schedule and admin syncs use distinct workflow IDs (`schedule.ts:29-35`); `startRun` inserts a run but has no connection-wide lease (`sync.ts:81-105`). Each workflow independently reads RPM/concurrency and paces its own work (`sync-runner.ts:102-112,163-175`; `sync.ts:288-315`). Per-pass refresh directly calls `fetchRecord` (`jobs.ts:61-67`). Same-instance dedupe and per-run pacing are countercontrols, but do not coordinate overlapping scheduled/admin/webhook/refresh work. **[INFERENCE]** Overlap can exceed the partner’s aggregate request or concurrency budget.

4. **Import/snapshot/backfill limits.** `importRecords` and `snapshot` appear in the connector contract (`types.ts:7-13,85-93`), but the runner dispatches only `listChanges` or due pass refs (`sync-runner.ts:122-179`); no shipped connector advertises import/snapshot. Snapshot mode is accepted only if a connector sets the capability, while scheduling is limited to poll/hybrid (`validate.ts:39-46`; `health.ts:20-22`). This is not a dedicated snapshot importer. However, `http-json` can seed through `listChanges(null)` if the partner endpoint supplies an initial listing (`http-json/index.ts:248-278`). Config/mapping/template changes do not all replay that listing: only config/secrets clear the cursor (`service-update.ts:45-73`). Its test preview returns a raw sample, not a mapped/template-validated dry run (`test-config.ts:42-59,99-111`). Treat file/snapshot onboarding, reconciliation, and safe backfill/replay as unsupported; the architecture doc identifies Henry’s snapshot connector as follow-up (`docs/design/platform-architecture.md:386`).

The separate deferred-CAS/cursor acknowledgement issue is already covered in `docs/audits/2026-11-07/reviews/13-cloudflare-runtime.md:29-34`.
