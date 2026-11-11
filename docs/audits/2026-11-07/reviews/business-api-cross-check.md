# Partner API contract cross-check

## Evidence boundary

Read-only source audit. No edits, builds, tests, external requests, or secret inspection. Findings concern the existing API, not the unrelated Android patch. Implementation facts are source-confirmed; operational consequences and acceptance scenarios are inferred, not exercised.

**Assessment:** The lifecycle is implemented, but the published contract is insufficient for a dependable schema-only partner integration. No new P1 security finding was established.

## Partner lifecycle: shipped contract

Persona: an organization’s CRM/loyalty integration, using an org-bound key provisioned by an administrator.

| Stage/action | Required scope and actual response |
|---|---|
| Discover template | `templates:read`; template reads accept keys, writes require an administrator. Evidence: `src/worker/modules/templates/routes.ts:43-52`. |
| Issue pass | `POST /api/v1/passes`, `passes:write`; **201**, including `id`, `version`, `status`, `mode`, `holderState`, `personalization`, `downloadUrl`, `publicUrl`, versions and deliveries. Evidence: `src/worker/modules/passes/routes-write.ts:24-64`; `src/shared/contracts/passes.ts:112-139`. |
| Update | `PATCH /passes/{id}`, `passes:write`; **200** detail plus quoted-version `ETag`. `If-Match` is supported but **optional**; stale supplied versions produce **412 `VERSION_CONFLICT`**. Input patches merge fields; `null` removes a field. Evidence: `routes-write.ts:14-20,70-88`; `src/worker/modules/passes/service.ts:52-86`. |
| Assign/transfer holder | Writes require `holders:write`; `GET /holders` requires `passes:read`. Responses include `passId`, `state`, `email`, owner and block information. Assignment can immediately attach an eligible verified account; changing an already-owned pass requires reassignment. Evidence: `src/worker/modules/holders/routes.ts:24-57`; `service.ts:65-122,160-181`; `src/shared/contracts/holders.ts:7-15`. |
| Observe status | `passes:read` accesses pass detail, events and devices. Device responses distinguish `current`, `waiting`, `push_failing`, `removed`, `unknown`, with fetch/push information. Global `/api/v1/status` is **admin-only**, unlike public `/health`, which merely returns `{ok:true}`. Evidence: `src/worker/modules/events/routes.ts:12-49`; `src/shared/contracts/events.ts:132-176`; `src/worker/modules/status/routes.ts:11-12`; `src/worker/app.ts:107`. |
| Bundle/share | Create requires `passes:write`; **201** includes bundle `id`, `mode`, capability `url`, holder email and member passes. Reads require `passes:read`; email returns **202 `{ok:true}`**. No issuance-style idempotency mechanism is consumed. Evidence: `src/worker/modules/bundles/routes.ts:24-104`; `src/shared/contracts/bundles.ts:32-43`. |
| Broadcast/change | All broadcast operations require `messages:write`; changes additionally require `passes:write`, and items additionally require `passes:read`. Create returns **201** with `id`, `state`, `counts`, `errorCode`; poll progress. Retry creates a **new** broadcast using the original target, not a failed-recipient-only retry. Evidence: `src/worker/modules/broadcasts/routes.ts:31-41,69-85,185-202`; `service-edit.ts:80-110`; `src/shared/contracts/broadcasts.ts:59-82`. |

### Errors, retries and support

Errors use `application/problem+json` with stable `code`, status, detail and request ID. Every request receives `x-request-id`; rate-limit errors include `Retry-After`. Evidence: `src/worker/platform/context.ts:50-62`; `errors.ts:74-76,126-169`.

Clients should correct 400/422 payload failures, resolve 401/403 credentials/scopes, and re-read/rebase after 412. A 404 can represent org/mode invisibility, not merely deletion. Ambiguous failures must not trigger blind retries of bundle/broadcast creation: unlike pass creation, those operations consume no idempotency key.

## Findings and recommendations

### P2 — Declare authentication and conditional headers in OpenAPI

**Persona/stage/action:** SDK developer; onboarding; generate an authenticated issuance/update client.

`docs/api.md:3-4` identifies generated OpenAPI as the reference, but registration exposes only params, query, JSON bodies and responses—no security requirements or request-header schema (`src/worker/platform/openapi.ts:11-22,71-94`). Runtime handlers separately consume `Authorization`, `Idempotency-Key` and `If-Match` (`auth.ts:166-184`; `passes/routes-write.ts:14-20,39-44`).

**Impact:** A schema-only client cannot discover the required auth configuration or generate these operation-header inputs; custom overrides are necessary. Omitting `If-Match` silently removes conflict protection.

