# Partner Integration Boundary Audit

## Yield — Boundaries

Read-only review of partner API-key provisioning and authorization, connection ownership/configuration, credential storage and rotation, inbound webhook handling, SSRF controls, record mapping, pass/holder ownership, and related partner documentation.

No edits, payload execution, network calls, builds, or tests were performed. **Confirmed** means directly visible in current source; consequences requiring runtime conditions are marked accordingly. Prior findings are cited where repeated because they are material to this integration boundary.

## Yield — Findings

### 1. P1 — Test-mode API keys can ingest live connector records

**Partner/lifecycle:** A partner using a test-mode key with `passes:write` and `passes:read`, while testing pass creation or connection binding.

`POST /passes` accepts `connectionId` and `externalRef` while setting the pass mode from the key (`src/worker/modules/passes/routes-write.ts:55-60`). Creation checks that the connection belongs to the same org, but does not compare its mode with the pass mode; manual-source passes retain the caller’s mode (`src/worker/modules/passes/create.ts:71-83`). The binding endpoint likewise checks organization ownership, not mode (`src/worker/modules/passes/connection-bind.ts:31-41`).

Connection sync selects and resolves passes by org, connection, and external reference without filtering pass mode (`src/worker/modules/connections/repo-passes.ts:48-50, 66-70, 94-98`). It fetches the upstream record and applies it to that pass (`src/worker/modules/connections/jobs.ts:61-65`; `src/worker/modules/connections/records.ts:118-120, 155-164`). A test-mode key can then list its test-mode pass (`src/worker/modules/passes/routes.ts:64-68`).

**Preconditions and impact:** The key has read/write scopes; the partner knows a same-org live connection ID and an **unused** upstream reference that returns a record. The live connector’s server-held credentials fetch that record, which is written to the test pass and becomes readable with the test key. Existing tenant checks do not prevent this cross-mode data flow. The unique connection/reference constraint prevents binding a reference already assigned to a pass, but not an unused live record (`migrations/0001_platform.sql:322-323`).

**Countercontrols:** Keys are mode-bound and ordinary by-ID access is mode-scoped; connection and pass orgs must match. Neither control prevents the live sync selector from processing a test-mode pass.

**Fix:** Reject test-mode pass creation/binding to live-only connections, or introduce explicitly mode-scoped test connections. Also enforce mode in background pass selectors and refresh processing.

**Acceptance scenario (not run):** With a test key, create or bind a test pass to a live connection and an unused valid reference. Assert no live upstream fetch occurs and no live record appears in test-mode reads.

**Overlap:** Independently reconfirmed from current source; materially integration-specific counterpart to `docs/audits/2026-11-07/reviews/10-red-pass-delivery.md` finding 2.

### 2. P2 — Accepted webhook jobs survive secret rotation and configuration changes

**Partner/lifecycle:** Admin rotating a compromised webhook secret, switching webhook mode off, or changing mapping/auto-create policy while accepted work is queued.

Webhook jobs carry only connection ID, event ID, and references—no intake generation (`src/worker/jobs/types.ts:13-18`; `src/worker/modules/connections/webhooks.ts:79-84`). The consumer reloads the current connection, checks only that it remains enabled and its org active, then prepares and applies the job using current configuration (`src/worker/modules/connections/webhooks.ts:100-112, 131`). It does not recheck webhook mode or the secret/generation that authorized intake.

Webhook-secret rotation replaces the credential without changing generation (`src/worker/modules/connections/actions.ts:120-124`). Mode and webhook-secret changes are also absent from the `FENCED` list (`src/worker/modules/connections/service-shared.ts:18-27`); configuration changes that *do* bump generation still cannot fence these jobs because the job carries no generation. Thus an event accepted under old authority can be applied after rotation or mode change. If current settings enable `autoCreate`/`autoEmail`, that queued event can create and email passes under the new policy (`src/worker/modules/connections/records.ts:172-182`).

**Preconditions and impact:** A valid event is accepted before rotation/change and its queue processing is delayed. During a secret-compromise response, rotation stops future old-secret submissions but does not invalidate already accepted work.

**Countercontrols:** Intake verifies HMAC/timestamp and deduplicates events; processing drops jobs for disabled connections or inactive orgs. These do not invalidate work on secret rotation or mode/config changes.

**Fix:** Bind accepted events to the authorization/configuration generation and enforce it at processing. Provide a rotation/pause operation that invalidates pending events when incident containment requires it.

**Acceptance scenario (not run):** Hold an accepted event, rotate the secret or disable webhook mode/change auto-create policy, then process it. Assert no stale event creates, updates, voids, or emails a pass; new-secret deliveries still work.

**Overlap:** Independently reconfirmed from current source; material counterpart to `10-red-pass-delivery.md` finding 3.

### 3. P3 — Webhook throttling is per source IP, not per connection

**Partner/lifecycle:** A partner’s bursty or compromised webhook sender; operational capacity and incident containment.

