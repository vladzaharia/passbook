# B2B operational-contract audit

## Scope and evidence boundary

Read-only review of partner API documentation, operations guidance, ownership controls, delivery consumers, status reporting, audit history, and deletion/export paths. No edits, checks, network calls, or production/account verification.

**Conclusion:** The repository establishes an operator-managed technical service, but does not establish its commercial parties, ownership rights, or enforceable service commitments. The recommendations below are readiness gaps—not assertions that off-repository agreements are absent or breached. No new urgent security finding was established in this slice.

**Severity:** P2 = high business-readiness gap; P3 = contract/design recommendation.

## 1. P2 — Define contracting parties and delegated authority

**Persona / stage / action:** Merchant or integration agency; onboarding; authorizing issuance and content changes.

**Confirmed evidence:**
- Platform-global administrators and no organization-scoped admin RBAC are explicit architectural choices (`docs/design/platform-architecture.md:22-24`).
- Organization-bound keys exist, but connections, identities, settings and audit require an administrator (`docs/api.md:18-26`).
- Template writes require administrators (`src/worker/modules/templates/routes.ts:42-50`).
- Manual field edits take precedence over later connection updates (`src/worker/modules/passes/service.ts:72-80`; `src/worker/modules/passes/connection-passes.ts:49-56`).

**Impact — inferred:** A partner cannot safely interpret the admin console as delegated access confined to its business. Conflicting instructions from a merchant, agency and upstream system also require an agreed authority—not merely possession of credentials.

**Recommendation:** Document whether PassBook contracts directly with the merchant, with an agency, or both. Identify who approves templates, branding, recipient selection, messaging, manual overrides and upstream mappings. Distinguish technical `org_id`/holder ownership from legal ownership of content and the customer relationship. Preserve the managed-administration model rather than implicitly promising tenant-admin self-service.

**Acceptance — not executed:** Walk through agency onboarding and a disputed content correction; every action has a named authorized party, and partner credentials expose only the agreed organization.

## 2. P2 — Establish support ownership and escalation

**Persona / stage / action:** Merchant support team; live operation; resolving holder complaints.

**Confirmed evidence:** Holder emails prefer organization support contacts and otherwise use platform support (`src/worker/modules/delivery/email.ts:138-148`). The operations guide describes platform support forwarding to the owner’s inbox; the Worker does not receive mail (`docs/operations.md:181-193`). API callers are instructed to quote `requestId` (`docs/api.md:48`).

**Impact — inferred:** Contact routing exists, but does not establish support hours, acknowledgment targets, incident severity, backup coverage, or when merchant support hands an issue to the platform operator. Actual forwarding and staffing remain unverified.

**Recommendation:** Define merchant-facing L1 support, PassBook escalation, and responsibility for contacting Apple, Cloudflare or upstream vendors. Specify severity definitions, coverage, backup contacts, escalation intervals, and required diagnostic identifiers. Separate membership/content disputes from platform delivery failures.

**Acceptance — not executed:** Tabletop a missing-pass complaint and a simultaneous vendor outage. Each reaches the correct named responder without sharing capability links or credentials; owner evidence confirms mailbox delivery and backup coverage.

## 3. P2 — Separate SLA promises from downstream delivery states

**Persona / stage / action:** Partner operations team; incident response; determining whether an update reached a customer.

**Confirmed evidence:**
- Push success is classified from APNs HTTP 200 (`src/worker/modules/delivery/push.ts:56-60`).
- Email success follows the sending binding’s response and message ID (`src/worker/modules/delivery/mailer.ts:34-53`; `email.ts:122-135`).
- Delivery retries are bounded; unavailable push is cancelled (`push.ts:83-98,130-135`; `migrations/0001_platform.sql:412-413`).
- Public `/health` returns a constant success payload; component Status requires admin (`src/worker/app.ts:107`; `src/worker/modules/status/routes.ts:11-12`).
- Email Status checks configuration and sign-in-mail quota, not recipient delivery (`status/checks.ts:127-148`).

**Impact — inferred:** Provider acceptance is not evidence of inbox receipt or Wallet display. A partner cannot use public liveness to distinguish dependency outages, and bounded retries do not justify an indefinite eventual-delivery promise.

**Recommended responsibility schedule:**

| Failure boundary | Responsibility to agree |
|---|---|
| Upstream membership/vendor data | Merchant owns source correctness and access authority; platform operator owns connector diagnosis and recovery. |
| Signing/APNs/Wallet | Identify certificate/account owner, renewal operator, Apple escalation owner and post-outage catch-up procedure. |
| Email | Identify sender-domain/account operator, recipient-correction owner and deliverability escalation; distinguish acceptance from receipt. |
| Platform/cloud outage | Name incident commander, notification channel, maintenance communication and recovery obligations. |

