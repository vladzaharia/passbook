# Partner machine API developer journey

## Verdict and evidence boundary

The core supports assisted partner issuance and updates, but the published contract is not yet sufficient for a reliable docs-only integration.

This is a **source-only baseline audit**, not findings introduced by the unrelated Android patch. No repository edits, builds, tests, runtime requests, production access or secret reads were performed. All acceptance scenarios below are **proposed, not executed**. No new P1 security risk was established; relevant existing security findings remain separate release dependencies.

## Positive controls

- Discoverable entry point: `README.md:7-9` links the machine guide, which identifies public OpenAPI (`docs/api.md:3-4`).
- Bearer credentials have runtime scope checks and organization restrictions (`src/worker/platform/auth.ts:166-198`).
- Pass creation reserves its resource ID and canonicalizes the idempotency payload (`src/worker/modules/passes/create.ts:199-222`).
- Pass pagination uses descending-ID keyset queries and limit-plus-one detection (`src/worker/modules/passes/repo-list.ts:60,83-97`).
- Errors provide stable codes, field issues and request correlation; rate-limit responses include `Retry-After` (`src/worker/platform/errors.ts:74-76,126-169`).

## Findings

### 1. P2 high — Make OpenAPI describe callable operations

**Partner/stage/action:** Backend or SDK developer importing the reference to authenticate, create/update passes and upload images.

**Confirmed:** The route model supports path/query parameters and JSON bodies, but not security requirements, request headers, response headers or alternate request media (`src/worker/platform/openapi.ts:11-23,71-93`). Document configuration adds no credential scheme (`src/worker/app.ts:145-149`). Runtime operations nevertheless consume `Idempotency-Key` and `If-Match` (`modules/passes/routes-write.ts:14-20,39-44`). PNG uploads declare no request body although their handler reads raw bytes (`modules/passes/routes-assets.ts:40-53`).

**Impact:** Reference-driven clients require manual authentication/header customization; generated upload operations lack the payload contract. Omitting the undocumented-by-schema concurrency header bypasses stale-version protection.

**Countercontrol:** The prose guide describes bearer authentication, headers and binary exceptions.

**Recommendation:** Extend route metadata to describe authentication eligibility, required scopes, request/response headers, operation-specific errors and accepted media.

**Acceptance:** A generated client can authenticate, deduplicate creation, perform conditional updates and upload PNG bytes without operation-specific overrides.

### 2. P2 high — Apply the accepted pass-list scan filter

**Partner/stage/action:** Venue or CRM integrator exporting checked-in members or inactive customers.

**Confirmed:** `ScanTarget` is accepted in the pass-list query (`src/shared/contracts/passes.ts:155-170`; variants in `scan.ts:310-314`). The route drops it when constructing the service query (`src/worker/modules/passes/routes.ts:64-75`). The consuming service/repository have no scan predicate (`service.ts:36-41`; `repo-list.ts:5-23,31-79`).

**Impact:** A successful filtered request returns the entire otherwise-matching audience, producing incorrect exports or downstream targeting.

**Countercontrols:** Organization, mode and other filters still apply; this is not evidence of cross-tenant disclosure.

**Recommendation:** Implement the advertised predicate through repository pagination—not merely field forwarding.

**Acceptance:** Same-org/mode fixtures with different check-in histories produce distinct `checkedIn:true/false` results; 30/90-day filters constrain every page.

### 3. P2 high — Separate test and live idempotency namespaces

**Partner/stage/action:** CRM developer promoting a tested issuance job using customer-derived idempotency keys.

**Confirmed:** The request hash includes mode (`src/worker/modules/passes/create.ts:206`), but uniqueness and lookup use only organization and key (`migrations/0001_platform.sql:472-478`; `modules/passes/repo-ops.ts:70-85`).

**Impact:** Reusing the same request/key with live credentials after testing in the same organization returns `409 IDEMPOTENCY_KEY_REUSED`. Test issuance occupies the live namespace.

**Countercontrol:** Hash differences prevent replaying the other mode’s pass; no disclosure was established.

**Recommendation:** Include mode in the claim, lookup and uniqueness boundary.

**Acceptance:** Identical key/body combinations issue distinct test/live passes; retries within either mode return only its original pass.