The route keys its limiter by request path plus client IP (`src/worker/modules/connections/routes.ts:259-263`), and the configured limit is 120 requests per minute (`wrangler.jsonc:136`). Each built-in webhook connector accepts up to 100 references/records (`src/worker/connectors/http-json/index.ts:19, 290-292`; `src/worker/connectors/webhook-push/index.ts:12, 75-76`), split into jobs of up to 20 references (`src/worker/modules/connections/sync.ts:42-43`). That permits up to 12,000 references/minute from one source IP; distinct IPs use distinct buckets, with no aggregate per-connection intake limit shown.

**Impact and preconditions:** A partner malfunction or stolen signing secret can create substantial queue/mapping work; distributed senders bypass the per-IP ceiling. If auto-create/email is enabled, accepted records can also drive pass issuance and mail. This is a workload-capacity risk, not evidence of production exhaustion.

**Countercontrols:** Per-IP limiting, a 256 KiB signed-body cap, 100-record cap, and per-job work bounds exist. `autoCreate` and `autoEmail` default off (`src/worker/modules/connections/service.ts:143-145`).

**Fix:** Add an aggregate per-connection (and, if appropriate, org) intake/reference budget in addition to the IP limit.

**Acceptance scenario (not run):** Submit traffic for one connection from multiple IP buckets and confirm aggregate request/reference limits cap queued work independently of source IP.

### 4. P3 — DNS validation is not bound to the actual outbound destination

**Partner/lifecycle:** Admin configures an HTTP JSON connector with credentials; a compromised or rebinding upstream hostname could target a non-public address.

`createSafeFetch` resolves and checks the hostname, then passes the original hostname URL to `fetchImpl` (`src/worker/platform/safe-fetch.ts:193-214`). It does not pin the validated address or otherwise demonstrate that the outbound fetch uses the checked DNS answer. The HTTP JSON connector sends its stored bearer/basic/header credentials with that request (`src/worker/connectors/http-json/index.ts:172-182, 193-197`).

**Preconditions and impact:** A hostname passes the public-address check but resolves differently for the actual fetch; if the runtime can reach the resulting non-public destination, connector credentials could be sent there. The code-level check/fetch separation is confirmed; whether deployed Workers egress can reach such destinations is **unverified**.

**Countercontrols:** HTTPS/443-only URL checks, direct-IP and private DNS rejection, platform-host denylist, redirect refusal, timeout, and response-size cap (`safe-fetch.ts:151-190, 193-230`).

**Fix:** Ensure the actual outbound destination is the validated public address, or enforce an egress policy that independently blocks non-public destinations.

**Acceptance scenario (not run):** Change resolver answers between validation and dialing; verify the actual transport cannot connect to a non-public address. Confirm deployed account egress controls separately.

### 5. P3 — Published partner docs omit the webhook signing contract

**Partner/lifecycle:** Partner onboarding and first webhook delivery.

The API guide says only that webhooks have their own authentication (`docs/api.md:122-123`); the route’s OpenAPI summary is only “Inbound webhook (signature verified)” (`src/worker/modules/connections/routes.ts:270-274`). The signing details are in implementation comments/source: `v1=<hex>` over `<timestamp>.<body>`, seconds-based timestamp, five-minute replay window, and 256 KiB body limit (`src/worker/connectors/lib/hmac.ts:7-9, 23, 43-65`). The connector-author guide mentions `verifyWebhook` but does not document the partner request format (`docs/extending.md:92-95`).

**Impact:** A partner cannot reliably implement signing, timestamp formatting, retry/deduplication behavior, or size expectations from the published API guide; onboarding and troubleshooting depend on source inspection.

**Fix:** Publish a partner-facing protocol section with exact headers, byte/body signing rules, a working example/test vector, replay and retry semantics, size limits, and event-ID deduplication behavior.

**Acceptance scenario (not run):** A partner following only published docs can generate a valid signed request accepted with 202, and predict the behavior of tampered, stale, duplicate, and oversized requests.

## Yield — Positive controls and evidence boundary

- API-key creation/revocation is admin-only; keys are hashed, expiry/revocation/org status are checked at resolution, and rate limiting is per key (`src/worker/modules/api-keys/routes.ts:15-17`; `service.ts:75-108, 137-143`). Connections are likewise admin-only. Per-org admin roles are outside the stated architecture scope.
- Connector secrets are envelope-encrypted with credential AAD; connection DTOs expose only whether credentials exist (`src/worker/modules/connections/secrets.ts:20-24, 52-57`; `dto.ts:22-24`). Generated webhook secrets are returned on create/rotation, not ordinary reads.
- HMAC verification uses constant-time Web Crypto verification, timestamp checks, body-size caps, and event-ID deduplication. Queue-enqueue failure removes the event record so the sender can retry (`hmac.ts:57-75`; `webhooks.ts:63-91`).
- Mapping is template-validated; manual-owned fields are not overwritten by connection data; holder emails are strictly validated and connection updates do not reassign already-owned passes (`connections/records.ts:155-160`; `passes/connection-passes.ts:51-67`).
- Source/documentation review only. No secrets, `.dev.vars`, production services, or owner-only account controls were examined; Cloudflare DNS/egress behavior and deployed rate-limit behavior remain unverified.
