## Yield 1 — Findings and reviewed paths

**New findings: `[]`.** I found no new externally reachable cross-organization authorization bypass in the principal boundaries reviewed. The main audit already records the actionable defects that intersect this scope; I cross-reference them below rather than duplicate them.

Reviewed session and role resolution, API-key scopes and org binding, holder ownership and email linking, org/user/connection/identity route guards, scanner/device/staff authorization, and public-pass, Apple Wallet, and webhook entry points. Relevant sources include `src/worker/platform/auth.ts`, `modules/auth`, `api-keys`, `me`, `holders`, `orgs`, `users`, `connections`, `identities`, and `scan`; migrations `0001_platform.sql`, `0014_scan.sql`, `0023_scan_setups.sql`, and `0024_scanning_sessions.sql`; and the prior audit reports cited below. Source review only; no tests, builds, network calls, or production access.

## Yield 2 — Current principals and target gap

### Platform administration — deliberate v1 tradeoff; target mismatch

OIDC groups map to only `admin` and `user` (`auth/service.ts:60–68`); an admin session receives both roles. Break-glass also creates an `admin,user` session (`auth/service.ts:184–209`). Session roles are stored and later read from the session row (`auth/repo-sessions.ts:54`, `auth/sessions.ts:83–85`).

`requireAdmin` checks only for the global `admin` role (`platform/auth.ts:130–138`). Representative org, user, and connection routers all use it (`orgs/routes.ts:26–27`, `users/routes.ts:27–28`, `connections/routes.ts:42–43`). In pass helpers, session scope is unrestricted (`passes/http.ts:20–37`); `assertOrgAccess` restricts org-bound keys and scanners, not sessions (`platform/auth.ts:190–197`). Thus every current admin can manage every organization. Org filters and IDs are not an admin tenant boundary.

This is **not a newly found v1 vulnerability**: `docs/design/platform-architecture.md:22–24` explicitly excludes per-org RBAC. But it is a **high-confidence gap against the requested strict-isolation target**. A stolen or shared admin account has platform-wide impact; no tenant-admin role exists today. Admin roles are session snapshots, so IdP group removal alone does not revoke an existing session; see the prior report’s session-lifetime tradeoff.

**Target:** Keep platform-owner/platform-operator authority distinct from organization memberships, such as `(user_id, org_id, role, status)`. Check action, resource org, membership, and active status server-side on every request and background operation. Never treat an `orgId` query/body value as authorization. Revoke or version-check memberships so role removal takes effect promptly. A person in several organizations may have explicit memberships in each; that does not grant all-org access.

### API keys and shared platform resources

Keys have explicit scopes (`passes:read/write`, `holders:write`, `templates:read`, `messages:write`, `scans:read`; `shared/contracts/common.ts:52–59`) and a mode. Org-bound keys are checked against target orgs; list and by-ID pass helpers carry their org scope (`platform/auth.ts:190–197`, `passes/http.ts:20–37`). Key resolution also checks revocation, expiry, org status, and rate limits (`api-keys/service.ts`).

However, `CreateApiKeySchema.orgId` is optional and nullable (`shared/contracts/api-keys.ts:37–41`), and omitted org IDs become `null` (`api-keys/service.ts:67–69`). A null-org key is platform-wide, though still limited to its scopes; key creation itself requires global admin. That is intentional for v1, not an org-key bypass. It must not become an accidental tenant-admin capability.

Null org scope also has deliberate uses: signing identities and credentials permit `org_id IS NULL` (`migrations/0001_platform.sql:130–133`), and `identityUsableBy` permits a global identity or one belonging to the selected org (`orgs/repo.ts:115–127`). Baked/shared templates are likewise platform-scoped. Treat these as explicit platform-shared resources—not as tenant-owned records with missing ownership.

**Target:** Org service principals should be org-bound by default, with action-specific and, where required, resource/template limits. Reserve global keys and shared signer/template administration for explicit platform principals. Preserve shared resources only through a documented platform-sharing policy. No foreign-org bypass was established for the org-bound key paths reviewed.

### Customer account — intentional cross-org exception, not organization authority