**Countercontrols:** Prose examples and runtime guards exist.

**Fix/acceptance:** Publish bearer/session security, scopes, header parameters, and response headers. Inspect generated operations, then exercise a generated client against the local fake app: authenticated issue, same-key replay and stale-version rejection must work without undocumented overrides.

### P2 — Recover abandoned issuance reservations

**Persona/stage/action:** CRM synchronization worker; retry after interrupted issuance.

The key is reserved before creation. A matching reservation whose resource is absent always returns **409 `IDEMPOTENCY_IN_PROGRESS`**; only caught pre-insert failures release it (`src/worker/modules/passes/create.ts:205-229`). No lease recovery exists; general cleanup deletes keys older than seven days (`repo-ops.ts:58-103`; `jobs.ts:54-62`). Soft-deleting an issued resource also makes replay encounter the missing-resource branch (`repo.ts:9-20`).

**Impact:** An abandoned reservation can strand an order’s retries until retention cleanup; a deleted resource is misleadingly reported as still running.

**Countercontrols:** Caught failures release reservations, and post-insert retries reuse the existing pass.

**Fix/acceptance:** Add fenced stale-reservation recovery and distinguish deleted resources. Seed an aged matching reservation pointing to a missing pass; repeated fake-caller requests must recover safely or return an actionable terminal result, never perpetual “retry shortly.”

### P2 — Correct the published scope matrix

**Persona/stage/action:** Least-privilege marketing integration; recipient reconciliation and delivery monitoring.

`docs/api.md:19-26` advertises broadcast items under `messages:write` and “delivery” under `passes:read`. Actually, items also require `passes:read`; `/api/v1/delivery` requires an administrator (`broadcasts/routes.ts:197-202`; `delivery/routes.ts:8-9`). Holder-list read scope and admin-only status are also absent from the matrix.

**Impact:** Correctly following the guide produces 401/403 during operational reconciliation.

**Countercontrols:** Restrictions prevent unauthorized access; pass detail already exposes delivery entries.

**Fix/acceptance:** Correct documentation rather than weaken authorization. Add a least-privilege endpoint/scope matrix test covering holder reads, broadcast items, delivery and status.

### P2 — Make partial bulk-holder assignment recoverable

**Persona/stage/action:** CRM import; assign a batch of holders.

Bulk assignment validates email, scope and mode first, then applies items sequentially. Ownership conflicts are checked only during mutation (`src/worker/modules/holders/service.ts:95-101,126-157`). An unowned first pass followed by an owned second pass with a different requested email therefore leaves the first changed while returning one 409, without per-item results.

**Impact:** The caller cannot distinguish committed assignments from failed ones using the error response.

**Countercontrols:** Foreign IDs and invalid emails are preflighted; unchanged-email assignment is a no-op.

**Fix/acceptance:** Provide explicit per-item outcomes or transactional all-or-nothing behavior. Exercise that two-pass fixture and verify the response accurately identifies every committed action.

### P3 — Publish complete replay and diagnostic policies

**Persona/stage/action:** Partner support engineer; recover delayed or partially completed work.

The guide promises the “first result” (`docs/api.md:63-64`), but replay reads **current** pass detail (`create.ts:216-222`), and keys expire after seven-day cleanup. Broadcast item failures retain only outcome/silent, discarding caught error codes (`broadcasts/apply.ts:110-113`; `src/shared/contracts/broadcasts.ts:131-138`).

The API guide also specifies no compatibility/deprecation policy despite `/api/v1` and fixed OpenAPI version `1.0.0` (`src/worker/app.ts:145-149`). It asks callers to quote request IDs without linking support. `docs/operations.md:181-193` documents `support@passbook.mobile`, but forwarding and service commitments remain account-level, unverified controls.

**Recommendation/acceptance:** Document retention, current-resource replay, endpoint-specific retry safety, compatibility notices and support escalation. Expose stable per-item broadcast failure codes. Check replay after update/rotation, replay after retention, and one deterministic broadcast failure.

## Local verification handoff

Reuse `fakeAuth`, `createApp({stores})`, `setupKit` and `app.request` from `src/worker/modules/passes/routes.test.ts:10-43`. Existing tests cover basic replay/conflict behavior (`84-95,135-156`), holder bulk scope preflight (`holders/bulk.test.ts:45-64`) and broadcast item scope (`broadcasts/broadcasts-more.test.ts:237-257`). These were inspected, not run.

Existing stale-recipient delivery and test-key/live-connector findings remain partner launch concerns; retain the prior audit’s remediation rather than duplicate them here.
