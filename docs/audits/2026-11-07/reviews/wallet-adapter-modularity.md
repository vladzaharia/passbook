# Modular wallet adapter architecture audit

## Finding

Wallet-native extension is not a `buildArtifact` provider switch. Current pass issuance and publication share Apple-specific serial/authentication fields, `PassJson`, one artifact per pass, one Apple revision cursor, and pass-scoped Apple push. `publishPass` builds speculatively before CAS, so remote provider calls must not happen inside that speculative build. Preserve the existing shared logical-pass coordinator and Apple protocol routes while extracting provider compilation and side effects.

Source-only review; no edits, builds, tests, accounts, network or secrets were used. Existing platform research is in [wallet provider architecture](27-wallet-providers.md) and [wallet feature feasibility](28-wallet-feature-research.md).

## Current cutover seams

- `src/worker/modules/passes/builder.ts::buildArtifact` resolves tenant/domain data and composes it into PassKit; `src/passkit/build.ts::planPass` adds Apple-only identity, serial, token and web-service fields. Keep that as Apple adapter output, not canonical authored state.
- `createPassRow` and `publishPass` own artifact storage and D1 lifecycle; update/remove, connection, broadcast, asset, photo, bulk reissue and Apple personalization paths converge on `publishPass`. Change the shared coordinator once instead of branching every caller.
- `src/worker/modules/passes/file.ts` is an Apple `.pkpass` file responder. Apple `/wallet/v1` register/update/fetch/personalize/log routes remain provider-specific facades.
- `passes` stores one identity, Apple serial/auth/download token, object key and hash; `pass_versions` stores one artifact per version. `revisions` is Apple's update cursor. Provider object version, publication result and installation observation cannot be represented safely by one `passes.provider_id`, `object_key`, version or `inWallet` boolean.
- `src/worker/modules/scan/resolve.ts` and lookup read validity/status from Apple JSON today. Scanner decisions must migrate to authoritative neutral entitlement semantics, not select any provider artifact.
- Generic jobs require full wiring. `delivery/service.ts` currently routes non-push delivery to email, job registry is closed, and DLQ handles only existing push/email kinds. A provider queue producer without registry, schema, dispatch, sweep and DLQ support would be dropped/misrouted.

## Recommended contract

Keep canonical entitlement/template revisions semantic and immutable. Add typed wallet-provider descriptors and a map-backed registry separate from connector/behavior registries. Each descriptor has stable ID; implementation/contract/configuration/schema versions; supported native types, capabilities and channels; provider branding metadata; and independent enablement for new issuance versus servicing existing instances.

A boring first interface should separate:

1. `assess(revision, mapping, accountFacts, context)` — readiness, supported/unsupported/unknown semantics, required failures and explicit optional degradations.
2. `compile(revision, mapping, assessment)` — deterministic native payload plus diagnostics/schema version/digest; no remote mutation.
3. `preview(compilation)` — provider-specific truthful presentation and limitations, no credentials.
4. `issue/update/revoke(command)` — remote/native operation using stable operation+instance IDs, desired revision, pinned account and prior receipt; return accepted/completed/async/retryable/permanent outcomes precisely.
5. `addAction(instance, channel)` — provider-compliant localized brand, eligibility/requisites and a channel-compatible authorized action; mint short-lived tokens at click time.
6. Versioned protocol callback normalization/reconciliation — callbacks update only provider-instance observations, never entitlement ownership.

Core owns tenant/holder authorization, neutral content and revision, validity/redemption/revocation, CAS, audit, desired state, durable outbox, idempotency, leases, fencing, retry policy and reconciliation. Adapters own provider mapping, native validation/assets/signing, provider authentication, protocol, remote resources and receipts. Inject scoped account credentials and bounded transport, not universal Apple `SigningMaterial`, unrestricted DB or whole Worker env.

## Lifecycle and safety

Model **one entitlement → many wallet instances → zero or more provider-observed installations**. Keep provider issuer account separate from holder Wallet login and PassBook user. Pin provider/account on each instance; resolve explicit tenant/shared-account grants. Namespace external IDs, resources and caches by provider, account, environment and credential version. Provider revisions are independent from domain revisions and Apple revision cursors.

Commit entitlement revision and per-instance desired work atomically; execute instance operations independently with stable operation IDs, serialization/fencing, and ambiguous-write reconciliation. Partial failure cannot roll back or repeat successful sibling providers. Entitlement revocation denies scans first; native provider deactivation may lag and must be visible, not described as physical deletion. Missing install telemetry is `unknown`.

Apple remains first-class/full fidelity, preserving existing signatures, serial/auth tokens, routes, conditional file validators, registrations and update cursors. Google/Samsung are real native 1.5-class adapters with narrower declared capability subsets—not Apple exports or mocked browser flows. Unknown/unsupported required security, identity, privacy, rotation or revocation behavior blocks that provider; optional visual loss is explicitly versioned/disclosed. Migrate existing Apple instances without rewriting immutable template/pass history; pin old/new adapter/mapping/schema versions and explicitly migrate or reject incompatibility.

Static generated registry permits independent implementation versions and enablement in the current Worker; it does not create separately deployed binaries. If an adapter later needs separate deployment, create an explicit service boundary with the same contract. Do not allow tenant-uploaded executable plugins.

## Acceptance gates

- Backfill an Apple instance per existing Apple pass; preserve pass IDs, tenant/holder, serial/token, URLs, artifacts/history, registration records and update cursor.
- Reconcile speculative CAS loss, R2 cleanup, ambiguous D1/remote outcomes, duplicate and reordered operation retries, partial provider failure, stale commands after revoke, credential rotation and adapter-version upgrades.
- One Apple + Google + Samsung entitlement can coexist; multiple devices/provider instances remain distinct; all scan credentials map to one authoritative pass/admission gate.
- Verify provider account and tenant isolation, sandbox/live boundary, no JWT/Cdata/token logging, no unsupported required feature, explicit optional degradation, provider-specific previews and install state only when observed.
- Fourth-provider acceptance: adding descriptor/mapping/assets/migrations/fixtures changes no provider branches in business, portal/email, scanner, queue, subscription, metrics or lifecycle workflows.
- Test Apple golden artifact parity separately from neutral-fixture/native adapter contract tests; update queue, DLQ, sweeps, delivery, DTO, metrics, analytics and retention consumers when adding provider instance events.

Potential anchors include `passes/hardening.test.ts`, `apple/routes.test.ts`, `delivery/outbox.test.ts`, `jobs/jobs.test.ts`, scanner suite, and golden signing fixtures. These checks are proposed, not run.
