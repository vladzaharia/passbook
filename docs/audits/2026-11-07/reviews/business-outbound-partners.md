# PassBook → Partner Lifecycle and Delivery Audit

## Evidence boundary

Read-only source audit of outbound delivery, Apple web service, lifecycle history, broadcasts, scanner results and issuer boundaries. These are baseline findings, not defects attributed to the unrelated Android working-tree changes. No edits, builds, tests, external services or secret values were accessed. All acceptance scenarios below are proposed, not executed.

Severity follows this audit’s contract: **P1 blocker; P2 high; P3 gap/recommendation**. No new urgent P1 security issue established. Existing recipient-generation and live-connector/test-key risks remain covered by `docs/audits/2026-11-07/reviews/10-red-pass-delivery.md`.

## Actual transports and boundaries

- **Wallet updates:** publication rebuilds/stores the Apple artifact and dispatches push work (`src/worker/modules/passes/publish.ts:188-283`). APNs receives an empty background notification at `api.push.apple.com`, authenticated through an identity’s mTLS binding or team push key (`delivery/apns.ts:39-73,112-188`). Apple then lists updated serials and fetches the package through `/wallet/v1`; these are device-facing protocols, not partner callbacks (`apple/routes.ts:90-129`).
- **Email:** Cloudflare Email Sending binding, using the configured onboarded sender; optional `.pkpass` attachment (`delivery/mailer.ts:29-62`; `delivery/email.ts:110-140`). Provider acceptance is the terminal success signal implemented here.
- **Connectors:** HTTP JSON performs upstream record/list reads; “Webhook push” means **the partner sends records into PassBook**, not PassBook sends events outward (`connectors/http-json/index.ts:204-280`; `connectors/webhook-push/index.ts:45-65`). The signed receiver returns `202 accepted`, not an eventual per-record processing result (`connections/routes.ts:267-299`).
- **Partner-visible polling:** per-pass events/devices, pass-detail delivery/version history, broadcast progress/items and a `scans:read` JSON feed exist (`events/routes.ts:13-49`; `passes/detail.ts:168-220`; `broadcasts/routes.ts:104-115,195-223`; `scan/routes-scans.ts:39-85`). CSV exports, event administration, session administration, component health and audit history require an administrator session.

## Findings

### 1. P2 high — Honor scan-based broadcast targeting  
**Confirmed implementation defect**

**Persona/stage/action:** venue CRM operator, post-event engagement, send a message or scheduled input change only to attendees/non-attendees.

The public target accepts `scan: {eventId, checkedIn}` or `{noScanDays}` (`src/shared/contracts/broadcasts.ts:32-40`; `scan.ts:310-315`). However, `broadcasts/apply.ts:117-132` drops that field. Its consuming SQL supports no scan predicate (`passes/repo-list.ts:5-24,33-87`; `broadcasts/repo-target.ts:6-10`). Both preview and execution use this reduced filter (`broadcasts/service.ts:178-194`; `apply.ts:142-144`).

**Impact:** matching template passes outside the requested attendance segment are counted and modified. Organization, mode, status and expiry constraints remain countercontrols, but do not enforce the requested audience.

**Fix:** carry the scan predicate through preview/count/page selection and validate event ownership/mode.

**Acceptance:** create attendees, non-attendees and recently/infrequently scanned passes; preview, immediate send, scheduled send and message clearing must affect precisely their requested segment.

### 2. P2 high — Do not publish unfinished scans as refusals  
**Confirmed implementation defect**

**Persona/stage/action:** ticketing reconciliation consumer, live admission, ingest definitive scan results.

A scan first exists as `state='pending'` (`scan/repo-scans.ts:34-40`). The partner feed query does not restrict state (`scan/repo-feed.ts:151-197`), and serialization converts a null outcome into `'refused'` without exposing pending/failed state (`scan/feed.ts:123-145`).

**Impact:** polling during processing, or after an interrupted request, produces a false refusal. The same ID can later become successful; the feed has no completion/update cursor. Failed claims can also appear as ordinary refusals.

**Countercontrols:** idempotent scan claims and local recovery exist; minute reconciliation processes pending rows older than 60 seconds (`scan/jobs.ts:13-27`). Neither makes the emitted refusal final.

**Fix:** expose only completed results or explicitly expose processing state; provide completion-ordered changes/revisions for later transitions.

**Acceptance:** pause after claim, poll, resume and reconcile an interrupted request. Consumers must never commit a fabricated refusal or miss the final outcome.

### 3. P2 high — Preserve admission and correction correlation in partner results  
**Confirmed contract gap**

**Persona/stage/action:** attendance/access-control partner, settlement, reconstruct occupancy and undo effects.

