# Wallet credential, transfer and revocation audit

## Findings

### P1 — Reassignment leaves old wallet credentials usable (confirmed source)

`reassignHolder` changes holder email/owner but does not retire Apple auth token, serial, scan code or registrations. Apple fetch continues accepting the same `ApplePass` token for the identity/serial; rotating the public link changes only `download_token`/link generation. A former holder’s installed pass can continue fetching later personalized updates and the cached scan credential still resolves to the active pass. Source: `src/worker/modules/holders/{service.ts,repo.ts}`, `src/worker/modules/apple/service.ts`, `src/worker/modules/passes/{repo.ts,service.ts}`.

**Acceptance:** After A→B transfer, A’s old copy cannot fetch B’s data or check in; B receives fresh credentials. Cross-person transfer must retire old credential generation / issue a distinct credential, not merely relabel. Do not promise physical deletion from the former holder’s device.

### P1 — Queued email can deliver current access to the former recipient (confirmed source)

`enqueuePassEmail` stores `{to, attach}` only. Delivery/retry reloads the current token and `.pkpass` while preserving the original recipient. Transfer/update/link rotation while pending may therefore send A B’s current access. Future provider links would share this authority-upgrade risk. Source: `src/worker/modules/delivery/{service.ts,email.ts}`.

**Acceptance:** Queue to A, transfer to B, rotate/update, then deliver and retry: A receives neither replacement URL/token nor B’s artifact. Bind delivery to owner/recipient and credential/artifact generation; cancel stale intent. Apply to every provider button and attachment.

### P2 — Delete/unvoid race can publish active Apple artifact (source-grounded inference; not executed)

`setStatus` checks `removedAt` before publish; publish CAS fences on `(id, version)`. Soft delete sets `deleted_at` without incrementing version; deleting an already voided pass skips another void publish. An in-flight unvoid built from the same version may still CAS an active artifact, and Apple serves soft-deleted passes during grace. Scanner excludes deleted rows, limiting scanner impact; active artifact race remains unverified. Source: `passes/service.ts`, `passes/repo-write.ts`, `passes/repo-ops.ts`, `passes/repo.ts`.

**Acceptance:** Deterministically interleave unvoid/delete; deletion/lifecycle generation and valid state must fence publish, and no active artifact can commit or be fetched afterward.

### P2 — Check-in may commit after void wins (source-grounded inference; not executed)

Resolve checks removed/void/expiry before action. Later `commitCheckIn` mutates the gate/ledger without current pass-status/version predicate; `passVersion` is recorded, not used as a fence. A void between evaluation and commit may allow stale admission. Source: `scan/resolve.ts`, `scan/act.ts`, `scan/act-check-in.ts`, `scan/repo-gates.ts`.

**Acceptance:** Pause after evaluation, commit void/revoke, resume. No success response, gate, or admission ledger may commit; atomically revalidate status, deletion and credential generation with the gate.

### P1 — NFC authentication does not hard-require Apple share prohibition (confirmed source)

When `nfc.requiresAuthentication === true` without `sharingProhibited`, `validateNfc` emits warning only; build blocks errors only. A credential configuration that depends on this protection can ship despite documented older-OS sharing bypass. Source: `src/passkit/schema/validate-features.ts`, `rules-features.test.ts`, `src/passkit/validate.ts`, `src/passkit/build.ts`; see official research in `28-wallet-feature-research.md`.

**Acceptance:** Required NFC authentication without the share fence blocks template import, preview, build and issuance. Same-holder multiple devices must remain distinct from sharing with another holder.

## Target lifecycle invariants

Keep distinct: one provider-neutral entitlement and active credential generation; provider issuer accounts/readiness; provider-native objects/artifacts; and install observations where observable. Every provider credential maps unambiguously to `(org_id, canonical_pass_id, credential_generation)` and shares one authoritative status and atomic replay/admission gate. Keep public link, Apple fetch credential, scan credential, provider save token/Cdata, APNs token and callback secret scoped and separate.

Locally commit canonical desired revision/lifecycle generation and all provider intents atomically; external provider APIs do not share a distributed transaction. New issuance preflights required provider mappings/accounts. Optional provider failures remain isolated/visible; ordinary updates may be pending per provider. Transfer/credential rotation accepts only active generation. Revoke/void/delete commits authoritative denial first, then tracks provider update/void/deactivation independently. A provider failure cannot roll back revocation or let siblings’ successful operations replay. Report per-provider applied revision, retries/errors and installation evidence; “push accepted,” “object created,” “device registered,” and “device fetched revision” are not synonyms.

For Google/Samsung, unsupported required anti-replay, identity/privacy, rotation, NFC or revocation semantics block that provider or a named optional feature is explicitly degraded. No silent weaker static code. Offline verification must fail closed or expose a specific bounded acceptance window; cannot promise instant revocation of an offline device or physical removal.

## Multi-instance acceptance

- Concurrent Apple/Google/Samsung instances map to the same pass; multiple device installs do not create pass rows or independent redemption allowance.
- Old credentials after transfer/rotation fail online; stale copies may remain visible offline but are described as possibly present. New owner has fresh access.
- Cross-tenant/provider object ID collision, duplicated/reordered callbacks and same-email accounts cannot cross-link or change another tenant’s pass.
- Required vs optional provider outage yields accurate per-instance readiness/status, visible retry and no false global success.
- “Sent,” “object active,” “saved,” “fetched,” “revoked,” and “physically removed” are distinct status claims.
- Accessible wallet chooser and email expose every eligible provider; UA changes recommendation only.

Review used source and checked-in platform research; no tests, builds, network, accounts, production calls or secrets. F3/F4 races and acceptance cases are not exercised.
