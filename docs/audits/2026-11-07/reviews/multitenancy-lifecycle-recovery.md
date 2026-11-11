## Conclusion

Current source supports **platform-operated organizations**, not the requested delegated tenant administration or complete tenant offboarding. Suspension is an access gate; organization deletion is a tombstone, not erasure.

This is a source-only audit. The current Android diff does not introduce these lifecycle observations.

### 1. Administration and onboarding

**Established architecture — high confidence; P1 target-policy gap**

All organization lifecycle routes require global `admin` sessions (`src/worker/modules/orgs/routes.ts:26-55`; `src/worker/platform/auth.ts:130-152`). Per-org RBAC is explicitly excluded from v1 (`docs/design/platform-architecture.md:22-25`). Creation immediately makes the organization active without assigning an owner (`orgs/service.ts:101-127`).

Therefore:
- Global administrators can manage every organization.
- Scoped API keys can perform permitted machine operations, but cannot administer organizations.
- There is no delegated organization-admin or agency-grant model.

**Target:** Explicit memberships/grants binding principal, organization, role and validity. Agency access should enumerate authorized organizations—not imply platform administration. Preserve global operator/break-glass authority as a separately audited exception.

Removing an organization administrator must revoke that grant immediately, **without disabling the customer’s global account or unrelated organization grants**. Customer aggregation remains owner-based (`modules/me/repo.ts:41-49`); it must not confer organization-management authority.

Existing IdP roles are session snapshots, lasting up to one hour idle/twelve hours absolute (`auth/sessions.ts:18-25,78-86`). Current offboarding requires IdP group removal **and** local session revocation (`docs/security.md:73`). Disabling a user revokes their sessions; re-enabling does not restore those revoked sessions (`users/service.ts:142-161`).

### 2. Suspend, reactivate and retire artifacts

**Established controls**

The status operation changes the organization row and writes audit history; it does not revoke dependent credentials (`orgs/service.ts:187-205`). Public capabilities, Apple authorization, push/email delivery and connection consumers check organization activity (`public/service.ts:33-38`; `apple/service.ts:50-57`; `delivery/push.ts:105-114`; `connections/webhooks.ts:99-105`).

Reactivation consequently makes otherwise-valid, unrevoked organization credentials usable again. It does not reconstruct work already cancelled or acknowledged during suspension.

**Confirmed current defects — P2, confidence 0.99**

- **Exclude inactive organizations from holder bundles.** `me/repo.ts:79-94` selects owned active passes without organization status; `me/service.ts:250-264` packages their R2 artifacts directly. A holder can therefore download an unregistered pass after its organization is suspended/deleted. This independently confirms `09-red-auth-tenant.md`, finding 3. Historical customer metadata visibility is a separate policy decision.
- **Reject archived templates during new issuance.** Archival explicitly promises that new passes cannot use the template (`templates/lifecycle.ts:10-24`). However, issuance calls `resolveTemplate` (`passes/create.ts:66-79`), whose registry rejects deleted—not archived—templates (`templates/registry.ts:125-144`). A valid same-org template ID remains usable for new issuance. Existing-pass rebuilding must remain supported.

**Target lifecycle gap**

Suspension is not a universal write freeze: pass publication checks organization existence, not active status (`passes/publish.ts:88-100`); reissue selection likewise lacks an organization-status predicate (`passes/repo-ops.ts:107-140`). Template imports can persist after intake without rechecking organization state (`templates/import-pipeline.ts:154-215`).

Define which operations suspension permits, then enforce current organization/grant generations at commit and delivery—not only at request intake.

**Retirement ordering matters:** removal publishes a final voided/expired artifact; it cannot delete a device-resident pass (`passes/remove.ts:22-57`). Suspension blocks both its push and Apple retrieval. Do not suspend first and then claim successful Wallet retirement.

### 3. Credential and device revocation

**Established behavior / target-policy consequences**

- API-key resolution checks key revocation, expiry and organization status, **not creator status** (`api-keys/service.ts:132-153`). Disabling an administrator therefore leaves their known keys usable. Keys are creator-attributed service credentials today, not user-bound credentials. Offboarding must explicitly revoke or transfer them.
- Webhook rotation replaces the secret but does not increment connection generation (`connections/actions.ts:106-133`). Queued jobs retain identifiers, then adopt current configuration during processing (`connections/webhooks.ts:80-84,99-131`). This confirms the previously reported stale-authority issue in `10-red-pass-delivery.md`, finding 3.
- Scanner credentials are checked against D1 per request; terminal-token replacement invalidates the previous token (`scan/auth-store.ts:23-40`; `repo-scanners.ts:280-288`). Pausing/ending a scanning session is **not token revocation** (`scanning-sessions.ts:113-177`). Explicitly revoke devices and outstanding pairing authority.
- Client cache wiping exists (`src/web/scan/offline/wipe.ts:49-85`), but server revocation cannot guarantee deletion from an offline device. Include managed-device/local-storage cleanup in offboarding.
- Signer deletion is blocked while passes reference it. Rotation preserves pass type/team and replaces the signer credential (`identities/service.ts:192-203,227-295`). APNs push keys are team-scoped, potentially shared across organizations (`identities/repo-push-keys.ts:57-73`). One organization’s departure must not remove shared infrastructure credentials.

