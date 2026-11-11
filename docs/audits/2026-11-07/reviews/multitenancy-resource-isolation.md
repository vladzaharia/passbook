# Tenant resource isolation audit

## Scope and boundary

Source review only; no edits, builds, tests, network, account/production access or secret reads. The cross-isolate cache and lifecycle acceptance scenarios below were not executed. Human admin is platform-global by explicit v1 design and has no org-membership table; that is a target gap, not an accidental foreign-org bypass in the org-key paths reviewed.

## Findings

### P1 — Warm template cache can authorize against stale organization ownership

`CompositeTemplateRegistry.resolve` caches template/version data including mutable `orgId` (`src/worker/modules/templates/registry.ts:123-127`). Assignment updates D1 and invalidates only the handling isolate (`org-assignment.ts:33-34`). Pass creation authorizes via resolved `template.orgId` (`passes/builder.ts:89-90`). A second isolate with cached platform ownership can therefore allow an Org B `passes:write` key to issue from a template reassigned privately to Org A. Cross-isolate execution was not reproduced; this re-confirms `reviews/07-code-backend.md`.

**Acceptance:** Warm B’s cache, reassign template to A in another isolate, then prove B cannot create through either resolution path while A can. Do not cache mutable ownership metadata or recheck authoritative ownership before authorization.

### P1 — Test-mode pass can consume live connector data

A test API key can create/bind a test pass to a same-org live connection. Binding checks org but not mode; refresh and scheduled selection likewise lack pass-mode exclusion (`passes/routes.ts`, `connections/jobs.ts`, `repo-passes.ts`). Source updates can be written to the test pass and exposed to the key. This is same-org mode leakage, not an org-ID bypass; it re-confirms `10-red-pass-delivery.md` and `11-blue-platform.md`.

**Acceptance:** Test creation/binding/refresh/scheduled/webhook paths never read or copy live source values. Reject test/live binding or require explicit test source, and enforce mode at every selector and mutation.

### P2 — Tenant pass detail reveals global account email

`passes:read` scoped to Org A returns `ownerEmail` from `users.primary_email`; blocked-user and void-actor fallbacks can do the same (`passes/detail.ts`, `passes/repo.ts`, `repo-devices.ts`). A tenant can correlate its assigned/verified alias with a person’s private global identity. This re-confirms and extends the prior ownerEmail finding.

**Acceptance:** Tenant DTOs expose only tenant-assigned contact data; keep global identity enrichment platform-admin-only. Test private primary + tenant alias, blocked-user and actor fallback paths.

### P2 — Shared-template counts disclose other tenants’ usage

Org keys with `templates:read` can access platform-shared template metadata. `passCount`, per-version counts, `passesOnOlderVersions` and `passesBlocked` aggregate without org filtering. Shared template content may be intentionally global; tenant usage/history was not established as public.

**Acceptance:** Tenant keys see own-org counts only or no counts. Platform admins may receive explicit global aggregates. Seed Org A/B passes against one shared template and test list/detail counts in both modes.

### P2 — Holder bundle bypasses org suspension/deletion gate

`/api/v1/me/passes.pkpasses` selects passes by global `owner_user_id` without checking each org status, unlike public pass/bundle delivery. A holder can download a pass from a suspended/deleted tenant through Add-all.

**Acceptance:** Each member is gated by active org without breaking intentional cross-org aggregation: suspend A and verify A is excluded while the same holder’s active Org B pass remains.

## Existing controls and target isolation

Positive controls include org/mode-bound pass lists/writes; connection org checks; identity scoping; connector-secret org AAD; bundle per-pass org/mode validation; composite scanning-session org FKs; scoped idempotency and webhook dedupe; and row-scoped resolution before globally unique pass R2 keys. These do not repair the findings above.

For strict organization management isolation, introduce explicit `(user_id, org_id, role/capabilities, status)` membership and separate platform-admin authority. Server-side service/repo checks must consume an authorized org scope; do not infer membership from creator/audit actor or accept `orgId` as authorization. Preserve explicit platform-shared resources (null-org templates/identities/keys) as a named platform scope, not a generic tenant wildcard. Add composite tenant constraints for parent-child relationships (passes/connections, bundles/passes, scan/session/event/staff/org/mode); scope searches/counts/exports/caches/jobs by org and mode; revalidate mutable ownership at every authorization boundary.

Do not move customer `owner_user_id` into org membership. Verified holder accounts intentionally aggregate only their own passes across orgs. Never use shared email/provider identity as org authority or return a global account email in tenant DTOs. No authoritative organization roster/IdP-to-org mapping is present; the owner must supply it before RBAC migration. Do not silently make all platform admins admins of every organization.

## Acceptance matrix (proposed, not run)

- Org A/B keys and tenant admins cannot read, mutate or infer foreign IDs through list/search/count/history/export/assets/jobs; explicit platform principal retains shared-resource scope.
- Foreign-org parent/child inserts fail at service and DB layer; cache reassignment race fails closed.
- Test mode cannot consume live connector data; suspension/deletion gates bundle/public/customer delivery per pass org.
- Shared template content remains intentionally readable but tenant usage counts are isolated.
- Customer sees their own authorized A+B passes, not another holder’s, and tenant APIs never disclose private global identity.
- Apple, Google and Samsung instances coexist under one logical pass and one admission gate, with per-instance lifecycle and provider add readiness. Required unsupported security fails closed. No added provider crosses organization/mode.

Provider accounts, jurisdiction/contract semantics and deployed policies were not inspected; planned acceptance remains untested.
