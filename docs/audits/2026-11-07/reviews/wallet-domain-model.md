# Domain-neutral wallet model audit

**Decision:** Apple remains full-fidelity first-class; Google/Samsung are real native adapters with narrower, declared 1.5-class capability sets. Neither equal feature investment nor Apple `pass.json` as the canonical authored document follows from that tiering.

Read-only investigation; no edits, checks, network calls or account access.

## Evidence: current coupling

- **Authoring is Apple-native.** `DesignDoc` contains `passJson`, `manifest` and assets; field groups are Apple groups (`src/web/admin/templates/designer/model.ts:21-58`). The save contract accepts those documents directly (`src/shared/contracts/template-versions.ts:14-36`); the server reconstructs `pass.json`/`wallet.template.json`, validates and persists them (`src/worker/modules/templates/versions.ts:60-124`). Preview normalizes `PassJson` and selects `ios27` (`designer/preview.tsx:57-77`).
- **One domain row owns one Apple artifact.** `passes` requires signing identity, serial, authentication token, web-service URL and one object key; history stores Apple `pass_json` (`migrations/0001_platform.sql:264-340`). Creation resolves an Apple identity, builds synchronously and writes `.pkpass` (`src/worker/modules/passes/create.ts:78-140`). Server-owned Apple identifiers overwrite template values (`src/passkit/build.ts:253-265`).
- **Issuer identity and secrets are Apple-specific.** Signing identities contain pass-type/team identifiers and NFC/APNs configuration (`0001_platform.sql:130-148`). Resolution permits own-organization/global identities, not another organization’s (`src/worker/modules/identities/db-resolver.ts:101-123`). Secrets use envelope encryption with identity/organization/purpose AAD (`src/worker/platform/crypto.ts:4-25`); APNs keys are team-scoped (`migrations/0012_identities.sql:1-14`).
- **Publication fan-out depends on Apple output.** Apple content hashes determine rebuild/no-op behavior (`src/worker/modules/passes/publish.ts:138-177`). Metadata CAS increments `passes.version` (`repo-write.ts:180-215`), but history/update-cursor/outbox triggers require an `object_key` change (`migrations/0010_events.sql:58-77`). Outbox dispatch maps push versus email; queue routing enumerates four existing variants (`delivery/service.ts:28-35`; `jobs/registry.ts:9-27`).
- **Holder/API state exposes Apple projections.** `/me` filters by authenticated owner; `inWallet` means any registration exists for that pass (`modules/me/repo.ts:31-49`; `me/service.ts:46-70`). Emails contain one Apple download action/optional attachment (`modules/delivery/email.ts:69-75,110-120`). Account removal merely clears ownership and records an attachment block—not wallet revocation (`holders/service.ts:277-295`).
- **Redemption still consumes Apple data.** Barcode aliases derive from Apple barcode messages (`passes/scan-code.ts:11-22`); scan lookup reads historical `pass_json`, and validity uses its Apple expiration/void fields (`scan/repo-lookup.ts:20-46`; `scan/resolve.ts:269-276`). Admission gates correctly key the shared entitlement by domain pass ID (`scan/act-check-in.ts:37-45`).

## Minimum stable model

**Recommendations—not existing implementation:**

| Entity | Essential responsibility |
|---|---|
| **TemplateRevision** | Immutable, schema-versioned neutral definition: business kind, typed inputs, stable semantic field IDs, localized values, asset roles, display/search projections, validity/access rules and capability requirements. Preserve instant, calendar-date and timezone meanings separately. |
| **ProviderTemplateRevision** | Versioned mapping/extensions, bound provider account and native class/template identifiers, declared supported subset and approval/readiness evidence. Apple extensions preserve full fidelity without becoming canonical. |
| **Pass + PassRevision** | Stable tenant-scoped entitlement ID, mode, business/external reference, owner binding, lifecycle and immutable canonical data/provenance snapshot. Provider-native rendering must not determine whether canonical history exists. |
| **ProviderAccount + CredentialReference** | Provider, external issuer/partner namespace, environment, ownership/grants, approvals and purpose-specific credential versions. Keep issuer accounts distinct from customer wallet accounts. |
| **WalletResource** | One native pass/object/card identity beneath the entitlement. Allow multiple resources for the same provider—**no unique `(passId, provider)` restriction**. Pin account/environment/native identity after issuance. |
| **ResourceVersion** | Resource sequence, source domain revision, mapping/adapter/credential versions, native digest/snapshot, private file reference **or** remote object/version, desired/published state and failure reason. Re-signing may advance this sequence without changing domain data. |
| **InstallationObservation / RedemptionCredential** | Separate observed device state from native resources. Credentials/aliases resolve to one domain entitlement and optionally one resource; store their scope, generation, validity and revocation independently. |

