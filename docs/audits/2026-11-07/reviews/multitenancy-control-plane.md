## Tenant control-plane design

**Assessment:** P1 requirement gap; **confidence 0.99, source-confirmed**. Organization-scoped human administration does not exist today. This is a deliberate v1 architecture decision—not a regression in the unrelated Android patch—but conflicts with the requested tenant-management isolation.

### Established current behavior

- **Human administration is global.** The architecture explicitly excludes per-org administrators (`docs/design/platform-architecture.md:22–24`). Roles are only `admin|user` (`src/shared/contracts/common.ts:60`). Admin guards check that global role; `assertOrgAccess` restricts API keys/scanners, not sessions (`src/worker/platform/auth.ts:133–197`).
- **Existing SQL assumes that global boundary.** Session pass scopes have `orgId:null` (`passes/http.ts:20–32`); pass lookup treats null as unrestricted (`passes/repo.ts:14–19`). Connection detail follows route → service → `requireConnection` → `SELECT * FROM connections WHERE id=?`, without tenant authorization (`connections/routes.ts:43,104–114`; `service-shared.ts:33–36`; `repo.ts:196–198`). Audit tenant filtering is optional (`audit/repo.ts:45`). **Simply admitting org members through existing admin guards would expose global operations.**
- **Machine tenancy exists, but is not workforce RBAC.** Admins create keys with an optional organization; null means platform-wide. Resolution checks scopes, expiry/revocation and active organization (`api-keys/routes.ts:16`; `service.ts:68–74,132–150`). There is no separate service-principal lifecycle.
- **No org-membership/invitation/delegation model was found in migrations or worker authorization.** `scan_staff` has tenant-local `door|desk|manager` PIN identities, not administrative memberships (`migrations/0014_scan.sql:35–48`). Scanner `manager` must not become org administrator.
- **Platform elevation is standing authority.** OIDC groups issue global admin sessions (`auth/service.ts:59–68`). Session roles remain snapshots; ordinary admin sessions last up to 12 hours. Breakglass uses one fixed account and grants global admin for up to four hours (`auth/sessions.ts:20–25,79–95`; `auth/service.ts:184–209`).

Worker module paths above and below are under `src/worker/modules/`.

### Preserve the intentional customer union

`/api/v1/me` derives the customer from the session; portfolio SQL selects `owner_user_id=userId` without an org restriction (`me/routes.ts:43–58`; `me/repo.ts:31–49`). Attachment checks verified addresses in `user_emails`, and waiting-pass attachment crosses organizations (`holders/repo.ts:143–149,195–209`).

**Keep this separate from management authorization:**

- A customer needs no org membership to access their own passes.
- Managing Org A does not permit inspecting that customer’s Org B passes, aliases, sessions or identity-provider claims.
- Removing a management membership must not remove the person’s customer portfolio.

Current `/users` administration exposes global emails, identities, sessions and cross-org passes (`users/service.ts:80–133`). Do not expose that projection to tenant managers. Provide tenant-holder views containing only authorized tenant relationships and contact information.

## Proposed target model

### Minimum viable authority

1. **Global account:** authenticates a person and owns their customer portfolio. It conveys no tenant-management authority.
2. **Organization membership:** unique `(org_id,user_id)`, active/revoked state, role `administrator|operator`, optional expiry, grantor and audit history. Evaluate current membership on requests—not informational `last_roles` or an indefinite session snapshot.
3. **Service principal:** organization-owned, noninteractive identity with immutable tenant scope. API keys are credentials attached to it, allowing rotation without losing attribution. Effective permissions are explicit scopes intersected with principal grants and key mode. Tenant administrators cannot create platform-wide principals.
4. **Platform eligibility:** separate from active elevation. Neither an IdP group nor normal platform operations access automatically authorizes tenant data access.

**Invariant:** management access requires an active grant for the selected organization and action. Missing tenant context fails closed; request filters are never authority. Enforce this through routes, services, repository predicates, related-resource validation, DTOs, assets, history, metrics and background consumers.

Global templates/signing services may remain explicitly shared **read/use** resources. Sharing must not confer mutation rights or reveal other tenants’ usage.

### Policy matrix

All operator/administrator permissions below apply only to their authorized tenant.