Internal results retain `direction`, `passVersion` and `undoes` (`scan/feed.ts:87-119`), but the API-key projection/schema omit them (`feed.ts:123-145`; `src/shared/contracts/scanners.ts:259-277`). Both entry and exit use a check-in action; direction is separately stored during admission (`scan/act-check-in.ts:88-101`). Undo creates a new row referencing its original scan (`scan/repo-undo.ts:45-75`), but that reference is discarded from the partner projection.

**Impact:** a least-privilege `scans:read` consumer cannot reliably distinguish entry from exit or associate an undo with the exact prior admission. CSV is not a machine-reconciliation substitute: its columns contain display names rather than stable scan/pass/event IDs (`scan/feed-csv.ts:5-22,43-63`).

**Countercontrol:** richer admin results and per-pass lifecycle events exist.

**Fix:** include direction, original-scan correlation and revision in the scoped JSON contract; offer stable IDs in exports.

**Acceptance:** interleave entry, exit, re-entry and undo across scanners; an external consumer must reproduce final presence and identify each reversed transaction without admin access.

### 4. P2 high — Define a durable outbound lifecycle/reconciliation contract  
**Confirmed business-readiness gap; recommended capability**

**Persona/stage/action:** membership platform or issuer, enrollment through revocation, keep its system of record synchronized.

The connector interface describes acquisition, not downstream event delivery (`connectors/types.ts:40-94`). Queue dispatch contains only push, email, refresh and inbound-webhook work (`jobs/types.ts:4-19`; `jobs/registry.ts:9-27`). No partner subscription/callback transport was found in these dispatch contracts or the application route registry.

Existing history is not a durable alternative: it is pass-specific, newest-first (`events/routes.ts:19-20`; `events/repo.ts:46-62`), and event-write failures are deliberately logged and swallowed (`events/record.ts:79-105`). Holder enrollment attachment writes admin audit records, not pass lifecycle events (`holders/service.ts:65-91,251-275`). Session ending is an admin configuration transition, with no partner terminal-results watermark (`scan/routes-scanning-sessions.ts:30-31`; `scanning-sessions.ts:149-188`).

**Impact:** partners must poll known passes and mutable scan windows, cannot subscribe to enrollment/update/revocation outcomes, and cannot distinguish “nothing happened” from lost history or unfinished reconciliation.

**Fix:** specify tenant/mode-scoped lifecycle events plus replayable delta access: stable event/resource IDs, external correlation, revision, occurrence/completion times, tombstones, retention and delivery acknowledgements. Persist partner delivery intent with the authoritative mutation; define duplicate/replay semantics.

**Acceptance:** disconnect a consumer across enrollment, updates, void/remove, scans, undo and session ending; replay must reconstruct the final state, including late recovery and deletion, without loss or double application.

### 5. P3 — Distinguish acceptance, inference and receipt  
**Contract/product recommendation**

**Persona/stage/action:** partner support team, delivery troubleshooting, determine whether a holder received an update.

APNs `200` becomes `push.sent`; email provider acceptance becomes `email.sent` (`delivery/push.ts:164-192`; `delivery/email.ts:139-147`). Broadcast `sent` reflects successful pass application, not device receipt (`broadcasts/run.ts:43-46`; `apply.ts:81-109`). Apple file-fetch attribution is heuristic: the earliest recently listing device receives credit because the fetch carries no device ID (`apple/log-events.ts:73-109`; `events/repo.ts:113-131`); that credit can produce device status `current` (`events/devices.ts:40-52`).

**Impact:** these signals cannot substantiate per-device installation, display or inbox-delivery promises.

**Fix/acceptance:** document distinct applied/provider-accepted/file-served/inferred states. Reverse fetch order for two devices; neither should receive an unqualified verified-receipt claim. Preserve existing raw status/error evidence.

## Issuer/provider recommendations and positive controls

Apple-only wallet support is an explicit boundary, not a new defect. Issuance resolves an explicit/org-default/global/platform identity and enforces organization ownership (`identities/db-resolver.ts:101-123`); server-owned Apple identifiers override template values (`src/passkit/build.ts:254-260`). Renewal requires the same pass type and team (`identities/service.ts:229-264`).

Partner onboarding should explicitly record issuer ownership, shared-team push-key responsibility, renewal/offboarding and Apple-only eligibility. Identity and health administration are not partner-key APIs (`identities/routes.ts:29-30`; `status/routes.ts:11-12`). Account approval, entitlements, sender deliverability and contractual/legal responsibilities were not verifiable.

Useful resilience controls already include delivery leases/recovery, bounded retries, dead-letter settlement, creator checks before scheduled broadcasts, per-pass broadcast outcomes, sanitized event data and privacy-reduced scan feeds (`delivery/jobs.ts:26-64`; `broadcasts/start.ts:28-65`; `events/record.ts:28-60`). These should be retained when adding partner reconciliation.
