# Partner Data Governance & Privacy Lifecycle Audit

## Assessment and evidence boundary

Read-only review of partner integrations, personal data flows, retention, export/correction, offboarding, scanner data, and configured processors. No edits, builds, tests, network calls, production/account checks, or secret reads. Acceptance scenarios are proposed, not executed. No new urgent P1 security issue was established.

## Data-flow map

| Flow | Data, purpose, and recipients |
|---|---|
| **Partner source → PassBook** | Connectors fetch records using an external reference, or receive partner-signed webhooks. Mapping can select fields for pass inputs; holder email can drive assignment and optional email. “Webhook push” is inbound to PassBook, not outbound partner delivery (`docs/extending.md:83-100`; `src/worker/modules/connections/records.ts:54-69,139-183`). |
| **API → partner** | An org-bound `passes:read` key can retrieve pass details including holder/owner email, personalization, pass JSON, delivery/device data, and public links (`docs/api.md:18-27`; `src/worker/modules/passes/detail.ts:34-54,158-196`). A user can download active passes as `.pkpasses`; the reviewed contract-operations audit already notes there is no complete organization export (`src/worker/modules/me/routes.ts:50-74`; `docs/audits/2026-11-07/reviews/business-contract-operations.md`, finding 4). |
| **PassBook → holder / Apple** | Optional email delivery sends a rendered pass summary and bearer link, with an optional signed pass attachment, through the Cloudflare Email Sending binding. The signed `.pkpass` is also downloadable by bearer link; APNs receives device push tokens and pass-type topic notifications (`src/worker/modules/delivery/email.ts:65-130`; `src/worker/modules/delivery/mailer.ts:31-43`; `src/worker/modules/delivery/apns.ts:34-55`). |
| **Scanner → PassBook** | Camera frames are decoded in the browser; barcode text is sent to `/resolve` or `/actions`. Scan records link to pass, scanner/event/staff/actor, method, outcome, reason and time; the stored request hash is not the raw code (`src/web/scan/camera/decode-worker.ts:32-50`; `src/web/scan/api/scan-api.ts:193-196`; `migrations/0014_scan.sql:98-127`; `src/worker/modules/scan/act-claim.ts:16-19`). |
| **Photos, devices, telemetry** | Member photos are cropped PNGs with ancillary metadata removed, stored in R2, and optionally included in Wallet. Scanner photo access uses role/org/pass checks and a one-hour actor-bound grant (`src/worker/modules/passes/member-photo-bytes.ts:1-15`; `src/worker/modules/scan/assets.ts:31-59`). Apple registrations store push tokens; scanner records store device label/IP prefix and reported capabilities. Analytics events contain operational dimensions (event, org/template/identity IDs, outcome/mode/count), not member fields (`src/worker/platform/analytics.ts:6-54`). |

## Findings

### P2 — Organization deletion is a status change, not tenant erasure  
*Expands the existing B2B offboarding finding; not a separate root cause.*

**Persona / stage / action:** Partner operator; contract termination; `DELETE /api/v1/orgs/{id}`.

**Evidence and impact:** `deleteOrg` calls `markOrgDeleted`, which only sets the status, clears the default identity, and updates a timestamp; its own comment says passes and audit rows keep their org reference (`src/worker/modules/orgs/service.ts:209-218`; `src/worker/modules/orgs/repo.ts:107-112`). Passes, versions, photos and other records remain in D1/R2. The separate pass-removal job purges an individually removed pass after a seven-day grace period; organization deletion does not invoke it (`src/worker/modules/passes/jobs.ts:15-17,35-62`).

**Countercontrols:** Deleted orgs are hidden and inactive; individual pass removal has a bounded cleanup workflow. The prior contract-operations audit already flags soft deletion.

**Recommendation / acceptance:** Provide an audited tenant-export/erasure workflow with explicit retained-audit and external-copy exceptions. Seed an org with passes, versions, photos, connections and scans; after termination, verify the agreed D1/R2 deletion report and that no live credentials or access remain.

### P2 — Webhook staging retains the entire partner record after processing

**Persona / stage / action:** Partner data owner; ongoing sync; sending a signed webhook record with fields not needed by the pass.

**Evidence and impact:** `receiveWebhook` inserts each verified record into `connection_inbox` before later mapping/application (`src/worker/modules/connections/webhooks.ts:60-86`; `repo-passes.ts:165-180`). The inbox stores the whole JSON record; the configured mapping is applied later, and with no mapping the record passes through unchanged (`src/worker/modules/connections/mapping.ts:112-123`). Successful processing does not remove inbox rows; retention removes them with webhook events after seven days (`jobs.ts:16-18,111-114`; `repo-sync.ts:63-65`). Unmapped personal fields therefore remain stored even when not needed by the resulting pass.

**Countercontrols:** HMAC verification, bounded webhook input, org/connection checks, encrypted credentials and seven-day staging retention.

**Recommendation / acceptance:** Minimize fields before persistence where possible and delete staged rows after successful processing while preserving retry semantics. Send a signed record with a mapped field and an unused sensitive field; verify the unused field is not retained after processing and retries still work.

### P2 — Configured scan retention leaves derived attendance state

**Persona / stage / action:** Venue or membership partner; post-event retention; setting the scan retention period.