Define separate objectives for API availability, successful publication, source freshness and provider acceptance. Agree exclusions, maintenance windows, response commitments, RTO/RPO and terminal-failure recovery.

**Acceptance — not executed:** Simulate dependency outages through retry exhaustion, restore dependencies, and demonstrate truthful state reporting plus a documented recovery action. Do not treat `/health` as end-to-end availability evidence.

## 4. P2 — Define export and deletion as explicit offboarding procedures

**Persona / stage / action:** Departing merchant or holder; termination/privacy request; exporting or erasing data.

**Confirmed evidence:**
- Organization deletion is soft and retains passes and audit references (`src/worker/modules/orgs/service.ts:209-222`).
- “Remove from my passes” clears portal ownership and records an attachment block; it is not erasure (`src/worker/modules/holders/service.ts:277-294`).
- Soft-deleted passes receive a seven-day grace period before physical cleanup (`src/worker/modules/passes/jobs.ts:15-17,35-62`).
- Remote removal does not delete a pass from a device (`docs/api.md:94-95`).
- Template export includes the active template documents and assets (`src/worker/modules/templates/lifecycle.ts:29-50`).

**Impact — confirmed boundary:** Organization deletion alone neither erases the tenant’s records nor constitutes complete installed-pass retirement. A template ZIP is not a complete tenant-data or service-migration export.

**Countercontrols:** Physical pass cleanup and configurable retention exist.

**Recommendation:** Establish an operator-run export/termination checklist covering pass data, templates/assets, mappings, evidence, credentials, installed-pass handling and retained exceptions. Agree deletion timing for live stores, backups and third-party copies; distinguish portal removal, remote retirement and erasure.

**Acceptance — not executed:** Offboard a synthetic merchant and reconcile an export manifest and deletion report against D1/R2 records, credentials, retention exceptions and remaining device copies.

## 5. P2 — Agree evidence retention before promising auditability

**Persona / stage / action:** Partner compliance/support lead; dispute investigation; proving who changed a pass and what it contained.

**Confirmed evidence:** Audit records contain actor, target, request and redacted detail (`src/worker/modules/audit/repo.ts:116-135`), but access is admin-only (`audit/routes.ts:7-8`). Defaults retain three historical pass versions, audit for 365 days and events for 90 days (`src/shared/contracts/settings.ts:31-34`). Purging removes historical package references, rendered JSON and personalization (`passes/repo-history.ts:164-179`).

**Impact — inferred:** A partner may retain a change identifier but lose the content needed to substantiate a later dispute. Current defaults are not automatically suitable for a negotiated evidence obligation.

**Countercontrols:** Immutable template versions and publication-history triggers provide useful provenance (`migrations/0001_platform.sql:186-190,505-534`).

**Recommendation:** Agree required evidence and retention before onboarding. Provide organization-scoped evidence through the operator; export necessary version/content proof before pruning. Do not promise permanent content reconstruction from the audit log.

**Acceptance — not executed:** Publish enough versions to trigger pruning, then demonstrate which agreed evidence remains recoverable and which is intentionally unavailable.

## 6. P3 — Publish compatibility, change-notice and migration terms

**Persona / stage / action:** Integration developer; upgrade or exit; maintaining a working client and issued passes.

**Confirmed evidence:** `/api/v1` and generated OpenAPI are documented (`docs/api.md:3-4`). Connector configuration migration is supported (`src/worker/modules/connections/runtime.ts:52-59`). Template activation automatically queues live-pass reissue after a quiet period (`passes/stale-reissue.ts:44-63`). Issued Wallet service hosts require continuing service during migration (`docs/operations.md:109-113`).

No compatibility, deprecation-notice or maintenance-notice commitment surfaced in the reviewed materials.

**Recommendation:** Define notice channels, notice periods, emergency exceptions, supported API versions, migration ownership and exit assistance. Agree template-change approval separately from API compatibility.

**Acceptance — not executed:** Rehearse an API/template change and service-host migration using existing clients and issued passes; verify notice, continuity and recovery.

## Owner/legal decisions requiring external evidence

Verify legal entities and agency authority; content/IP licenses; controller/processor roles, consent and deletion exceptions; liability and third-party exclusions; Apple/Cloudflare/vendor account ownership; support staffing, mailbox forwarding, SLA commitments and recovery arrangements.

Existing security, lifecycle and recovery findings remain tracked in prior audits, especially `reviews/03-ux-customer-business.md`, `10-red-pass-delivery.md` and `14-cloudflare-ops.md`; they were not reclassified or retested here.
