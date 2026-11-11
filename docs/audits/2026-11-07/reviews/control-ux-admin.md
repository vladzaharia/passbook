# Admin/control and general settings UX audit

## Boundary

Dedicated redesign audit, separate from the general platform P0–P3 report. Source-only for current behavior. No application edits, tests, builds, formatting, external/production calls, or real delivery. The current working changes reviewed by the agent were unrelated Android work; these are baseline observations, not regressions from that patch. No new P0/P1 was established in this slice.

The retained [admin settings screenshot](../screenshots/admin-settings.png) was inspected offline. It shows the former desktop page with three grouped sections and no Basic/Advanced split. Its CSS viewport/DPR and current error/save/responsive states are not recorded, so it is not treated as fresh runtime verification. [Operator controls](control-ux-operator.md) and [cross-surface UX system](control-ux-system.md) are companion redesign reports.

## Current surface coverage

The admin product already has broad route/feature coverage; the redesign must preserve it while correcting context, interaction and recovery issues. This inventory is source-backed, not a claim of fresh visual exercise.

| Domain | Current routes and controls | Design consequence |
|---|---|---|
| Overview, health, audit | `/admin`; `/admin/status` recheck/component health/workflow runs; `/admin/audit` search/filter/detail drawer | Keep platform/tenant/mode/time scopes explicit; actionable failure links must retain the selected scope. Preserve skeleton/error/empty/pagination states. |
| People/account | `/admin/users`, user detail; email aliases, enable/disable, sessions, identity-provider management; personal `/admin/account` | Global account identities are not organization memberships. Keep platform identity recovery, personal sessions and tenant membership separate; disable/revoke consequences must be clear. |
| Organizations | Directory and org detail; name/slug, status, branding/pass/email/support, default signing identity, lifecycle/setup/counts | Show Platform-wide directory versus membership-authorized workspaces. Brand and detail changes share one safe draft; staged asset upload must not erase other edits. |
| Identities and API keys | `/admin/identities` upload/default/renew/APNs/re-sign; `/admin/api-keys` org/mode/scopes/expiry/reveal/revoke | Keep shared signer impact, org/resource grants, mode and expiry visible. Secrets are one-time/write-only; default key scope must follow the current workspace at each new open. |
| Settings | `/admin/settings`: magic links, IdP email trust, sender, refresh, version/retention budgets; scanning API policies also include scan retention, undo and lookup limits | Add a Basic/Advanced view, but Basic retains security/readiness summaries and safety consequences. Preserve all existing values; surface the current API-only policies in Advanced. |
| Connections | `/admin/connections`, create/detail; connector/configuration/mapping/lifecycle/test/sync/health/webhook | Keep environment and source data authority explicit. A Test key/source/config must not be presented as safe when it can still read Live. Show test evidence tied to its exact current config revision. |
| Passes/delivery | `/admin/passes`, create wizard/detail tabs, recipient/attachment email, devices, sync/history/connection/images, void/remove/transfer, bulk/bundles | Review binds to exact org/mode/template/recipient/credential generation; distinguish retry delivery from source refresh, portal removal, transfer and revocation. Keep current issuer, validity, holder, expiry, front/details, back content, images and bulk capabilities. |
| Templates | `/admin/templates`, upload/import, detail, immutable versions, structured front/details designer, manifest/inputs and release | One draft/review/approval/release contract across visual editor, import and manifest. Required capabilities/visibility stay prominent; raw JSON and hashes belong in Advanced. |
| Messages | `/admin/messages` audience/schedule/content/preview/send/retry/progress/per-pass outcomes | Preserve audience and mode review, partial item recovery and scheduled states. Retry only the recorded unfinished cohort, never resample a changed dynamic audience. |
| Test inbox | `/admin/test-inbox` captured message list/preview/text/retry/send-to-me | Distinguish captured-not-sent from a real manual send; show the destination for Send to me. |
| Scanning | `/admin/scanning` sessions/events/devices/staff/activity plus `/scan` operator controls | See the separate [operator UX audit](control-ux-operator.md). Session rules, device purpose, operator preference, customer projection and authority remain distinct. |

