# Partner integration and multi-tenant readiness audit

## Executive finding

The repository supports an operator-managed integration platform and basic local/test workflows. It does not establish partner self-service, organizational administrator isolation, production provider readiness, or committed commercial/service levels. Current implementation and proposed target are separate: do not represent design recommendations or local fixtures as deployed capability.

**No P0 was established in this audit.** The original audit has P1 source-confirmed defects and locally reproduced privacy/authorization issues; see [security baseline](README.md). This report distinguishes confirmed behavior, inferred operational consequence and owner/legal decisions. No production/account/partner calls or application changes were made.

## Integration capability today

- **HTTP JSON connector:** per-bound-record GET plus optional cursor-based change listing; bearer/basic/custom-header auth, not OAuth refresh or mTLS. Initial record load requires an upstream listing. HTTPS/443 only; private hosts, IP literals and redirects blocked. Default response cap 256 KiB, 15-second HTTP timeout, 15-minute polling, concurrency 4, 60 requests/minute, 500 due passes/run or 200 pages/run. Limits and DNS timeout gap are in [runtime audit](reviews/13-cloudflare-runtime.md).
- **Signed push:** HMAC-SHA256 over timestamp + exact body; bounded freshness and payload; maximum 100 items/256 KiB. HTTP 202 confirms accepted enqueue, not pass application. Inbox/event dedupe is finite; retries need stable IDs and fresh signatures. Current built-in behavior is real support, but external connector implementation is not shipped beyond HTTP JSON, webhook-push and demo.
- **Connection operations:** encrypted write-only credentials with org/kind AAD; connector receives bounded context. Mapping/template validation and manual field locks exist; sync tests and history are admin-operated. Import/snapshot are not full roster-import workflows. Connection deletion detaches; it does not itself revoke all issued passes.
- **Local verification only:** `business-verification.md` records 3/3 setup, 4/4 `e2e/05-connections` including synthetic connection sync, scoped test-key pass create/get/idempotency, local signed webhook first+duplicate `202`, and 1 passing cross-org customer-portfolio worker harness. Temporary harness removed. No outside API, partner, live mail, provider or production state used.

## Highest-impact current findings

These findings are source-confirmed unless explicitly marked inferred; they must be triaged with the security baseline and not patched by a Cloudflare account setting alone.