Link rotation changes the download capability, while publication preserves the ApplePass token (`passes/repo.ts:128-142`; `passes/publish.ts:125-128`). It is not comprehensive installed-pass credential revocation.

### 4. Close, export, erase and recover

**Confirmed capability gaps — high source confidence**

Organization deletion only sets `deleted`, clears the default identity and preserves dependent records (`orgs/service.ts:209-219`; `orgs/repo.ts:107-112`). It schedules no organization-wide erasure. Mounted org routes contain no tenant-wide export; template-package export is only the active template documents/assets (`templates/lifecycle.ts:29-50`).

Retention defaults are:
- Current pass version plus three previous versions;
- Audit: 365 days;
- Pass events: 90 days;
- Scans: 396 days;
- Test data: 30 days.

These are configurable application defaults, **not legal requirements** (`src/shared/contracts/settings.ts:31-44`). Pass deletion triggers physical cleanup after seven days (`passes/jobs.ts:15-16,35-62`); pass events cascade with pass deletion, while scan references become null (`migrations/0010_events.sql:3-7`; `0014_scan.sql:98-103`). Existing retention is not legal-hold-aware.

A purge cannot simply delete `orgs`: passes retain restrictive references, while audit/outbox/workflow organization references are not uniformly foreign-key cascades (`migrations/0001_platform.sql:264-279,403-460,490-502`).

Documented recovery restores **D1 only** (`docs/operations.md:197-199`). Retention deletes R2 objects, so rewinding D1 can resurrect missing-object references. This confirms the existing `14-cloudflare-ops.md:55-61` concern; off-platform backups remain unverified.

### 5. Minimum target runbooks

**Onboarding:** Approve owner/agency grants, identity/shared-key dependencies, key scopes, retention/export terms and recovery responsibilities before enabling issuance.

**Incident:** Suspend immediately; preserve evidence before retention; revoke compromised memberships/sessions, API/scanner credentials and pairing authority; rotate affected upstream/webhook/signing credentials with shared-dependency approval. Reconcile inbox/outbox/workflows before recovery. Do not treat suspension or secret rotation alone as invalidating queued intent.

**Planned offboarding:** Inventory dependencies; fence and drain issuance/source/scheduled work while retaining authorized retirement delivery; export an org-scoped manifest; retire passes and allow the agreed delivery grace; revoke credentials/devices; purge tenant records/artifacts with explicit retention exceptions; tombstone last. Never claim remote Wallet erasure.

**Restore:** Quiesce writers/consumers; recover aligned D1, R2 and required keys; replay post-backup revocations/erasures before reopening traffic. Tenant-specific recovery must not rewind other tenants’ writes.

**Migration risks:** Preserve tenant UUIDs and shared references. Credentials’ authenticated encryption binds `id|org_id|kind`, so tenant reassignment requires deliberate re-encryption (`platform/crypto.ts:24-25`). Do not infer memberships from holder email, creator attribution or existing global-admin status.

### Acceptance matrix — proposed, not executed

| Scenario | Required result |
|---|---|
| Org/agency administrator A targets B | Management denied; customer still sees their own verified A/B passes. |
| Remove A membership with active session | A authority immediately denied; unrelated grants/customer access remain. |
| Suspend A with queued/in-flight work | No unauthorized new effects; holder bundle excludes A; B unaffected. |
| Rotate/revoke, then reactivate | Old keys/tokens and stale queued authority remain invalid. |
| Archive template | New issuance rejected; existing-pass updates remain valid. |
| Close/export/erase | A-only manifest reconciles D1/R2/credentials and named retained exceptions. |
| Restore pre-revocation backup | Revoked/erased access does not resurrect; retained objects resolve; B’s newer data survives. |

**Owner/legal unknowns:** Controller/processor responsibilities, retention and hold requirements, export entitlements, deletion deadlines, backup/key custody, and acceptable device-retirement grace require explicit decisions.

No edits, tests, builds, production access or secret reads were performed.