Key source anchors include `src/web/admin/{overview,status,audit,users,orgs,identities,api-keys,settings,connections,passes,templates,messages,scanning}/`; navigation in `src/web/lib/nav.ts`; shared controls in `src/web/ui/`; Worker route/contract evidence is cited under each finding.

## Newly identified baseline UX issues

These six current findings are source-confirmed, P2 in this dedicated design slice; they are not new security bypasses and do not replace the more urgent existing audit findings.

### N1 · P2 — Organization asset saves can discard other drafts

On `/admin/orgs/:orgId`, upload/replace/remove logo or icon immediately persists and invalidates organization data. The detail form is keyed by `updatedAt`, so the refetch remounts it and loses unsaved name/colors/default signer; suspension/reactivation can also change that timestamp. The route guard sees no navigation.

**Target:** Stage image operations with the grouped organization draft and one Save/Discard bar. If any operation is deliberately immediate, state that and preserve unrelated fields.

**Acceptance:** Change the unsaved name/colors/signer; stage and remove a synthetic logo; all edits remain visible and dirty. Save commits the chosen set; Discard states accurately which effects it can undo. Repeat on refresh/status update and upload failure.

Evidence: `src/web/admin/orgs/pass-branding.tsx:101-107,154-161`; `queries.ts:82-94`; `src/worker/modules/orgs/branding.ts:59-79`; `orgs/repo.ts:65-71`; `org-detail.tsx:169`; `org-form.tsx:85-94`.

### N2 · P2 — API-key modal can reuse stale org/mode defaults

The closed create-key dialog remains mounted and snapshots org/mode only at mount. If the operator changes from All organizations/Live to Org A/Test before its first open, the form may retain global/Live values, even though the service persists null organization as platform-wide. The controls are visible but defaults contradict the current context.

**Target:** Snapshot current authorized org/mode on each open, without overwriting intentional in-dialog edits. Default to org-bound and bounded expiry; platform-wide/nonexpiring authority requires explicit platform role and impact review. Show the full reviewed scope before one-time secret creation.

**Acceptance:** Change context before first and later opens; form defaults, review summary and stored key all match. Cross-tab context changes cannot silently overwrite an open dirty key form.

Evidence: `src/web/admin/api-keys/api-keys-page.tsx:110`; `create-key-dialog.tsx:96-135`; `src/worker/modules/api-keys/service.ts:61-88`; `src/worker/platform/auth.ts:189-197`.

### N3 · P2 — Organization directory scope control is misleading

The admin navigation marks `/admin/orgs` org-scoped and shows the top-bar selector, but the directory query key/request uses only search, cursor and limit. Selecting Org A changes remembered URL/workspace context, not the directory rows.

**Target:** Call the platform view **Platform directory · All organizations**, without an ineffective tenant filter. A target tenant member sees only membership-authorized workspaces. A resource detail always labels its real org. This is a UI scope mismatch, **not** evidence of a new tenant bypass in the current deliberate global-admin design.

**Acceptance:** Synthetic A/B verifies platform directory scope; A’s membership view contains only authorized orgs; direct B detail remains denied server-side; returning to A detail never implies a stale B filter.

Evidence: `src/web/lib/nav.ts:50-52`; `src/web/ui/layout/scope-switcher.tsx:15-20`; `src/web/admin/orgs/orgs-page.tsx:116-124`; `org-pages.ts:9-19`.

### N4 · P2 — Magic-link helper contradicts enabled state

The enabled `/admin/settings` switch displays “Holders without Polaris ID cannot sign in.” The server confirmation correctly applies that lockout consequence only when disabling. This is a copy/state error, not a missing lockout guard.

**Target:** On: **Allow holders without Polaris ID to sign in by email.** On a disabling draft, explain the effect and affected email-only users; keep the existing confirmation.

**Acceptance:** Saved and draft helper always matches the actual state. Cancel restores saved state; it does not apply an unconfirmed change.

Evidence: `src/web/admin/settings/fields.ts:37-42`; `setting-row.tsx:75-85`; `settings-page.tsx:15-23`.

