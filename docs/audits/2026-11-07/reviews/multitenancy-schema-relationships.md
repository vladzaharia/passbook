## Assessment

**The current model supports platform-operated tenancy, not organization-scoped administration.** Global administrators are deliberate v1 architecture (`docs/design/platform-architecture.md:23`); `requireAdmin` and `assertOrgAccess` do not restrict admin sessions by organization (`src/worker/platform/auth.ts:131-198`). This is a **P1 requirement gap, confidence 0.99**, not a regression in the unrelated scanner patch.

Current customer aggregation is appropriate: `/me` selects by `owner_user_id`, and verified-email attachment spans organizations (`modules/me/routes.ts:43-58`, `service.ts:74-89`, `repo.ts:31-49`; `modules/holders/repo.ts:143-150,196-207`). **Owning another organization’s pass must never imply administrative membership there.**

Reconfirmed baseline defects informing the target:

- **P1, source confidence 0.99:** Untrusted OIDC email can reserve `primary_email`; subsequent mailbox proof joins that identity-bearing account (`modules/auth/oidc-sign-in.ts:76-102`; `service.ts:132-143`). Deployment exploitability depends on eligible identities supplying another person’s email.
- **P2, confidence 0.99:** Tenant pass detail exposes global account email through `routes.ts:43-45,91-93` → `detail.ts:158-175` → `repo.ts:68-75`. Tenant possession of an alias must not reveal another verified address.
- These reconfirm relevant findings in `docs/audits/2026-11-07/reviews/09-red-auth-tenant.md`; they are not patch findings.

## Recommended relationship model

### 1. Global customers, separate from organizational authority

Retain global `users` and `user_emails`. A verified normalized address belongs to one global account; `primary_email` must be verified for that account or unset. Unproven provider claims belong only on authentication identities, never in canonical email ownership.

Keep tenant pass ownership as a nullable global-account FK plus tenant-supplied holder contact. Preserve sticky ownership and explicit reassignment: removing an email or administrative membership must not silently transfer owned passes.

Tenant DTOs should expose their holder contact and ownership state—not unrelated account emails, globally correlatable account identifiers, or global account-management controls.

### 2. Organization memberships and grants

Add:

- `org_memberships(org_id, user_id, status)`, unique by organization/account.
- Fixed role grants such as `admin`, `operator`, `viewer`, with grant provenance.
- Membership statuses distinguishing invited, active, suspended and revoked. Invitations must not reserve global email ownership.

Track manual and IdP-derived grants independently so removing an IdP grant does not delete a manual grant. Local suspension overrides provisioning. Evaluate current membership on management requests; session role snapshots are insufficient for revocation.

Separate `requirePlatformAdmin` from organization-role authorization. Tenant repository operations require an explicit organization scope; `null` must not silently mean unrestricted access.

### 3. Authentication providers and group mapping

Introduce provider registrations owned by an organization or explicitly by the platform. Authentication identities remain unique by **provider registration + subject**, not email or bare subject.

Group mappings grant roles only within their authorized organization. Tenant-controlled issuer claims—including `email_verified`—must not establish global customer email ownership, link an existing global account automatically, or grant platform administration. Global linking requires independent proof or an explicit authenticated linking flow.

### 4. Service principals and integrations

Add organization-owned service accounts with status; bind API keys to those principals, preserving scopes, expiry and live/test restrictions. `created_by` remains audit attribution, not principal ownership.

Keep connections, credentials, webhook records and upstream references tenant-owned. Current webhook/inbox ownership derives through the connection, and consumers reload that connection (`connections/webhooks.ts:31-43,96-106`; `repo-passes.ts:147-221`). Preserve this ancestry.

An upstream customer reference is a tenant source identity—not global account proof. Keep source binding on the domain pass rather than duplicating it for every wallet/device.

### 5. Domain entitlement → many native wallet instances

Current authored templates require Apple `passJson`, and build/publish directly produces signed Apple artifacts (`src/passkit/template/registry.ts:9-18`; `modules/passes/builder.ts:203-267`). The schema also combines entitlement, Apple identity, serial, authentication token and artifact (`0001_platform.sql:264-311`).

Target:

- Organization-owned **semantic template versions**, with versioned provider-specific extensions and required/optional capability declarations.
- Organization-owned **domain passes/entitlements**, holding customer ownership, source binding, business state and shared redemption/value ledger.
- **Many wallet issuance instances** per entitlement, including multiple instances of the same provider.
- Separate provider-reported installation/device records, native artifacts, credentials, update/revocation state and observability.

Do **not** impose `UNIQUE(pass_id, provider)`. Apple remains full-fidelity first-class; Google/Samsung may implement narrower declared subsets, but require real native issuance, previews and lifecycle.

Required unsupported semantics block issuance/update. Optional degradation is explicit and versioned. Persist capability/readiness results against the exact semantic revision, adapter version and provider configuration.