### 4. P2 high — Document the actual deduplication lifetime

**Partner/stage/action:** Membership batch producer replaying an outage backlog.

**Confirmed:** The guide promises the first result for the same key/body without stating a lifetime (`docs/api.md:63-64`). Daily cleanup removes keys older than seven days (`src/worker/modules/passes/jobs.ts:54-62`). After cleanup, creation reserves another resource ID (`create.ts:207-225`). An `externalId` does not prevent duplication: its index is non-unique (`migrations/0001_platform.sql:279,314`).

**Impact:** A delayed retry can create a second still-valid membership rather than recover the original result.

**Countercontrol:** Existing deduplication protects requests while their key records remain.

**Recommendation:** Publish the retention window, namespace and transient `IDEMPOTENCY_IN_PROGRESS` handling. Provide a reconciliation procedure for retries beyond that window; do not present idempotency keys as permanent business uniqueness.

**Acceptance:** Replay after retention cleanup and demonstrate that the documented reconciliation procedure avoids issuing another membership.

### 5. P2 high — Generate webhook examples from saved configuration

**Partner/stage/action:** Upstream developer making the first signed request after customizing headers or payload pointers.

**Confirmed:** Webhook-push supports configurable signature/timestamp headers and payload pointers (`src/worker/connectors/webhook-push/index.ts:15-42,65-75`). These top-level settings are not hidden by the wizard’s field filter (`src/web/admin/connections/config-schema.ts:89-101`; `wizard-steps.tsx:151-161,220-227`). However, the handoff receives only URL, secret and connector type (`create-wizard.tsx:193-197`), and always emits default payloads and `x-wallet-*` headers (`created-step.tsx:5-21`).

**Impact:** For a saved custom signature header, the copied first-request example fails signature verification; changed pointers can instead produce `WEBHOOK_PAYLOAD` (`src/worker/modules/connections/webhooks.ts:51-57`).

**Countercontrol:** The example matches default configuration.

**Recommendation:** Generate the example from effective saved configuration.

**Acceptance:** Configure `x-partner-signature`, copy the displayed request and successfully submit it without manual corrections.

## P3 gaps and business recommendations

### Complete the operator-to-partner handoff

Organization administration is session-only; template discovery needs `templates:read`; creation still requires explicit organization/template IDs (`src/worker/modules/orgs/routes.ts:26-27`; `templates/routes.ts:42-50`; `src/shared/contracts/passes.ts:174-177`). The guide starts with placeholders rather than the preceding handoff (`docs/api.md:57-62`).

Provide the organization ID, template/version, input sample, scopes, mode and sandbox-email evidence. Document that promotion requires a new Live key—not changing a Test key. Correct the claimed console `wlt_test_` prefix: the UI shows `wlt_<prefix>` with a separate mode badge (`docs/api.md:31-32`; `src/web/admin/api-keys/key-columns.tsx:23-24,52-67`).

**Acceptance:** A developer can complete test issuance and live cutover using only the handoff, without requesting admin access.

### Publish persistent webhook and scan-feed guidance

The checked-in API guide only excludes hooks from key authentication (`docs/api.md:122-123`). The signed example is in the creation step, not the ongoing webhook panel (`created-step.tsx:59-74`; `webhook.tsx:37-75`).

Document signing bytes, event-ID/retry semantics, limits and the distinction between acceptance and application. Add the omitted `scans:read` scope and feed example (`docs/api.md:17-23`; `src/worker/modules/scan/routes-scans.ts:43-83`). Do not imply outbound webhook delivery exists.

**Acceptance:** A handed-off developer can sign/retry updates and poll scans using persistent guidance.

### Establish the compatibility artifact

OpenAPI reports literal version `1.0.0` and includes non-key protocols (`src/worker/app.ts:109-149`; `platform/app.test.ts:67-80`). Targeted repository searches found no distributable SDK, pinned OpenAPI artifact or compatibility policy; this does not exclude private artifacts.

Publish the supported machine-API boundary, release-specific specification and breaking-change policy. A maintained pagination/error/retry example is more immediately useful than promising an SDK.

**Acceptance:** Partners can identify their supported contract, iterate `nextCursor`, handle documented retry/conflict responses and detect incompatible contract changes.
