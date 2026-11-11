# Cloudflare operations, deployment and security audit

## Scope and verdict

Inspected `wrangler.jsonc`, deployment/provisioning guards, GitHub workflows, operations/security documentation, Worker routing/cache policy, logging, status probes, secrets handling and Email Sending integration.

**Four source-confirmed operational defects merit correction.** No P0 was established in this slice. Account-level controls and production behavior remain unverified.

## Findings

### 1. P2 — Allow deployment overrides through the npm pre-hook
**Confidence: confirmed-source**

`package.json:34-35` defines both `predeploy` and `deploy`. npm automatically executes the former without arguments appended to the latter, while `tools/deploy.ts:16-22` expects `--allow-no-push` and `--allow-no-oidc` to reach its guard. Consequently, a supported bootstrap command such as `npm run deploy -- --allow-no-push` is rejected by the unflagged pre-hook before its override executes. Normal deployment with the current bindings is unaffected.

**Fix:** Use one guard invocation that receives the requested mode, updating scripts, CI and documentation consistently.

**Acceptance:** Against isolated configuration fixtures, flagged deployment prints its plan without APNs; unflagged deployment still refuses. [npm documents this argument behavior](https://docs.npmjs.com/cli/v10/commands/npm-run-script?v=true).

### 2. P2 — Reconcile break-glass shutdown with required-secret validation
**Confidence: confirmed-source**

`docs/security.md:55` and `:70` instruct operators to delete `BREAKGLASS_TOKEN_SHA256`, but `wrangler.jsonc:65-70` makes it required. [Wrangler rejects deployments missing required secrets](https://developers.cloudflare.com/workers/configuration/secrets/). Following that shutdown procedure therefore blocks later releases. Additionally, `tools/deploy.ts:56-57` applies migrations before Wrangler performs the final deployment validation.

**Counter-control:** `docs/operations.md:175-176` already documents the compatible disabled value, `off`; the runtime returns 404 for malformed hashes.

**Fix:** Consistently document `off`, or deliberately make the secret optional. Check required remote secret names before applying migrations.

**Acceptance:** The documented disabled configuration remains deployable and returns 404; missing required secrets stop deployment before migrations.

### 3. P2 — Retain terminal delivery failures in Status
**Confidence: confirmed-source**

Status degrades only while the DLQ currently contains messages (`src/worker/modules/status/checks.ts:80-89`). However, the configured DLQ consumer immediately finalizes and acknowledges them (`src/worker/jobs/queue.ts:31-36`). Once drained, queue health becomes verified despite permanently failed deliveries. This undermines the runbook’s assertion that dead letters appear on Status (`docs/operations.md:207`).

**Counter-control:** Failed outbox rows, error logs and audit events remain available (`src/worker/modules/delivery/jobs.ts:48-57`).

**Fix:** Include recent persisted terminal delivery failures in health reporting, rather than relying exclusively on current queue depth.

**Acceptance:** Exhaust a delivery in isolation, consume its dead letter, and confirm Status still reports the failure after DLQ depth reaches zero.

### 4. P2 — Probe encryption readiness instead of relying on build metadata
**Confidence: confirmed-source**

`docs/security.md:25-28` identifies build/probe errors as the KEK failure signal, but `checkBuild` verifies only `CF_VERSION.id` (`src/worker/modules/status/checks.ts:241-249`). Status performs no direct KEK validation. A present but malformed KEK passes required-secret presence checks while connector credential operations fail (`src/worker/modules/connections/secrets.ts:19-24`) and scanner PIN processing throws (`src/worker/modules/scan/staff-pin.ts:18-20`; `src/worker/platform/crypto.ts:162-164`).

**Counter-control:** Daily DB-identity checks provide partial detection, but do not establish general encryption readiness.

**Fix:** Add a bounded, value-redacting KEK readiness component using existing validation.

**Acceptance:** With otherwise valid configuration, an invalid-length KEK makes fresh Status explicitly failing without exposing its value.

## Recovery design gap — P1 recommendation, not an account-level finding

**Confidence: confirmed-source for repository behavior; account recovery coverage is unknown.**

The documented recovery procedure restores D1 (`docs/operations.md:197-199`), while photo replacement immediately deletes old R2 bytes (`src/worker/modules/passes/member-photo.ts:78-80,123`). Daily retention also deletes pass-version objects (`src/worker/modules/passes/jobs.ts:24-28`). Rewinding D1 across those operations can resurrect references to objects that no longer exist.

**Recommendation:** Define coordinated D1/R2 recovery, preservation windows, writer/consumer quiescence, and offline key availability. Do not treat a bookmark as a complete platform backup. [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) covers D1 only, with 30-day Paid or seven-day Free history.

**Acceptance:** In isolation, bookmark D1, replace a photo and purge a version, execute the documented recovery, then verify every restored reference resolves. External backups may already mitigate this; none were inspected.

## Platform assessment and recommendations

- **Assets, performance and costs:** `wrangler.jsonc:27-43` deliberately runs hashed `/assets/*` through the Worker. Browser caching does not eliminate billable Worker invocations; [direct asset requests are free](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). This is an intentional host-policy trade-off, not a bug. Preserve scanner gating when considering exclusions. The 10-second CPU cap (`:153-154`) bounds individual execution, not total spending. Binding rate limits are [approximate and per location](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), not global budgets.

- **WAF, Access and Turnstile:** Turnstile fails closed with a timeout; predeploy rejects test site keys. Actual widget hostnames, WAF rules and Access policies require owner evidence. Protect break-glass narrowly: blanket Access would affect public Wallet/hooks/holder flows. [Worker-level Access currently rejects WebSockets](https://developers.cloudflare.com/workers/configuration/cloudflare-access/); hostname-based policies are the appropriate alternative. [WAF capabilities vary by plan](https://developers.cloudflare.com/waf/).

- **Observability:** Invocation logs are disabled; application logs use route patterns, redaction and 5% successful-request sampling (`wrangler.jsonc:152`; `src/worker/platform/context.ts:46-47,66-70`). These are useful privacy/cost controls. Establish alerting and required retention explicitly; [Workers Logs retention](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) is limited. Review enriched metadata before enabling broader tracing/export.

- **Secrets and residency:** Existing Worker secrets plus envelope encryption are legitimate controls; absence of Secrets Store is not itself a vulnerability. [Secrets Store is a separate, asynchronous integration](https://developers.cloudflare.com/secrets-store/integrations/workers/), not a drop-in string binding. Provisioning specifies no jurisdiction (`tools/lib/provision.ts:56,68`). [D1](https://developers.cloudflare.com/d1/configuration/data-location/) and [R2](https://developers.cloudflare.com/r2/reference/data-location/) jurisdiction constraints are creation-time decisions; location hints are not residency guarantees.

- **Email:** Sender restriction and application caps exist. Documentation records domain onboarding, but that is not current account verification. [Account quotas, suppressions and sender onboarding](https://developers.cloudflare.com/email-service/platform/limits/) still constrain delivery. Verify an external-recipient delivery and rejection scenario; binding presence alone is not mail health.

## Strengths and limitations

CI uses pinned actions, read-only permissions and production dependency auditing (`.github/workflows/ci.yml:7-29`). Deployment requires explicit application and records a D1 bookmark. Sensitive pages use private/no-store policies; generated image URLs are cache-busted.

No edits, builds, tests, production calls or secret-value reads were performed. WAF/Access enforcement, billing alerts, actual regions, deployed logs, quotas and off-platform backups remain missing evidence.
