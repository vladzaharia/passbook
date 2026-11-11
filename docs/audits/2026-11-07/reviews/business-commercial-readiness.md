# Business/operator integration readiness audit

## Scope and evidence boundary

Read-only review of organization, identity, API-key, user, sandbox, metrics and credential lifecycles, plus operating documentation. Paths are repository-relative. No edits, checks, builds, network calls, production access or secret reads were performed. Acceptance scenarios below are **proposed, not executed**.

These are **baseline business-readiness recommendations**, not regressions attributed to the unrelated Android patch. “Missing” means not represented in the reviewed implementation/documentation; private business records and owner-controlled accounts remain unverified.

**Assessment:** The code supports a platform-operated integration service. It does not implement a self-service partner business. Global administrators and absence of billing are deliberate scope decisions, not defects.

## Implemented foundations and positive controls

- Administrators can create organizations, configure branding/support, assign signing identities, suspend/reactivate and soft-delete them. Changes are audited (`src/worker/modules/orgs/routes.ts:26-27`; `service.ts:101-128,188-222`).
- API keys support organization binding, explicit scopes, test/live mode, optional expiry, one-time secret disclosure, hashed storage, revocation and last-use metadata (`src/shared/contracts/api-keys.ts:11-45`; `src/worker/modules/api-keys/service.ts:62-108,129-153`).
- Multiple platform administrators can receive access through Pocket ID groups; email sign-in grants only the holder role (`src/worker/modules/auth/service.ts:60-68,132-143`).
- Operating docs cover deployment, real-device acceptance, certificate renewal, recovery, support forwarding and administrator offboarding (`docs/operations.md:22-91,181-208`; `docs/security.md:73`).

## Readiness recommendations

### 1. P2 high — Establish an explicit partner approval and rollout gate

**Persona/stage/action:** Partner developer and platform operator; evaluation → production; organization creation and live-key issuance.

**Confirmed facts:** Organization creation immediately sets `status: 'active'`. Key creation defaults to live mode when omitted and permits an unbound, platform-wide key (`src/worker/modules/orgs/service.ts:101-119`; `src/shared/contracts/api-keys.ts:37-42`). Neither contract records partner approval, trial dates or launch sign-off. The existing organization checklist covers templates, passes and sources, not approval (`src/web/admin/orgs/org-aside.tsx:110-152`).

**Impact:** Production authorization is an administrator’s credential-creation action, not a separate approved lifecycle transition. Sandbox availability alone does not establish production readiness.

**Countercontrols:** Creation is administrator-only; scopes must be selected, and expiry is supported.

**Recommendation:** Start with a manual partner register recording contracting organization, technical owner/deputy, approved scopes, test/live credential IDs, signing identity, test acceptance, rollout volume, approver and rollback decision. Require organization-bound credentials for external partners.

**Acceptance:** Complete one sample onboarding using synthetic data and a test key; demonstrate foreign-organization/admin-route rejection, then issue a separately approved live key and perform the documented Wallet acceptance sequence.

### 2. P3 gap — Describe the offering as managed, not partner self-service

**Persona/stage/action:** Partner administrator; onboarding and day-two operations; adding administrators, rotating keys, inspecting test mail and changing configuration.

**Confirmed facts:** Organization, API-key and test-inbox routes require platform-admin sessions. Metrics are likewise admin-only (`src/worker/modules/orgs/routes.ts:26-27`; `api-keys/routes.ts:15-16`; `sandbox/routes.ts:13-15`; `metrics/routes.ts:7-8`). Organization-scoped administration is an explicit non-goal (`docs/design/platform-architecture.md:22-24`).

**Impact:** A partner API credential cannot administer its integration or inspect captured test email. Granting platform admin instead would exceed that organization’s boundary.

**Countercontrols:** This is intentional privilege separation. Paired scanner/operator devices provide narrower operational access, not partner-console administration (`docs/operations-scanning.md:3-12,80-92`).

**Recommendation:** Publish the managed-service boundary and an authenticated change-request process. Introduce organization memberships/RBAC only if delegated administration becomes a committed offering.

**Acceptance:** A partner key must remain unable to administer organizations/credentials; a second authorized platform operator must be able to fulfill the request without sharing an account.

### 3. P2 high — Separate credential ownership from credential creation

**Persona/stage/action:** Partner technical owner and platform operator; rotation, personnel changes and incident response.

**Confirmed facts:** Keys expose `createdBy`, expiry and last use, but no operational owner/deputy (`src/shared/contracts/api-keys.ts:11-24`). Disabling a user revokes sessions; API-key resolution checks key revocation/expiry and organization status, not creator status (`src/worker/modules/users/service.ts:148-162`; `api-keys/service.ts:129-153`). Available key operations are create/list/revoke, so rotation requires replacement and cutover (`api-keys/routes.ts:18-59`).

Apple push keys are team-wide: replacing/removing one affects that team’s identities, potentially spanning organizations (`src/worker/modules/identities/push-key-service.ts:44-81,85-108`).