1. **P1 — Stale queued email can deliver current holder’s pass/link to an old recipient.** Enqueued intent stores recipient/attachment choice; retry reloads current pass token/artifact. Fix by binding delivery to owner/recipient and credential/artifact generation; cancel stale intent. Local reproduction documented in `verification.md`; source report `reviews/10-red-pass-delivery.md`.
2. **P1 — Holder reassignment leaves old installed credential usable.** Owner/holder fields change without rotating Apple auth token/serial/scan code/registrations. Link rotation alone affects public download, not the installed copy. Cross-person transfer needs explicit credential generation/retirement and new issue; do not promise physical deletion. Source detail `reviews/wallet-revocation-credentials.md`.
3. **P1 — Test credentials can reach live connector data; test/live isolation is incomplete.** Enforce mode in binding, refresh, webhook, selector and write paths; account for existing bindings and test-key write-response data leakage. See `reviews/10-red-pass-delivery.md` and `11-blue-platform.md`.
4. **P1 — Scanner permissions/data are not uniformly protected across representations.** Raw pass preview JSON, actions/flags and photo alias paths can bypass role filters; a monitor metadata rename elevated a read-only device in local reproduction. Fix DTO authorization and immutable purpose/role semantics. See `README.md`, `reviews/12-blue-scanner-native.md`, `authoring-scan-display.md`, and `verification.md`.
5. **P1 — Publication and event retries can outlive changed authority/scope.** Binding/mode/generation changes and deletion lack a sufficiently strong commit fence in all paths; template tenant metadata can become stale in a warm isolate; uncertain scans may retry with a new event scope. Retest deterministic interleavings before production. See `reviews/07-code-backend.md`, `09-red-auth-tenant.md`, and `12-blue-scanner-native.md`.
6. **P1 — Unverified OIDC email can establish identity before mailbox proof.** Actual risk depends on deployed IdP claims/groups, which remain unverified. Prove email before canonical ownership/merge. See `reviews/09-red-auth-tenant.md`.
7. **P1 — NFC-authenticated pass can build with share prohibition absent (warning-only).** Required authentication semantics must fail validation. Do not enable NFC identity until fixed and verified. See `reviews/28-wallet-feature-research.md` and `wallet-revocation-credentials.md`.
8. **P2 — Connector sync drops explicit clears and validates manually locked bad values before filtering.** Null clear semantics should distinguish absent patch field from explicit removal; apply manual-lock projection before validation. `reviews/business-verification.md` local/API evidence; details in `reviews/business-inbound-wallet-entry.md`.
9. **P2 — Per-run quotas do not bound aggregate per-connection traffic.** Scheduled/admin/webhook/refresh executions can overlap because they have separate workflow IDs and no connection-wide admission lease. Aggregate overage is an inference until counting-fixture acceptance. Share admission accounting across execution sources.
10. **P2 — Webhook accepted work/cursor handling and delivery status can conceal loss.** Return 202 only for durable accepted work, preserve retries and report unapplied/deferred state; sweeps/reconciliation are needed. See `reviews/13-cloudflare-runtime.md` and `business-reliability.md`.
11. **P2 — Partner launch governance is outside application.** Live key creation is global-admin driven; no separate approval lifecycle, delegated tenant admin, credential owner/deputy, contracting authority or partner support commitment exists in the product. The architecture calls global admins a v1 scope decision. Document managed-service boundaries now; if strict tenant administration is target, build membership/RBAC with server-side authorization, not `orgId` UI scoping.

Additional target architecture requirements: strict organization boundaries for admin, API keys, templates, identities, integrations, data export/deletion and actions; the verified customer owner may still see only their own passes across issuers. Keep that customer ownership union distinct from organization membership/admin. This target gap is described in `reviews/multitenancy-rbac-security.md`; it is not a claim of a newly found foreign-org bypass on the org-bound API-key paths reviewed.

## Wallet and authoring product contract

- Model one semantic entitlement and immutable revisions, with provider-native objects/artifacts/readiness/lifecycle and installation observations separate. Apple remains full-fidelity first-class; Google/Samsung are real native 1.5-class adapters with declared narrower capability subsets. Apple `pass.json` cannot remain canonical authoring. Required security/identity/revocation semantics unavailable on a provider block it; optional presentation omissions are explicit.
- One entitlement can be installed on several devices/providers concurrently; all credentials resolve to one tenant-scoped logical pass and its shared admission gate. Do not use exclusive provider, global `inWallet`, device-UA or one generic status flag. Installation is unknown unless observed.
- Customer web recommends by platform hint but keeps other eligible wallet choices accessible; email has no recipient-device signal and includes every eligible provider’s compliant, official branded button plus individual device/account requirements. The repo currently provides Apple-only flows and interim Apple badge assets; provider integrations/issuer approval are absent. See `reviews/business-adaptive-wallet-offers.md` and `wallet-multi-instance-lifecycle.md`.
- Authoring should be a nontechnical semantic editor with independent provider preview/readiness, WYSIWYG front/back projections, and separate staff/customer/operator projections. Current pass designer is Apple `pass.json`; scan customer projection is not authorable/fully validated. Do not let authoring override scan verdict, role boundaries, grants or provider-required semantics. See `reviews/authoring-pass-flow.md`, `authoring-wysiwyg-designer.md`, `authoring-surface-preview-model.md`, and `authoring-scan-display.md`.

## Sample partner lifecycle checklist

