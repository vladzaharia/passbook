# RED TEAM 1 — Authentication and Tenant Isolation

## Inspected boundaries

Read-only source review of `/Users/vlad/Repos/wallet`. Paths below are relative to that worktree.

Reviewed `src/worker/app.ts`, production store wiring, platform authentication/CSRF/security headers/host policy, and modules `auth`, `api-keys`, `me`, `users`, `orgs`, and `public`. Followed relevant holder attachment, pass-detail/download, SSR escaping, schemas, and test-source paths.

## Findings

### 1. P1 — Unproven OIDC email enables pre-account hijacking

**Confidence: confirmed-source; deployment exploitability conditional.**

**Evidence:** `src/worker/modules/auth/oidc-sign-in.ts:76–100` creates an account and links the OIDC subject when no email owner exists—even without trusted email. Later, `src/worker/modules/auth/service.ts:132–143` resolves magic-link login through `primary_email`, verifies that address on the same account, and attaches its waiting passes.

**Execution path:** An attacker needs an eligible OIDC identity whose email claim can name the victim. Before the victim has an account, the attacker signs in with that claim. The victim subsequently proves mailbox ownership through legitimate email sign-in, joining the attacker’s already-linked account. The attacker’s existing session and OIDC identity retain access to newly attached passes, downloads, and account/session controls.

Public email sign-in additionally requires a known address, such as a waiting pass (`auth/magic-service.ts:97`). Victim OIDC email-proof linking provides another convergence path.

**Counter-controls:** Existing accounts require browser-bound email proof; unproven claims do not immediately attach passes. Neither prevents this reversed registration order. Mailbox proof grants only `user`, not admin.

**Fix:** Keep unproven claims outside canonical email ownership/account merging. Require proof before permanently linking the subject to an email-based account; do not merge into an identity-bearing account merely because its unverified primary address matches.

**Acceptance:** Register attacker subject A with victim email E and no verified-email row. Complete legitimate victim proof for E. Neither A’s existing session nor a fresh A login may access the victim’s passes or account controls.

**Missing prerequisite evidence:** Whether production Pocket ID permits an attacker with an eligible group to supply another person’s email claim was not established.

### 2. P2 — Org-scoped pass access exposes global account email

**Confidence: confirmed-source disclosure.**

**Evidence:**
- `src/worker/modules/passes/routes.ts:43–45,91–93` accepts `passes:read` keys and returns the shared detail response.
- `src/worker/modules/passes/detail.ts:158–175` enriches that response with `ownerEmail`.
- `src/worker/modules/passes/repo.ts:68–75` obtains it from global `users.primary_email`, not the organization’s `holder_email`.

**Execution path:** A tenant integration reading its own pass can discover the holder’s unrelated primary account address when that pass was assigned through a verified secondary alias. No foreign-pass IDOR is necessary.

An integration capable of creating passes can also supply an alias: `passes/routes-write.ts:43–54` accepts `holderEmail`; `passes/create.ts:154,201–206` attaches the verified owner and returns enriched detail. This exposes alias-to-account relationships without the holder interacting with that organization.

**Counter-controls:** Pass lookup remains org/mode scoped. Direct users administration is admin-only (`users/routes.ts:29–30`). The defect is field-level exposure through another permitted object, not unrestricted user lookup.

**Fix:** Restrict global account enrichment to platform-admin responses. Tenant-key responses should expose the organization’s assigned holder address, not an otherwise unrelated primary email.

**Acceptance:** Give a holder a private primary address and a verified tenant-specific alias. Assign a tenant pass through the alias. Tenant read/create responses must not reveal the private primary address; platform-admin behavior can remain explicitly privileged.

### 3. P2 — Holder bundle download bypasses organization suspension/deletion

**Confidence: confirmed-source.**

**Evidence:** `src/worker/modules/me/repo.ts:79–94` selects bundle objects using ownership, active pass status, and absence of registrations—without checking organization status. `me/service.ts:250–264` packages those R2 objects directly.

Conversely, `src/worker/modules/public/service.ts:33–38` rejects inactive organizations. Organization deletion only marks its status (`orgs/repo.ts:107–111`); it does not revoke these owned passes.

**Execution path:** A signed-in holder with an active, not-yet-registered pass can download it through `/api/v1/me/passes.pkpasses` after its organization is suspended or deleted, although its public download is refused.

**Counter-controls:** The route requires a session and selects only that holder’s passes. Already registered passes are excluded. Ordinary pass soft-deletion clears ownership (`passes/repo-ops.ts:163–170`), so that separate deletion path does not establish this bypass.

**Fix:** Apply the same organization-active delivery gate to bundle selection/counting. Decide separately whether historical metadata remains visible.

**Acceptance:** Suspend and then delete an organization containing an owned, unregistered active pass. Public and holder-bundle downloads must both exclude it; unrelated active-org passes must remain downloadable. This does not retroactively remove previously installed Wallet passes.

## Strengths and useful negative evidence

- Session/admin guards distinguish holders from administrators; bearer requests require explicit scopes (`platform/auth.ts:124–197`).
- Cookie mutations require same-origin plus a session CSRF secret; machine bearer authentication is exempt (`platform/csrf.ts:12–39`).
- Session resolution checks revocation, user status, idle expiry, and absolute expiry (`auth/sessions.ts:79–84`). Magic login does not reuse informational `last_roles`.
- OIDC uses browser-bound, single-use state, PKCE, nonce, issuer/audience/signature checks. Existing-account email-proof consumption is browser-bound.
- Public capabilities are deliberately possession-based. Reviewed responses apply referrer protections; request logging uses route patterns and capability redaction.
- Reviewed auth/public rendering escapes interpolated text. Rich pass markup becomes sanitized data rendered through React; no surviving XSS path was identified in these inspected sinks.

## Product recommendation—not an additional bug

OIDC roles are session snapshots: removing an IdP group does not immediately revoke existing admin sessions, which can remain active for up to 12 hours (`auth/sessions.ts:24,83`). This matches the documented design. If immediate offboarding is required, connect it to local disable/session revocation rather than treating IdP group removal alone as immediate enforcement.

## Coverage and limitations

Three findings survived source tracing. No edits, payload execution, network requests, production access, builds, tests, linters, or formatters were performed. Acceptance scenarios above are proposed checks, not exercised results. Production IdP policy, deployed headers/configuration, and runtime outcomes remain unverified. Semantic search was unavailable; review continued through targeted file, literal, and schema inspection.