**Impact:** Disabling a departing employee does not retire credentials they created. Conversely, treating every credential as personal could interrupt a legitimate service.

**Countercontrols:** Creator attribution, audit events, expiry, explicit revocation and encrypted signing credentials exist.

**Recommendation:** Maintain a non-secret credential inventory with business owner/deputy, custody location, service-versus-personal classification, renewal deadline and dependencies. Extend the existing IdP/session offboarding procedure to include a credential decision.

**Acceptance:** Rehearse owner departure and overlapping old/new key cutover; verify explicit revocation ends old-key access. Rehearse shared-team APNs rotation without interrupting another organization.

### 4. P2 high — Define suspension, termination and erasure as different procedures

**Persona/stage/action:** Partner operator; suspension/offboarding; stop issuance, retire passes and close the relationship.

**Confirmed facts:** Organization deletion only updates status/default identity; it does not erase child data (`src/worker/modules/orgs/repo.ts:107-112`). Suspended organizations lose key authentication, Apple access and push delivery (`api-keys/service.ts:140-142`; `apple/service.ts:54-57`; `delivery/push.ts:111-114`). Remote removal publishes an expired/voided final version; Wallet provides no server-side delete operation (`passes/remove.ts:22-26`).

**Impact:** Suspending first prevents delivery of subsequent retirement updates. Soft deletion is neither credential destruction nor proof of device/data erasure.

**Countercontrols:** Suspension and reactivation are audited; delivery consumers check organization activity.

**Recommendation:** Document separate emergency suspension and planned termination procedures. Planned termination should address final pass updates while active, unreachable devices, upstream credential revocation, shared signing dependencies, export/retention decisions and authorized cleanup.

**Acceptance:** Rehearse termination with online and offline Wallet devices. After suspension, verify key/public/Apple access gates; record unreached devices rather than claiming remote erasure. Cross-reference the existing holder-bundle suspension bypass in `docs/audits/2026-11-07/reviews/09-red-auth-tenant.md`.

### 5. P2 high — Publish capacity limits before accepting rollout commitments

**Persona/stage/action:** Partner rollout lead; launch and campaigns; bulk issuance, email delivery and updates.

**Confirmed facts:** Pass email is capped at three per recipient/hour and 500 per organization/day; exceeding either produces `EMAIL_RATE_LIMITED` (`src/worker/modules/delivery/service.ts:24-26,153-169`). API throttling is 600/key/minute; the architecture identifies binding limits as per-location abuse controls, not contractual quotas (`wrangler.jsonc:135`; `docs/design/platform-architecture.md:389`). Notifying updates default to three/pass/day (`src/shared/contracts/settings.ts:24,37-38`).

**Impact:** A rollout requiring more than 500 pass emails/day encounters an existing hard limit. Adding API keys does not establish a tenant usage plan.

**Countercontrols:** Caps limit abuse; delivery and operational metrics exist. Those metrics are not an invoicing ledger: reporting uses rolling windows and D1 fallback cannot report downloads (`src/worker/modules/metrics/service.ts:15-18,30,140-157`).

**Recommendation:** Publish a capability/limits sheet and a staged rollout checklist. Establish expected volume, delivery pacing and escalation before making capacity commitments.

**Acceptance:** Exercise boundary cases locally with distinct synthetic recipients; verify accurate throttling/outcomes and a documented recovery path. Do not derive invoices directly from overview charts.

### 6. P3 gap — Create the commercial, trial and support operating artifacts

**Persona/stage/action:** Business buyer, finance contact and support operator; contracting → renewal/termination.

**Confirmed facts:** Organization contracts contain identity/branding/status, not contracting entity, billing contact, trial expiry or subscription state (`src/shared/contracts/orgs.ts:30-68`). Billing is explicitly outside product scope (`docs/design/next-wave.md:21-23`). Support documentation requires owner-managed mailbox forwarding; API errors provide request IDs (`docs/operations.md:181-193`; `docs/api.md:48`).

**Impact:** Trial expiry, invoicing and partner escalation require an external process; no automatic entitlement transition is evidenced.

**Recommendation:** Before external launch, establish a service order/capability schedule, trial-expiry decision process, billing contact/cycle, invoice reconciliation record, support owner/deputy and incident/renewal communications runbooks. Have appropriate counsel determine terms and data-processing obligations; this review establishes no legal compliance conclusion. No pricing is proposed.

**Acceptance:** Rehearse a trial reaching its end date, authorized extension/termination, invoice reconciliation and a support escalation quoting a request ID. Mail forwarding, staffing and Apple/account permissions require owner verification.

## Existing launch dependencies

No new urgent security chain was established here. Do not duplicate, but retain as external-partner launch blockers, the previously confirmed **test-key access to live connector data** and **stale-recipient queued email** findings in `docs/audits/2026-11-07/reviews/10-red-pass-delivery.md`.