### N5 · P2 — Delivery Retry also refreshes source data

A failed push row labelled Retry routes to `refreshFromSource`; the queued job reads/applies current connection data before pushing. A delivery retry can therefore mutate pass content rather than only retry the approved artifact.

**Target:** Separate **Retry delivery** (same approved artifact/generation/intent) from **Pull source & push** (may change content; show diff/review). Do not relabel a source refresh as a harmless retry.

**Acceptance:** Change a mapped upstream field after failed delivery. Retry leaves personalization/artifact revision unchanged; explicit source pull creates a reviewed new revision and shows that operation. Report the operation actually queued.

Evidence: `src/web/admin/passes/detail/delivery-tab.tsx:148-152,225-245`; `passes/api.ts:148-150`; `src/worker/modules/passes/routes.ts:152-163`; `passes/service.ts:242-260`; `src/worker/jobs/registry.ts`; `src/worker/modules/connections/jobs.ts:31-68,85-99`.

### N6 · P2 — User-owned pass count link opens a different set

User count links query passes by primary-email text. The displayed counts use `owner_user_id` across modes; the pass list applies current mode and prefix-matches email/display fields. Owners with secondary/removed aliases or both modes can see a nonzero count followed by an empty/different list.

**Target:** An owner-count link drills down by stable account owner ID and the same authorized org/mode/lifecycle predicate as the count, with scope named. Tenant members never receive cross-org account ownership projections or global primary email.

**Acceptance:** Synthetic owner with Live/Test passes and multiple email aliases opens exactly the counted owner set; unrelated prefix/display matches are excluded; tenant role sees only its authorized tenant slice.

Evidence: `src/web/admin/users/users-page.tsx:77-86`; `user-sections.tsx:224-233`; `src/worker/modules/users/repo.ts:25-28,123-127`; `passes/routes.ts:54-74`; `passes/repo-list.ts:61-78`.

## Ideal admin/control hierarchy

- Preserve all current route capabilities and shared UI kit; redesign the navigation and scope hierarchy rather than removing features. Recommended groups: **Operate** (Overview, Passes, Messages, Scanning); **Build & connect** (Templates, Connections); **Administration** (Organizations, People & access, Wallet accounts, API keys); **Platform** (Status, Audit log, Settings); Test inbox remains an explicitly named testing tool.
- Separate **personal account**, **organization workspace**, and **platform administration**. The current global admin role is not an organization membership. Target human org membership, service-principal grants and scoped elevation require server-enforced contracts; no filter or badge grants access.
- Headers identify actual resource org, mode/effect scope, lifecycle, reviewed revision and save state. Platform settings explicitly say **Platform-wide · Live and Test**; Test mode is not a platform-configuration sandbox.
- Use progressive disclosure without hiding security, tenant scope, admission/privacy policy, source/recipient, stale tests, revocation, credential expiry or unresolved outcomes. Raw schemas, hashes and technical diagnostics can go under Advanced.
- Preserve grouped form Save/Discard; stage org branding assets, retain draft after validation/conflict and surface dirty sections. Use semantic review of old→new values, scope, timing and irreversible effects for bulk actions, release, transfer and recipient/credential changes.
- Keep status text truthful: queued/provider accepted/applied/installed are distinct; unknown remains unknown; partial work gets an item ledger and retry of only unresolved original intents.

The full current-route matrix, Basic/Advanced taxonomy, 22-domain map and mockup contract are in [control UX system](control-ux-system.md). The general platform finding priorities remain in the separately maintained [priority report](../priority-report.md); this report is a UX redesign source, not a new release severity tally.

## Visual and functional evidence

- Retained historical screenshot inspected: `../screenshots/admin-settings.png`. No new browser session or fresh visual capture was performed by the reviewers. The target HTML mockup files contain synthetic data and are not shipped UI.
- For the required visual critique, parent captured and reviewed multiple local HTML mockup passes separately; screenshots and critique log are indexed in `../mockups/README.md` when complete. Those captures verify the prototype, **not** current application behavior.
- All acceptance tests above are proposed; they were not executed. No product capability is claimed to exist because a target control appears in a mockup.
