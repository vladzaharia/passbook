# Partner data lifecycle and privacy contract audit

**Boundary:** Read-only source review; no edits, checks, executed scenarios, secrets, production calls or cloud-account inspection. These are baseline findings, not regressions attributed to the unrelated Android patch. Severity: P1 blocker, P2 high, P3 contract/product gap. Urgent transfer risks were sent directly to Main.

## Confirmed implementation defects

### P1 — Revoke former-holder capabilities during cross-person transfer

**Persona/stage/action:** Partner CRM/support; transfer A’s pass to B, then update B’s personal fields.

Although the API describes reassignment as changing hands (`docs/api.md:88`), it changes only holder email and portal ownership (`src/worker/modules/holders/service.ts:160-180`; `src/worker/modules/holders/repo.ts:227-240`). Download token, ApplePass token, registrations and bundle membership survive. Their consumers authorize unchanged capabilities and return current content:

- `src/worker/modules/public/service.ts:33-38,126-141`
- `src/worker/modules/apple/service.ts:43-57`
- `src/worker/modules/bundles/public-service.ts:14-18,27-58`

**Source-grounded impact:** A retaining an old direct URL, bundle URL or installed credential can retrieve B’s subsequent content. This is distinct from the previous queued-email defect.

**Countercontrols:** Org/mode checks and portal ownership transfer exist; separate link rotation does not revoke Apple/bundle access.

**Fix/acceptance:** Distinguish portal reassociation from secure transfer. For cross-person transfer, revoke-and-reissue with new credential capabilities and appropriate bundle handling. Preserve A’s three capability classes during a synthetic transfer; none may return B’s data. Previously downloaded copies cannot be remotely deleted.

### P2 — Preserve explicit holder intent across synchronization

**Persona/stage/action:** CRM operator; reassign a connected pass from verified A to unverified B.

Reassignment retains the connection and leaves B waiting (`src/worker/modules/holders/repo.ts:227-239`; `src/worker/modules/holders/service.ts:168-180`). A subsequent successful sync supplying A’s old email sees an unowned pass and invokes assignment (`src/worker/modules/passes/connection-passes.ts:63-72`), which overwrites B and reattaches verified A (`src/worker/modules/holders/service.ts:97-114`).

**Impact:** The explicit transfer can silently reverse before B verifies.

**Countercontrol:** Owned passes resist automatic email changes; manual input-field protection does not cover holder email.

**Fix/acceptance:** Preserve explicit holder authority until an explicit reset to upstream ownership. Reassign to unverified B, synchronize A’s source record, and require B to remain pending without A reattaching.

### P2 — Persist object-erasure work before deleting its inventory

**Persona/stage/action:** Partner privacy operations; offboarding or expiry; erase stored pass data.

Hard purge deletes D1 rows before R2 objects (`src/worker/modules/passes/repo-ops.ts:13-46`; `src/worker/modules/passes/jobs.ts:35-49`; `src/worker/modules/sandbox/jobs.ts:31-39`). Termination or bucket failure after the D1 commit loses the inventory needed for retry. Provisioned object lifecycle covers only `uploads/` (`tools/lib/provision.ts:8-9,70-86`).

**Source-grounded impact:** Packages, photos or assets can remain without tracked cleanup. Public reachability is not established; normal application lookup stops resolving.

**Fix/acceptance:** Persist deletion manifests and retry until every object is removed. Fail R2 deletion after D1 commit, restart maintenance, and demonstrate eventual removal without a premature erasure-completion receipt.

### P2 — Commit transfer audit evidence atomically

**Persona/stage/action:** Compliance/support; investigate a disputed transfer or privacy incident.

Ownership commits before its separate audit insertion (`src/worker/modules/holders/service.ts:168-179`; `src/worker/modules/holders/repo.ts:234-239`). An intervening failure leaves a completed transfer without its audit event while returning failure. Retry observes changed ownership rather than reconstructing the original transition.

**Countercontrol:** Successful paths record actor, request and previous-owner identifiers.

**Fix/acceptance:** Batch ownership and audit writes using the existing `auditStmt` pattern (`src/worker/modules/audit/repo.ts:113-141`). Inject audit-insert failure; require rollback or durable recoverable evidence.

## Contract/product gaps—not legal-compliance findings

### P3 — Separate identity proof, authorization and provenance

**Persona/stage/action:** Issuer/data controller; onboarding and capture; demonstrate authority to process imported data.

