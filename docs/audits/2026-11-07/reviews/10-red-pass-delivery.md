# RED TEAM 2 — Pass exfiltration and lifecycle audit

## Yield — Boundaries

Read-only review of `src/worker/modules/{passes,holders,delivery,apple,public,bundles,broadcasts,connections}`, associated jobs/workflows, migrations, and PassKit build/signing integration. Paths below are relative to `/Users/vlad/Repos/wallet`.

No edits, network calls, payload execution, builds, tests, lint, or formatters were performed. Acceptance checks below are proposed, not exercised.

## Yield — Findings

### 1. P1 — Queued email survives recipient correction and receives fresh credentials
**Confidence: confirmed-source**

`src/worker/modules/delivery/service.ts:123-137` queues `{to, attach}`. The consumer combines that saved recipient with the **current** pass (`delivery/email.ts:38-39`), current download token (`:72-73`), and current attachment (`:112-123`).

Reassignment changes only holder email/owner (`holders/repo.ts:234`); link rotation changes the token and increments an otherwise-unused generation (`passes/repo.ts:140`). Neither invalidates queued mail.

**Affected flow:** An unsent/retrying message to old or mistyped recipient A remains pending while an administrator corrects ownership to B, rotates the link, and updates sensitive content. Delivery then gives A the fresh capability and potentially B’s attachment. Bundle delivery similarly reloads the current token (`bundles/deliver.ts:29-42`).

**Counter-controls:** Missing/deleted passes and inactive organizations cancel delivery; leases, caps, and provider IDs do not validate recipient intent.

**Fix:** Bind queued intent to recipient/link generations; cancel obsolete intent rather than upgrading it to current credentials.

**Acceptance:** Delay first delivery and retry delivery across reassignment plus rotation; neither may send A the replacement link/content.

### 2. P1 — Test keys can obtain live connector records through test passes
**Confidence: confirmed-source**

`passes/routes-write.ts:56-60` accepts connection bindings while retaining the creator’s test mode. Creation checks only connection organization (`passes/create.ts:71-83`).

Refresh uses that connection’s authenticated upstream fetch without checking pass mode (`connections/jobs.ts:26-29,61-66`). Record selectors also omit mode (`connections/repo-passes.ts:49,67,95`), and `passes/connection-passes.ts:44-56` publishes mapped live data into the selected pass.

**Abuse:** A test-scoped key with `passes:write`, a known same-organization connection UUID, valid template, and unused upstream reference can bind its test pass, refresh it, and retrieve live personalization through its pass capability or mutation response. No live key or upstream credential is required.

**Counter-controls:** Tenant checks prevent crossing organizations. The unique connection/reference index blocks shadowing an already-bound reference (`migrations/0001_platform.sql:322-323`), not unissued records.

**Fix:** Reject live-connection bindings/refreshes for test passes, or introduce separately scoped test connectors; enforce mode in system selectors.

**Acceptance:** Test-key binding/refresh must produce no live upstream fetch or live data in test output.

### 3. P2 — Queued webhooks acquire newer configuration authority
**Confidence: confirmed-source**

Webhook jobs retain connection/event/reference identifiers, but no intake generation (`connections/webhooks.ts:80-84`; `src/worker/jobs/types.ts:14-18`). Processing reloads the connection and adopts its **current** generation/configuration (`connections/webhooks.ts:100-112,122-131`).

This defeats the stated invalidation contract for configuration, mapping, template, auto-create, and auto-email changes (`connections/service-shared.ts:16-27`; `service-update.ts:126-127`).

**Affected flow:** Accept an embedded record while auto-create is disabled; delay processing; enable auto-create/auto-email or change its template/mapping. The old record can now issue and email a live pass under the newer configuration (`connections/records.ts:172-182`). Secret rotation also leaves queued intent untouched (`connections/actions.ts:128-131`).

**Counter-controls:** Intake verifies HMAC/timestamp and deduplicates events; processing checks enabled organization/connection. Those checks do not preserve the original configuration authority.

**Fix:** Persist and enforce intake generation; invalidate it on credential/mode revocation.

**Acceptance:** Process queued events after fenced configuration changes or secret rotation; stale events must cause zero issuance, updates, revocations, or email.

### 4. P2 — Versionless lifecycle mutations escape publish CAS
**Confidence: inference; source-grounded interleaving, unexecuted**

Publish CAS checks only ID/version (`passes/repo-write.ts:142,199`). Binding changes (`:228-229`) and soft deletion (`passes/repo-ops.ts:169-170`) do not increment that version.

**Concrete interleaving:** Start unvoiding an already-voided pass and pause before CAS. Delete it: deletion skips publishing because it was voided (`passes/service.ts:158-177`). Resume unvoiding: the unchanged version permits an active package to commit into the deleted row.

Apple lookup intentionally includes deleted rows (`passes/repo.ts:34-43`), and authorization checks its token/organization rather than deletion status (`apple/service.ts:50-57`). Consequently, a subsequent Apple fetch can receive the active package despite completed deletion. Connection updates have an analogous stale-binding window after their one-time checks (`passes/connection-passes.ts:35-44`).

**Fix:** Make lifecycle/binding transitions participate in the publication fence and require valid lifecycle state at commit.

**Acceptance:** Deterministically interleave these operations; deletion must retain a voided package, and detached sources must not publish.

### 5. P2 — Predictable serials permit first-writer personalization takeover
**Confidence: confirmed-source; conditional, previously documented**

Caller-chosen serials remain accepted—even one character (`src/shared/contracts/passes.ts:182-185`; `passes/create.ts:85`). Personalization relies on pass type plus serial, without ApplePass authorization, then permanently accepts the first token (`apple/personalize.ts:83-109,116-124`).

**Impact:** For an NFC-enabled, personalizable pass with a guessable serial, an anonymous attacker can preempt enrollment, store attacker-supplied information, and make the legitimate token fail.

**Counter-controls:** Random default serials, NFC-enabled identity gating, personalization-template gating, and rate limits substantially constrain exposure. JSON-shaped signing tokens are rejected (`apple/personalize.ts:26-33`), so forged-pass signing was rejected as a candidate.

**Fix:** Enforce unpredictable serials for this flow. This is already an enablement restriction in `docs/security.md:17,68`.

**Acceptance:** Predictable custom serial issuance must fail for personalizable NFC passes; legitimate enrollment must remain functional.

## Yield — Strengths, recommendations, and limits

- Ordinary by-ID API-key access enforces tenant/mode boundaries. Template and signing-identity resolution enforce tenant ownership.
- Public capabilities use strong randomness; public pages suppress referrers and caching. APNs tokens are registration-scoped.
- Signing checks certificate validity, identity/key correspondence, asset paths, and overwrites server-owned pass fields.

**Product/security recommendation, not an additional finding:** Reassignment currently transfers portal ownership, not existing bearer/installed-pass access (`holders/repo.ts:234`; `apple/service.ts:52`). If “transfer” must exclude the previous holder from future content, retire the old pass and issue new credentials/serial.

NFC entitlement, deployed configuration, delivery timing, and Apple/device behavior remain unverified. The repository’s primary protocol reference is [Apple Pass Personalization](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/PassPersonalization.html), not re-fetched here. iOS worktree behavior was outside this slice. Urgent disclosure chains were sent to Main; lifecycle overlap was coordinated with CodeBackend.