`/api/v1/me/*` requires a session, and pass queries filter by `owner_user_id` without an org predicate (`me/routes.ts`, `me/repo.ts:43–49`). Verified-email linking attaches waiting passes by that address across organizations (`holders/repo.ts:203–206`, `auth/service.ts:142–143`). This is the intended customer union: one verified account can see its own passes from multiple issuers. It gives no org-management permission and must remain separate from memberships.

The current identity boundary is global email proof: `user_emails.email` maps to a user, and a matching verified address can attach issuer-assigned passes. That can also pool passes addressed to a household, shared agency inbox, or reassigned mailbox. Whether those are valid “same customer” cases is an **owner/legal/product decision**, not a demonstrated tenant-admin bypass. Preserve cross-org customer aggregation, but require the customer-account proof/consent model to be explicit; never use that account or its email aliases to grant org administration.

Migration should also reconcile duplicate addresses across `users.primary_email` and another user’s `user_emails`: the two tables’ uniqueness constraints do not enforce cross-table uniqueness, and the admin email-add route writes the latter. I did not establish an unauthenticated exploit from this condition. Do not treat an unverified OIDC primary address as proof; the already-reported OIDC finding is directly relevant.

### Scanner, staff, and capability principals

Scanner credentials are a distinct principal with fixed org and mode; `requireScanActor` validates org activity, device role, and scanner/staff scope (`scan/guard.ts:49–50, 95–125`). Scanner and staff rows carry org IDs (`migrations/0014_scan.sql:35–54`); staff PIN checks require a same-org staff row, and terminal roles are capped at Door/Desk (`scan/approval.ts`, `scan/staff-pin.ts`, `shared/contracts/scan.ts:94–97`). Customer/monitor screens have separate route allowances. Admin scanning is an explicit exception: an admin selects a scope and acts as Manager. It is still platform-wide today.

The staff authorization helpers are not a complete operational principal: `/api/v1/scan-staff` is an empty router (`scan/routes-staff.ts:3–4`), and staff sign-in/roster flows remain absent. This is already noted in `reviews/12-blue-scanner-native.md`; do not infer end-to-end staff controls from helper tests.

Public pass links and Apple Wallet `ApplePass` tokens are bearer capabilities for pass delivery; inbound connection webhooks have a separate signature-verified route. Keep them narrow to one pass or connection, not interchangeable with a human, org member, or API-key role.

## Yield 3 — Existing findings, tests, and migration risks

Cross-reference rather than repeat: `reviews/09-red-auth-tenant.md` #1 (unproven OIDC email/account hijack), #2 (tenant-key response exposes global account email), and #3 (holder bundle bypasses org suspension); `reviews/07-code-backend.md` stale template-org metadata cache; `reviews/10-red-pass-delivery.md` test-key/live-connector data; and `reviews/12-blue-scanner-native.md` scanner response/privacy, monitor-role promotion, historical mode leakage, and missing staff flows. These are distinct existing defects, not proof that every tenant-scoped path is broken.

**Acceptance matrix for the target (proposed, not run):**
- Org A member/key may read and mutate A resources only; exercise list, by-ID, bulk, config, identity, history, issuance, and source/integration routes using B IDs and B query/body orgs.
- Org key is limited to its org, mode, and scopes; only a designated platform principal can create/use a global key. Test rotation, creator offboarding, expiry, and org suspension.
- A verified customer account sees its own A+B passes; another account sees neither. Test alias verification/removal, pass reassignment, shared-email policy, and that org administrators cannot edit global customer identities.
- Scanner A cannot resolve B passes/events/assets/history in either mode; screen credentials remain read-only after metadata updates. Test admin scan as an explicitly authorized org member.
- Public/Apple tokens and webhook credentials grant only their single pass/connection; revocation and inactive-org behavior fail closed.

**Migration/compatibility:** Backfill org memberships from an owner-approved roster; do not silently convert every global admin into an admin of every org. Inventory null-org API keys, identities, credentials, and templates and assign explicit platform-shared ownership before tightening schemas. Preserve `owner_user_id` as the customer-account cross-org union; do not migrate it into org membership. Reconcile unverified OIDC identities, duplicate email states, agency/shared-mailbox policy, and existing scanner credentials without broadening staff or device roles.

Production IdP claims, intended agency/legal account semantics, and deployed configuration remain unverified.