Verified-email hooks automatically attach matching passes (`src/worker/modules/holders/service.ts:61-92,253-273`). This establishes account association, not a recorded partner-specific purpose or per-pass opt-in. Issuance accepts template input and identifiers without a standardized authorization receipt (`src/shared/contracts/passes.ts:174-189`).

`fieldSources` expresses manual/connection ownership, not complete provenance; caller-supplied initial values can immediately be marked connection-owned (`src/worker/modules/passes/create.ts:119-122`). Conditional NFC enrollment also stores encrypted identity/contact data separately (`src/worker/modules/apple/personalize.ts:112-145`; `migrations/0001_platform.sql:586-595`).

**Countercontrols:** Verified-email checks, attachment blocks and encrypted enrollment storage.

**Recommendation/acceptance:** Identify which party establishes lawful authority. Where required, retain source, purpose and authorization references without treating mailbox proof as universal consent. Trace one imported field and its authorization through a pass revision, transfer and withdrawal.

### P3 — Define comprehensive privacy-request handling

**Persona/stage/action:** Partner DSR team/customer; lookup, access/export, correction and deletion.

Scoped holder lookup and paginated pass APIs exist (`src/worker/modules/holders/routes.ts:24-45`; `src/worker/modules/holders/repo.ts:85-122`; `src/worker/modules/passes/routes.ts:47-77`). However:

- Customer removal only blocks reattachment and clears ownership (`src/worker/modules/holders/repo.ts:244-264`).
- `/me` exposes pass, email and session operations—not account erasure or comprehensive export (`src/worker/modules/me/routes.ts:43-208`).
- `.pkpasses` packages active passes without registrations, not account, audit or encrypted enrollment data (`src/worker/modules/me/repo.ts:79-95`).
- Deletion clears source binding, allowing later upstream auto-creation (`src/worker/modules/passes/repo-ops.ts:163-171`; `src/worker/modules/connections/records.ts:116-121,172-185`).
- Raw webhook records have separate seven-day retention (`src/worker/modules/connections/repo-passes.ts:166-179`; `src/worker/modules/connections/jobs.ts:18,109-114`).

**Recommendation/acceptance:** Document an identity-verified workflow spanning source suppression, aliases/pass IDs, bundles, enrollment, artifacts, logs and backup exceptions. Process a synthetic subject, replay its source after deletion, and demonstrate complete inventory plus no unintended recreation or misleading completion promise.

### P3 — Contract only for evidenced retention, residency and incident response

**Persona/stage/action:** Enterprise buyer/privacy lead; procurement, retention configuration and incident response.

Retention is platform-wide: audit 365 days, sync events 90, scans 396, test data 30; org settings offer no overrides (`src/shared/contracts/settings.ts:26-70`). Deleted passes retain a seven-day device-service grace (`src/worker/modules/passes/jobs.ts:15-16,35-49`). Version purge clears D1 snapshots as well as artifact references (`src/worker/modules/passes/repo-history.ts:164-180`). Bounded maintenance can be skipped under shared budget, so configured age is not a guaranteed deletion deadline (`src/worker/jobs/cron.ts:63-81`).

Provisioning specifies no D1/R2 jurisdiction (`tools/lib/provision.ts:53-68`); actual account location and subprocessors remain unverified. Audit access is admin-only (`src/worker/modules/audit/routes.ts:7-21`); bearer-access events identify no individual (`src/worker/modules/public/routes.ts:87-94,145-152`).

**Recommendation/acceptance:** Publish a storage/recipient/retention matrix, account-backed residency evidence, restoration exceptions, incident contacts and notification responsibilities. Exercise synthetic backlog and leaked-link cases; demonstrate containment across all capabilities and an appropriately scoped evidence handoff.

## Positive controls and inherited blockers

API mode fences exist (`src/worker/modules/passes/scope.ts:22-47`); test mail is captured; event payloads are scrubbed and device identifiers hashed (`src/worker/modules/events/record.ts:27-60`). These do not certify sandbox isolation.

The prior **P1 test-key → live connector** and **former-recipient queued delivery** findings remain directly material; cross-reference `docs/audits/2026-11-07/reviews/10-red-pass-delivery.md:9-39`. The current refresh consumer still lacks a pass-mode check (`src/worker/modules/connections/jobs.ts:20-66`).

Counsel/owner must establish controller/processor roles, lawful bases, rights, exceptions, subprocessors, transfer mechanisms, breach duties and SLAs. Source inspection cannot establish legal compliance or actual account guarantees.

**Overall correctness:** incorrect for the advertised cross-person transfer contract. **Confidence:** 0.93; conditional failures and acceptance scenarios were not executed.