| Domain/action | Customer | Operator | Org administrator | Platform |
|---|---|---|---|---|
| Create organization; global suspension/deletion | None | None | Request provisioning/closure | Explicit provisioning/lifecycle authority |
| Configure organization | None | Read operational details | Branding, support, own defaults | Scoped elevation; global settings separately |
| Passes and holders | Own portfolio operations | Issue, view, update, assign, refresh, void | Same; destructive/bulk administration | Scoped elevation |
| Connections/source records | Own-pass refresh only | Run approved connections; operational status | Create/configure/test; rotate tenant credentials; inspect tenant source data | Scoped elevation |
| Templates | Render own passes | Read/use approved versions | Create/clone/edit/activate tenant templates | Shared publication or scoped elevation |
| Signing identities | Use through own passes | Use approved identities | Upload/renew own signer; choose allowed org default | Shared identities, deployment bindings/global defaults |
| Staff and API credentials | Own account only | Use assigned scanner permissions | Invite/offboard members; manage tenant scanner staff and service principals | Recovery through scoped elevation |
| Support/history | Own permitted history | Tenant pass activity | Tenant audit and support configuration | Time-bounded support grant; global account recovery separate |

Service principals receive only explicitly granted machine actions; they cannot inherit administrator authority. Secrets remain non-readable after initial submission/creation.

### Partners and agencies

“Partner” describes affiliation, not privilege. Invite a named person into a specific tenant/role using an expiring, single-use invitation accepted through a proven address. Acceptance must not manufacture global email verification or transfer pass ownership.

**MVP agency support:** independent memberships per client tenant. One person may switch between A and B, but no “all clients” wildcard follows their employer or email domain.

If organization-to-organization delegation becomes necessary, require client-approved subjects, permission ceilings, resource scope, expiry and immediate client revocation. Do not infer hierarchy, ownership or billing relationships.

### JIT platform administration and breakglass

Use named, short-lived elevation grants containing tenant, capabilities, expiry, reason/ticket and approver. Require verified step-up authentication; normal support elevation should be read-only. Record the real operator and grant—not impersonated customer identity.

Replace standing breakglass administration with an independently secured emergency activation path issuing a short lease, with immediate notification, revocation and post-use review.

**Important shared-resource exception:** APNs keys are currently unique by Apple team, not organization (`migrations/0012_identities.sql:3–14`). Updating one identity’s push key replaces that team’s key; delivery loads it by team (`identities/push-key-service.ts:44–78`; `delivery/apns.ts:111–116`). Keep these keys platform-managed until tenant-specific credential routing and provider authority are established.

## Migration and adoption

1. Inventory tenants, approved managers, integrations and shared resources. Do not infer membership from pass creation history, account domains or resource `created_by`.
2. Introduce memberships, invitations, service principals and elevation grants. Retrofit the complete authorization chain before enabling tenant managers. Update principal consumers, session contracts, console navigation and capability controls together; current UI routing recognizes only global `admin` (`src/web/lib/session.ts:17–18`; `src/shared/next.ts:34–35`).
3. Seed explicitly approved administrators; review/replace null-org keys. Revoke legacy global-admin session authority at cutover—do not retain a wildcard compatibility fallback.
4. Preserve customer ownership, issued-pass identifiers and existing signing relationships. Shared-template activation and signer changes have cross-tenant blast-radius implications; tenant managers must not mutate shared resources.
5. Gate external adoption on isolation acceptance and update the architecture’s v1 non-goal.

Previously audited failures remain source-visible and should gate adoption: test-pass live-connection access (`passes/create.ts:71–76`; `connections/jobs.ts:28–67`), cached template tenancy (`templates/registry.ts:112–137`; `passes/builder.ts:97–103`), global owner-email enrichment (`passes/detail.ts:158–175`; `passes/repo.ts:68–75`) and suspended-org holder bundles (`me/repo.ts:79–94`, unlike `public/service.ts:33–38`).

## Acceptance matrix — proposed, not exercised

| Scenario | Required outcome |
|---|---|
| A-manager supplies B IDs, filters or related resources | No B reads, mutations, counts, history, source data or credentials |
| Same verified customer owns A/B passes | Portfolio contains both; A-management reveals only A |
| Invite replay, wrong mailbox, revoked membership/delegation | No grant; next management request denied |
| Tenant service key changes tenant, mode or scope | Denied; test mode never fetches live connector data |
| Platform eligibility without valid lease; expired/revoked lease | Tenant access denied; elevated actions identify operator/grant |
| Shared-template reassignment, shared signer/key mutation, suspension | No stale authorization, foreign mutation or delivery-gate bypass |

**Unknowns:** legal ownership, billing hierarchy, self-service provisioning, agency contracts, retention obligations, Apple-team authority and production MFA capabilities. These require owner decisions, not inferred schema semantics.

**Limitations:** read-only source review; no edits, tests, builds, production access or secret reads. Runtime isolation and deployment configuration were not verified.