### 1. Contract and authority
- Name contracting parties, merchant vs agency, data controller/processor roles, content/IP rights, source-of-truth field owner, customer relationship and authorized pass issuer.
- Name platform operator and partner technical owner/deputy; define approval for templates, branding, recipient selection, manual overrides, account recovery and transfers.
- Record promised features, supported pass/provider types, markets, accessibility and device prerequisites; separate promised support from unverified provider/platform behavior.

### 2. Tenant and readiness
- Create tenant from approved roster; establish correct admin memberships if/when org RBAC exists; keep platform support role separate.
- Inventory null-org/global keys, signing identities and shared resources; grant shared use explicitly. Use org-bound least-scope test/live keys, expiry, rotation owner and custody location.
- Confirm sender domain, Apple signing identity/APNs and provider issuer/partner approvals. Provider approval/account readiness is not established by the code audit.

### 3. Sandbox and mapping
- Validate upstream auth, least privilege, safe-fetch allowlist, quotas and data minimization; use synthetic test records.
- Test mapping against actual template schema and lifecycle, not only connector connectivity. Exercise omitted vs explicit null, manual locks, malformed values, duplicate/stable event IDs, deletions and replays.
- Prove test connector cannot read/write live data or expose live personalization. Test mode remains isolated through webhook, refresh and async paths.

### 4. Template and wallet acceptance
- Approve canonical field lineage, privacy classification, expiry/admission semantics, required security capabilities and per-provider eligibility.
- Compare server previews on Apple and each supported provider; accept documented omissions/degradations. Ensure one logical pass maps to all provider objects/credentials and one redemption gate.
- Verify customer primary recommendation + accessible alternatives; emails contain all eligible official branded CTAs and exact requirements. Test wrong OS, unknown UA, in-app browser, no JS, locale/dark mode and unavailable provider.
- Test scanner Door/Desk/Manager/customer/operator DTOs for unauthorized fields, actions, photos and asset aliases. Do not treat a template preview as permission to view live pass data.

### 5. Launch and change management
- Record approver, accepted test evidence, live key IDs (not secret), per-provider issuer/account, rate/volume limits, rollout cohort, pause/rollback and credential-transfer procedure.
- Start controlled rollout; watch per-tenant/source freshness, desired/applied provider revisions, delivery failures and actual scans. “Accepted,” “published,” “push sent,” “device fetched,” and “installed” are separate states.
- For changes, review semantic diff, affected passes/providers, recipient intent, customer visibility and required-data migrations before activation. Keep immutable versions and rollback target.

### 6. Operations and offboarding
- Name incident lead, merchant L1/platform escalation, provider/vendor contacts, severity, response hours, backup contact, communications channel and RTO/RPO. Do not use public liveness or enqueue response as end-to-end service evidence.
- Rehearse connector outage, failed webhook, queue/DLQ exhaustion, provider account expiry, partial provider publish, tenant suspension and key-owner departure.
- Separate emergency suspend (deny issuance/verification) from planned termination (issue revocation while provider channel active). Reconcile offline copies honestly; no provider API is assumed to erase physical Wallet contents.
- Export passes/templates/assets/mappings/audit evidence/credential inventory, retention exceptions, then revoke upstream and provider credentials, detach/revoke logical passes per policy, and report residual provider/device state. Tenant soft-delete, removing from My Passes, provider removal and erasure are different actions.

Checklist is a proposed operational artifact, not a legal contract or evidence these controls exist in production. See `reviews/business-contract-operations.md`, `business-commercial-readiness.md`, and `business-reliability.md` for owner/legal decisions.

## Evidence and limits

- Local commands/results and harness boundaries are in `business-verification.md` and `verification.md`. The 4/4 local demo-connector E2E does not prove external CRM behavior, production duration, quotas or provider availability.
- No partner API call, real delivery, issuer account check, production tenant, remote database, Cloudflare account inspection or external wallet install was performed.
- Inferred quota/race/production impacts are labelled as such in individual reports; acceptance scenarios not explicitly listed as executed remain proposed.