One instance’s failure or revocation must not overwrite another’s status. Device registration is not automatically an independently revocable credential: mirrored/shared Apple identifiers need explicit control-granularity limitations. Unknown installation state remains unknown.

The same eligibility projection should power web recommendations, discoverable alternative wallets and every eligible provider-specific email button. Platform detection recommends; it neither authorizes nor proves installation.

### 6. Explicit shared infrastructure

Global/shared catalogs should contain adapter definitions, connector/behavior definitions, compliant button assets and explicitly shared starter templates—not tenant configuration or secrets. Baked origin must not imply shared ownership.

Scope wallet issuer identities and credentials by organization/provider. Preserve an explicit **Apple platform-shared signer exception**, not a blanket cross-provider secret exception. Restrict platform defaults to platform-owned identities.

APNs currently uses one global key per Apple team (`0012_identities.sql:3-5`); rotating through one identity affects that team’s identities (`identities/push-key-service.ts:48-105`). Before tenant self-service, replace implicit team-based authorization with explicit issuer/key relationships and ownership. Equal external team IDs must not imply permission to rotate another tenant’s key.

### 7. Transfers and central operations

Default tenant ownership to immutable. Clone/import configuration into another organization; do not implement transfer as raw `UPDATE org_id`.

Current template reassignment checks passes but omits connection defaults (`templates/org-assignment.ts:18-33`; `repo.ts:143-147`). Cached resolutions also contain mutable organization metadata (`registry.ts:112-148`). Transfers must check the complete dependency graph; authorization metadata must not rely on immutable-content caches.

Issued entitlement transfer should require an explicit product/legal policy, not retagging history. Holder reassignment is a separate within-tenant operation. Credential movement requires re-encryption because AAD includes organization (`platform/crypto.ts:24-25`).

Keep platform-superadmin grants separate and audited. Global user administration, platform settings and cross-org operations remain central-only. Tenant audit queries require enforced organization filtering and safe label enrichment; current audit is centrally guarded and resolves global labels (`audit/routes.ts:8`; `repo.ts:45,74-104`).

## D1 constraints, indexes and migration

- Existing FKs generally ensure referenced rows exist, **not organization equality**: pass identity/connection references and bundle membership are examples (`0001_platform.sql:264-311`; `0011_bundles.sql:19-24`). This is a schema gap, not proof of an exposed endpoint bypass.
- Use composite tenant FKs for new relationships, following `0024_scanning_sessions.sql:30-31`. Existing relationships can gain narrowly scoped integrity triggers without rebuilding highly referenced parents. Shared-template/signer exceptions require explicit predicates.
- Preserve useful owner, organization/mode and source-reference indexes (`0001_platform.sql:313-323`; `0010_events.sql:30-32`). Add reverse membership indexes and matching child indexes for new composite FKs.
- Preserve native uniqueness namespaces: Apple pass type plus serial, provider-specific native identifiers, and globally routed capability tokens. Do not replace these with organization-only uniqueness.
- `UNIQUE(org_id, slug)` permits duplicate shared-template slugs because SQLite treats NULLs as distinct. Audit existing rows before adding a partial shared-slug unique index ([SQLite semantics](https://www.sqlite.org/lang_createtable.html#unique_constraints)).
- Use additive migrations and reviewed backfills. Do not infer memberships from `last_roles`, pass ownership or creator IDs. Revoke obsolete session/key authority during cutover.
- Preserve existing Apple IDs, serials, tokens, URLs, revisions, registrations and artifact references while moving them behind the Apple adapter. Convert authored content into semantic fields plus lossless Apple-specific extensions; never silently enable another provider through lossy conversion.
- Avoid casual parent-table rebuilds: `0010_events.sql:21` explicitly avoids rebuilding passes. [D1 enforces FKs](https://developers.cloudflare.com/d1/sql-api/foreign-keys/); deferral is not disabling enforcement or cascades.

## Acceptance matrix — proposed, not executed

| Scenario | Required outcome |
|---|---|
| A administrator owns a B pass | Customer can view it; cannot administer B |
| One verified customer owns A+B entitlements | One portfolio; no foreign administrative access |
| Tenant IdP asserts victim email/admin group | No global email ownership or platform grant |
| Membership/service account suspended | Relevant management/key access stops; unrelated tenants remain unaffected |
| Cross-org reference or bundle membership | SQL/service rejects it except explicit shared resources |
| Several providers/devices redeem one entitlement | Shared ledger; no duplicate balance |
| Revoke/update one wallet instance | Other instances retain independent state |
| Upgrade existing Apple fixture | Existing installation updates; identifiers, ownership and history survive |

**Remaining owner/platform decisions:** cross-org privacy disclosures, mailbox-recycling/shared-mailbox policy, transfer authority, IdP revocation timing, external issuer ownership, and provider-specific device observability/removal guarantees.

Source review only; no edits, tests, builds, secret reads or production access.