Multiple resources must not duplicate admission allowances, relax holder restrictions or create independent balances.

## Canonical versus adapter-owned semantics

Canonical semantics are entitlement authority, holder/sharing constraints, validity, redemption guarantees, privacy classification and required business information. Provider adapters own native layout, image sizing, field placement, identifiers, signing/API authentication, save flow, notification mechanics and lifecycle translation.

Each requirement needs an explicit **required/optional**, scope and semantic meaning. Required input presence is not equivalent to required wallet display.

Effective capability is the intersection of adapter/card-type support, account approval, credentials, native-template readiness and deployed verifier support. Unknown is not supported. Reject unsupported **required** semantics before issuing that provider resource; other ready resources remain independent. Optional omissions require explicit author approval and visible preview/readiness reporting.

Examples: never substitute static credentials for required rotation, weaken non-transferability, omit an identity-critical photo, or describe NFC emission as verified redemption.

Primary implementation contracts include [Apple updates](https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes), [Google GenericObject](https://developers.google.com/wallet/reference/rest/v1/genericobject), [Google rotation](https://developers.google.com/wallet/generic/resources/rotating-barcodes), and [Samsung server interaction](https://developer.samsung.com/wallet/api/server-interaction.html). These were not re-fetched; repository research records the platform distinctions and unresolved Samsung dynamic-QR semantics (`docs/audits/2026-11-07/reviews/28-wallet-feature-research.md:11-16`). Product approval, markets and device/watch eligibility remain unverified.

## Data flow and API boundaries

1. **Save/edit domain pass:** validate neutral input; commit canonical revision plus per-resource desired-state outbox records atomically. Retain idempotent creation and conditional updates, now against domain revision.
2. **Provision resource:** `POST /passes/{id}/wallet-resources` selects a provider/account without replacing existing resources. Return a resource operation or a structured capability/readiness rejection.
3. **Materialize:** a resource-qualified job loads authoritative tenant/account state, compiles, validates and publishes through an explicit adapter registry. Preview derives from that same native projection, with provider/device limitations labelled—not an Apple card relabelled Google/Samsung.
4. **Read:** `GET /passes/{id}` and `/me/passes` return one entitlement with resource summaries: provider, readiness/reasons, desired/published revisions, lifecycle and evidence-qualified installations.
5. **Add:** stable authorized resource-action endpoints mint current save payloads at click time. Do not persist expiring save tokens as permanent artifacts or embed them prematurely in emails.

Web recommends a likely provider but retains other eligible choices in an accessible secondary chooser. Emails offer every eligible native provider using its compliant branded button. OS detection and button clicks never establish installation.

## Security, lifecycle and failure isolation

Every resource/artifact/template/callback lookup must resolve through tenant, mode, provider account and native namespace. Shared platform accounts require explicit organization grants; they must not become arbitrary fallback issuers. Credentials need provider/account/environment/purpose-bound encryption, least privilege and rotation without issuer-identity drift. Signing keys, API credentials and rotation seeds must not enter browser projections.

Serialize external writes per resource; reject stale generations and reconcile ambiguous outcomes. One provider failure must neither roll back another’s publication nor report aggregate success.

Domain revocation denies redemption independently of asynchronous wallet updates. Keep holder unlink, distribution-link rotation, resource revocation and physical wallet deletion distinct. Apple’s current fetch is addressed by pass type/serial, not device (`apple/routes.ts:111-131`); removing one registration cannot selectively revoke its shared artifact. Report and reject unsupported physical-device operations rather than affecting siblings.

## Rollout and observable acceptance

1. Introduce neutral revisions/resources and explicit account grants; preserve legacy Apple documents as Apple projections.
2. Backfill existing Apple artifacts/history without inventing missing canonical history. Preserve serials, tokens, URLs, registrations and update cursors: Apple filters `revision > since` (`apple/repo.ts:114-143`), so resetting that sequence strands installed clients.
3. Cut over builder, API contracts, scanner aliases/validity, holder/public views, email, bundles, queues, reissue and retention. Update every consuming router before emitting new variants; then remove obsolete single-artifact columns/triggers.
4. Enable each additional adapter only after native lifecycle and readiness acceptance.

**Acceptance:** one entitlement installs concurrently across eligible providers/devices; one registration suppresses no other add action. A Google-relevant edit unused by Apple still updates Google. Blocked Samsung provisioning leaves Apple working. Resource revocation denies that resource’s credential without duplicating or cancelling sibling entitlement use; domain revocation denies all. Cross-tenant/account/mode access fails. Retries create no duplicate native objects, stale updates cannot resurrect revoked state, and existing Apple clients continue updating after migration.
