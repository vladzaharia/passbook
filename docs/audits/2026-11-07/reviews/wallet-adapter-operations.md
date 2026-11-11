# Wallet-provider operations and enablement audit

## Conclusion

Independent wallet enablement requires one core lifecycle cutover, not provider conditionals throughout Apple issuance. Preserve Apple’s full-fidelity output and shared logical-pass coordinator; Google/Samsung need genuine native adapters with declared narrower support and isolated publication state.

Source-only review; no files changed, checks run, network calls, account access or secrets. Official constraints reference the checked-in platform research in `27-wallet-providers.md` and `28-wallet-feature-research.md`.

## Current architecture and cutover impact

Current flow is **business/API/connection → logical pass → Apple build → one artifact → Apple push/email**. Creation is tenant-scoped/idempotent and updates converge on CAS publication (`passes/create.ts`, `passes/publish.ts`). Preserve these seams; do not put remote issuance inside speculative artifact build before CAS succeeds.

Provider-neutral cutover affects more than issuance:

- Scanner lookup uses tenant/pass identity but validity currently reads Apple `pass.json`; it must consume canonical entitlement semantics.
- Jobs, delivery, DLQ and budget logic are closed to current kinds. A generic wallet operation must be wired through validators, producer, dispatch, leases/retries, sweeps, DLQ, retention and analytics; current non-push delivery maps to email and DLQ recognizes push/email only.
- Holder API exposes one `.pkpass` URL and Apple-registration `inWallet`; email and customer views need provider-offer contracts.
- Existing pass row couples Apple identity, serial/auth/download tokens, one object key/hash, status/version and logical personalization. `pass_versions` stores one artifact; `revisions` is Apple update cursor. Domain revision and each provider’s native version/cursor must remain distinct.

## Recommended responsibilities

**Core:** canonical entitlement, owner/tenant/mode, provider-neutral authoring and immutable revisions, required/optional semantics, validity/redemption/admission/revocation, authorization, idempotency, CAS, desired state, operation ledger, audit, durable outbox, retry/lease/fencing and reconciliation.

**Provider adapter:** provider-native semantic mapping/constraints, signing/authentication, native resource and publication protocol, provider-specific add action/branding, readiness probes and normalized receipts/callbacks.

Introduce a separate generated wallet registry with stable IDs, implementation/API/schema/config/payload versions, native type/capability/channel support, branding metadata and independent new-save enablement versus existing-instance servicing. Use typed `assess`, deterministic `compile`, honest provider preview, `issue/update/revoke`, `addAction`, and callback normalization/reconciliation contracts. Inject tenant/account-scoped credentials and bounded transport; do not grant adapter unrestricted DB/env access. Version mismatch fails closed or goes through explicit migration; current behavior-version warning is too permissive for provider mappings.

## Multi-tenant accounts and lifecycle

Provider issuer accounts (Apple signing identity/APNs, Google issuer/service account, Samsung partner/certificate) differ from holder login/provider accounts. Pin account to instance; authorize organization-specific or explicitly granted shared accounts; store credentials encrypted and write-only. External IDs/cache keys include provider, account, mode/environment and credential version. Do not assume platform-wide account sharing is permitted.

Model **one entitlement → many provider instances → observable installations**. Every instance tracks provider/account/resource, desired/applied revision, readiness, add-channel eligibility, diagnostics and independent lifecycle. Install telemetry is `unknown` when unavailable. Provider failures and throttles isolate by account/instance; partial failure never causes siblings to be replayed or rolled back. Revoke canonical entitlement before asynchronous provider propagation. Apple registration/protocol and artifact behavior remain stable during migration.

## Rollout and fourth-provider acceptance

1. Add forward-only migration/backfill preserving pass IDs, ownership, Apple serials/auth, routes, artifacts, histories, registrations and pinned templates.
2. Introduce neutral semantics and registry/operation lifecycle; migrate scanner, holder DTO, email, metrics, analytics, retention, queues and status consumers.
3. Prove Apple golden artifact/signature and web-service parity before enabling narrower providers.
4. Canary by tenant/account. Disable new issuance independently while still servicing update/revoke for existing instances.
5. Migrate stored mapping/config versions explicitly and drain or compatibly replay queued commands before removing implementations.
6. Fourth-provider proof: new provider changes its adapter, descriptor, mappings/assets, migrations and contract fixtures, not business, scanner, subscription, customer, queue, delivery, metrics or provider lifecycle branches.

Contract tests cover multiple providers/devices, shared canonical scan gate, partial provider failure, ambiguous remote success, stale update/revoke, account/tenant isolation, credential rotation, required-feature blocking, optional disclosed degradation, truthful previews, no secret logging, callback replay, email links and unknown installation state. Keep Apple golden fixtures and adapter conformance tests separate. No tests were run in this review.