**Evidence and impact:** The default scan retention is 396 days (`src/shared/contracts/settings.ts:39-40`). The daily job deletes only `scans` rows (`src/worker/modules/scan/jobs.ts:69-82`; `repo-scans.ts:260-262`). `scan_gates` and `scan_presence` separately retain pass-linked state, including first/last scan timestamps and the last scan ID (`migrations/0014_scan.sql:150-169`; `migrations/0022_scan_check_in.sql:8-24`). Thus attendance-related state can outlive the configured scan-log period for as long as the pass remains.

**Countercontrols:** Raw scan rows and pass events have separate retention mechanisms; state supports admission enforcement.

**Recommendation / acceptance:** Define which state is essential for active admission versus historical attendance, and give both explicit retention rules. Lower the configured period in a fixture; verify raw scans and any no-longer-needed presence/gate state expire without silently changing valid admission policy.

### P3 — Corrected pass data can persist indefinitely in retained history

**Persona / stage / action:** Issuer or holder; correction/deletion request; updating a member’s pass fields.

**Evidence and impact:** Version cleanup is count-based: it keeps the current version plus the configured number of prior versions (default three), not a time-bounded history (`src/worker/modules/passes/jobs.ts:20-30,54-62`; `src/worker/modules/passes/repo-history.ts:146-158`). Older retained `personalization`, `pass_json` and R2 objects can therefore preserve corrected member data indefinitely if the pass is not updated again.

**Countercontrols:** Purged versions clear personalization/JSON and delete referenced objects; deleting a pass invokes the seven-day cleanup.

**Recommendation / acceptance:** Agree an age limit or explicit history exception with partners. Update a pass containing personal data, then verify that after the agreed age its superseded values and R2 objects are gone while the current pass remains correct.

### P3 — User exit supports access revocation, not profile erasure

**Persona / stage / action:** Departing user or administrator; account closure; disabling the account or removing email.

**Evidence and impact:** The user API offers disable/enable, email changes/removal and session revocation, but no user deletion route (`src/worker/modules/users/routes.ts:60-104,137-170`). Disabling revokes sessions but leaves the user row, primary email and linked identity records (`src/worker/modules/users/service.ts:145-165`; `migrations/0001_platform.sql:19-45,50-64`). The primary email cannot be removed through the user’s own email workflow (`src/worker/modules/me/service.ts:142-153`).

**Countercontrols:** Disable and session revocation address continued access; verified secondary emails can be removed.

**Recommendation / acceptance:** Define an account-erasure/de-identification procedure that handles IdP identities, emails, sessions, ownership links and retained audit data. Disable a synthetic user, complete that procedure, and verify only documented records remain.

### P3 — Revocation leaves scanner device metadata in place

**Persona / stage / action:** Partner security administrator; scanner retirement; revoking a paired device.

**Evidence and impact:** The only scanner removal route is a revoke action. It preserves token columns and leaves fields such as paired label, last IP prefix and last-seen time; scanning-device rows also store capabilities and a report timestamp (`src/worker/modules/scan/routes-scanners.ts:182-189`; `repo-scanners.ts:280-287`; `migrations/0014_scan.sql:67-74`; `migrations/0024_scanning_sessions.sql:18-29`). No scan-retention job covers these tables.

**Countercontrols:** Revocation disables use on the next request and clears staff binding/pending pairing data.

**Recommendation / acceptance:** Define a retention or redaction window for revoked-device metadata. Revoke a scanner and verify that identifying device metadata is purged or minimized after the agreed period without weakening immediate revocation.

### P3 — Processor and residency disclosures are not established by the repository

**Persona / stage / action:** Partner privacy/procurement lead; contracting; reviewing processor/subprocessor commitments.

**Evidence and impact:** Worker configuration binds D1, R2, Durable Objects, Email Sending and Analytics Engine, and configures an OIDC issuer (`wrangler.jsonc:11-12,52,74-83,118,145-152`). The reviewed repository documentation does not provide a DPA, subprocessor list, data-location commitment or complete data-retention schedule. This prevents repository-only confirmation of Cloudflare processing terms, account jurisdiction, backup deletion or downstream mail handling.

**Recommendation / acceptance:** Publish the processor/purpose inventory and retention schedule; have the owner verify the applicable Cloudflare DPA, account jurisdiction and any relevant provider terms. Those account/legal controls were not verifiable here; no legal conclusion is made.

## Positive controls and reviewed coverage

API keys are hashed and org-bound; connector secrets are envelope-encrypted and omitted from API DTOs. Photo metadata is stripped and scanner access is scoped. Event data sanitizes emails/tokens and hashes device identifiers; application logs redact sensitive keys and invocation logging is disabled. These controls reduce exposure but do not replace lifecycle deletion or retention commitments.

Reviewed `docs/api.md`, `docs/extending.md`, `docs/security.md`, `docs/operations.md`, `docs/operations-scanning.md`, `wrangler.jsonc`; relevant platform, auth, org, user, pass, holder, connection, delivery, Apple, event, audit, scan and analytics modules; and migrations `0001`, `0010`, `0014`, `0015`, `0021`, `0022`, `0024`. Related existing partner/contract audits were reviewed to avoid duplicating their findings.
