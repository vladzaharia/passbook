# Control UX system — dedicated redesign specification

**Status:** proposed ideal post-audit UX; not implemented. **Date:** 2026-11-07.

This is the standalone control/settings UX redesign deliverable. It is deliberately separate from the general platform audit, its release verdict, and its security findings. It supplies a cross-surface taxonomy, interaction contracts and render-ready frame specifications for two separate mockup sets: **admin interfaces** and **other interfaces**. It does not change application code or claim that the target permissions, provider adapters or approval system exist today.

## 1. Evidence and limits

Evidence labels used below:

- **Current source:** inspected application source, including focused read-only inventories of navigation and shared controls. This establishes implementation structure, not rendered usability or deployed behavior.
- **Retained visual:** existing synthetic local screenshots, inspected again for this synthesis. This is reuse of earlier browser evidence, **not a new browser exercise**.
- **Prior finding:** an already documented observation, consciously reused rather than counted as a new defect.
- **Proposed:** target design, including capabilities that require backend work before a functional UI may promise them.

### Retained visual evidence

| Actual surface/state | Retained artifact | What it supports | Boundary |
| --- | --- | --- | --- |
| `/admin/settings`, desktop, dark theme; loaded platform settings and read-only Polaris ID panel | [admin-settings.png](../screenshots/admin-settings.png), 2880×2366 image pixels | Three grouped editable sections, nine controls, no Basic/Advanced disclosure; clear shared card/divider language. The enabled magic-link switch and its unqualified negative helper also illustrate why state-dependent consequence copy matters. | Original desktop CSS viewport/DPR are not recorded in [verification](../verification.md#browser-observations); do not infer a viewport from image size. No save interaction exercised here. |
| `/scan`, unpaired, phone, dark theme | [scanner-pairing-phone.png](../screenshots/scanner-pairing-phone.png), 780×1688 image pixels; earlier verification records **390×844 CSS px** | Strong task title, pairing input, primary Pair action, explicit Scan as Admin alternative and recovery instruction. | Earlier session used reduced motion. This does not prove pairing, authorization, native capabilities or ordinary-motion choreography. |
| `/admin/passes/new` and `/admin/templates/{templateId}/design`, local synthetic authoring | [authoring-verification.md](../authoring-verification.md), recorded 390px/1440px walkthrough | Prior evidence of schema-led steps, approximate Wallet preview and Apple-specific editor; no neutral multi-provider or scan-display editor in that exercise. | Referenced prior exercise; those screenshots were not independently re-exercised in this slice. |

No browser/service was started: this assignment prohibits network and verification runs. No new interactive, visual, contrast, keyboard, screen-reader, camera, hardware or native test was performed. No builds, tests, formatters, production actions, provider accounts or secret values were used. The pre-existing Android changes are unrelated; this is not a patch-regression review.

### Reused evidence, not duplicate findings

Read first: [platform settings](25-settings-platform.md), [scanner settings](26-settings-scanner.md), [design cohesion](05-cohesion-design.md), [admin accessibility](15-a11y-customer-admin.md), [scanner accessibility](16-a11y-scanner-native.md), [operator/admin workflows](04-ux-operator-admin.md), [scanner/admin visual review](02-visual-scanner.md) and [scanner motion](06-cohesion-buddy.md). Additional dependencies: [buddy state](buddy-state-ux.md), [tenant control plane](multitenancy-control-plane.md), [lifecycle/recovery](multitenancy-lifecycle-recovery.md), [authoring surfaces](authoring-surface-preview-model.md), [version lifecycle](authoring-template-version-lifecycle.md), [provider instances](wallet-multi-instance-lifecycle.md), [credentials/revocation](wallet-revocation-credentials.md) and [adaptive wallet offers](business-adaptive-wallet-offers.md).

The existing findings about hidden API-only policies, reset persistence, misleading delivery/publication outcomes, privacy, event assignment, uncertain scans, focus, spoken verdicts and motion remain owned by those reports. **No additional severity/count is assigned here.** The materially new deliverable is a single UX contract joining their consequences across surfaces.

## 2. Reuse the design system; change the information architecture

Normative design references: [UI consistency](../../../design/ui-consistency.md) and [motion and expression](../../../design/motion-and-expression.md), with [scanner choreography](../../../design/scanner/buddy-motion.md) for operational feedback. Existing source exceptions are audit work to resolve, not permission to build a second kit.

**Current strengths to preserve:** shared themed surfaces, entity/action/status registries, schema-led forms, one page save bar, dirty-dismiss protection, explicit confirmation verbs, one-time secret disclosure, cursor-pagination recovery, icon-plus-text verdicts and persistent scanner announcers. Source anchors: `src/web/ui/{save-bar.tsx,dialog.tsx,alert-dialog.tsx,status-pill.tsx,secret-reveal.tsx,pagination.tsx}`, `src/web/lib/{entities.ts,action-icons.ts,confirms.ts}`, and `src/web/scan/ui/live-announcer.tsx:8-35`.

**Current system problem:** controls are distributed by resource, while scope, inheritance, authority and execution state vary independently. A Settings redesign alone cannot fix this. A nicer switch must not continue promising a reset the service cannot persist, a queued message must not become “sent,” and a Basic/Advanced tab must not imply tenant authorization.

### Non-negotiable target invariants

1. **Authority before presentation.** Organization membership/capability and platform authority are separate server-enforced grants. Basic/Advanced is disclosure only. The existing console is global-admin based, not delegated tenant administration; see the tenant control-plane report. Do not present its org filter as an access boundary.
2. **Scope before action.** Show the actual organization, resource and mode affected. A data-view Test filter is not a promise that shared templates, global settings or connections cannot affect Live.
3. **Approval binds an immutable release.** Organization, mode, semantic revision/hash, provider/adapter projections, audience/privacy policy and approved omissions belong to the reviewed snapshot. Changed inputs invalidate approval; publishing/retrying cannot silently adopt a newer revision or another mode.
4. **One entitlement, many provider instances.** Provider creation, publication, save/registration observations, update failure and retirement are distinct. Adding one wallet does not remove another eligible option or create another admission allowance.
5. **Privacy is a projection boundary.** Customer display is independently allowlisted, not staff content hidden by CSS. Authored content cannot replace the system verdict or change authorization.
6. **Partial and unknown are real states.** Saved, queued, provider accepted, observed installed, confirmed admitted and physically removed are different claims. Unknown outcome is not refusal and not success.
7. **Safety remains discoverable.** Critical policy summaries, active warnings and recovery actions are never hidden by Advanced. Prominent does not mean placing every destructive action in a large red button; use the kit's consistent resource-safety/More placement and consequence review.

## 3. Personas, authority and scope

These are **target job/persona groupings**, not a claim of current RBAC support.

| Persona | Main question and starting point | Target authority boundary |
| --- | --- | --- |
| Platform administrator | Is the service safe and configured? Platform workspace → global Settings, Status, shared signing infrastructure | Explicit platform capabilities. Platform eligibility does not itself confer unrestricted tenant-data access. Scoped support/elevation identifies organization, reason and expiry. |
| Organization administrator | Is our organization ready and correctly configured? Organization workspace → Overview/readiness → Organization settings | Active membership/grant for that organization; approved shared resources may be used without granting mutation of them. No platform-wide directory, settings or cross-tenant users projection. |
| Author / reviewer / publisher | What changes, who can see it, and what exactly will go live? Templates → draft → revision review → release | Separate tenant-scoped capabilities; validation is not approval. Upload/raw JSON must not bypass publication authorization. |
| Integration maintainer | Is our source healthy and is its approved mapping current? Connections → health → configuration; tenant credentials | Tenant/service-principal permissions; secret management and publication permissions are explicit. A platform-wide key is not the default tenant choice. |
| Pass/support operator | Issue or correct this entitlement without unintended delivery or data takeover | Tenant-scoped operational capabilities; holder transfer, credential retirement and bulk/destructive actions may require additional authority. |
| Scanning-session administrator / manager | Are these devices using the correct admission, staff and privacy rules? Scanning → session → devices | Tenant/session capabilities. Scanner staff Door/Desk/Manager authority is not organization-administrator authority. |
| Front-line scanner/operator | May this person proceed; what must I do next? Paired `/scan` | Paired device/session plus current staff policy; no access to admin settings merely because Operator is the chosen layout. |
| Holder / visitor | Can I use/add my pass and what should I do now? My passes, public pass, email or customer display | Own authorized entitlement/portfolio or narrowly scoped public capability. Portfolio can span issuers without conveying issuer-management rights. |

### Scope vocabulary

Display the actual applicable scope, not a universal fictional inheritance ladder:

- **Platform policy** → effective global setting; OIDC deployment metadata can be read-only.
- **Organization** → branding/support/default signer; signer default applies to **new passes**, not automatic migration.
- **Template revision / approved release** → immutable content and audience policy; issued records can remain pinned to older revisions.
- **Connection / pass field** → source mapping versus an explicit manual override; changing a connection does not silently authorize field takeover.
- **Session → device overrides** → the existing scanner inheritance relationship; device exceptions cannot replace admission/staff authority.
- **Browser/device preference, shift, native configuration, OS permission** → distinct storage/ownership; do not label all as session settings.

Current anchors: `src/web/lib/nav.ts:24-69,84-91`; `src/web/admin/settings/settings-form.tsx:25-36,78-105`; `src/web/admin/scanning/sessions/session-fields.tsx:13-249`; prior settings reports for resolution/consumers. The settings service exposes value/default/editor metadata, but the current form flattens `value ?? default` into the draft. Provenance is therefore a proposed presentation, not an existing visible feature.

**Directory rule:** a platform-wide organization directory must say **“Platform directory · All organizations”** and require the corresponding platform capability. A tenant view opens only authorized organization context. A selector changing the URL is insufficient if the list query remains unscoped; this additional current observation was supplied by the parallel admin reviewer, not independently reproduced here. Do not duplicate a page-level org filter: retain one top-bar context control, and distinguish its filtering role from authorization. An org picker inside a create wizard binds the new resource; it is not an extra list filter.

## 4. Complete domain-to-discovery map

All routes/entry labels in the second column are **current**. Job ownership and Basic/Advanced placements are **proposed**. “Keep prominent” includes persistent effective summaries plus a clearly named edit/recovery path; it does not require every low-frequency field to be expanded.

| Domain | Current discovery path | Target owner and scope | Basic / keep prominent | Advanced / contextual detail |
| --- | --- | --- | --- | --- |
| Readiness and navigation | `/admin`; sidebar, Search/command palette, org context, account menu | Authorized workspace; platform or selected tenant as labelled | Next required setup, blockers, actionable health, current context/mode; links into the owning resource | Diagnostic details, raw IDs; never move blockers behind Advanced |
| Sign-in and identity-provider policy | Settings → Sign-in; read-only Polaris ID card | Platform security | Magic-link availability and consequence, effective email-proof policy, read-only issuer/source, lockout impact | Edit provider-email trust; deployment-managed group/issuer details stay visibly read-only |
| Platform sender and support discovery | Settings → Email; Organizations → detail → Support contacts / Pass email | Platform sender policy; tenant support/branding | Sender name; effective recipient-facing support and preview in the organization workflow | Fallback provenance and technical metadata; do not invent a platform-support form absent from current UI |
| Retention, refresh and notification budgets | Settings → Passes and retention | Platform policy | Concise effective summary, warnings and affected-data explanation; no legal-retention promise | Per-pass refresh cooldown, notifying-update budget, historical versions, audit/event/test/scan retention, undo window and lookup allowance |
| Organization details and lifecycle | `/admin/orgs` → organization detail; audit/setup links | Authorized tenant admin; platform provisioning/lifecycle separately | Organization identity, status, readiness, contacts, approved default signer; suspension consequence and recovery | Identifiers, default-source details and allowed technical overrides. Lifecycle actions remain in consistent resource safety/More placement, not Advanced |
| Organization presentation | Organization detail → branding, Pass email, Support contacts | Tenant content/support owner | Logo/icon/accent, support, Buddy email preference and unsaved/effective preview | Asset/source diagnostics; changes that need rebuild/reissue must disclose that timing |
| Signing and push credentials | `/admin/identities` → upload/detail; org default-identity picker | Tenant credential manager where permitted; shared/team infrastructure platform-managed | Readiness, expiry, affected dependencies, allowed signer selection and renewal/recovery path | Certificate/key upload or replacement, team/APNs technical details, global default changes. Do not expose other tenants' identities or imply a new default migrates existing passes |
| Semantic template and presentation | `/admin/templates` → detail/designer/upload | Tenant author; approved shared library read/use | Structured content, inputs, classification, preview surface/audience, provider readiness and blocking issues | Raw manifest/JSON, expressions and provider-specific mapping detail; every route obeys the same validation/privacy/release lifecycle |
| Revision, approval and rollout | Template detail → versions/activation/lifecycle | Reviewer/publisher for exact tenant/mode release | Draft versus saved versus approved versus active; author, diff, actual live impact, rollout/rollback outcome | Hash/adapter revision details, import diagnostics, per-item failures; no alternate publication bypass |
| Issuance and pass lifecycle | `/admin/passes` → New / pass detail; selection actions | Tenant pass operator | Organization/mode/template, holder, validity, review, create outcome; immediate void/revoke consequence and next action | Inputs not needed for ordinary issuance, raw version/credential diagnostics; advanced editing must not obscure validity or holder/credential generation |
| Holder, wallet instances and access | Pass detail → Holder / Devices / Delivery / Versions | Authorized support operator | Current owner, transfer consequence, provider-instance readiness/applied state, add-again, delivery and old-credential retirement status | Provider-object/registration identifiers, fetch history; never equate download-link rotation with full credential retirement |
| Source-bound pass fields | Pass detail → Fields / Connection / Sync | Tenant support/integration maintainer | Source/manual badges, last sync, restore-from-source action, explicit takeover consequence | Mapping/pointer diagnostics and fine-grained binding repair; destructive field takeover requires review regardless of tab |
| Individual delivery | Pass detail → Delivery; create/holder workflows | Authorized pass operator | Recipient, attachment/provider options, queued/not-queued/provider-accepted outcome; safe original-intent retry | Provider IDs and sanitized errors. Recipient/generation changes require reviewed replacement intent, not a blind Retry |
| Bulk operations and messaging | Pass selection bar; `/admin/messages` → composer/detail | Authorized tenant operator/publisher | Audience/mode/count review, schedule, delivery impact, durable progress and partial-result recovery | Recipient/error groups, per-item diagnostics and execution ledger; audience and known partials cannot be hidden |
| Connections, mapping and automation | `/admin/connections` → wizard/detail → Health / Configuration / Settings / conditional Webhook | Tenant integration maintainer | Connector/source, credentials Set/Missing state, Test, mapping readiness, live-effect warning, enable/disable, sync/receipt status | Connector advanced fields, polling/concurrency/rate tuning, lifecycle overrides and payload details; stale tests invalidate after relevant edits |
| API keys and webhook authority | `/admin/api-keys`; connection → Webhook | Tenant service-principal manager; platform-wide credentials separately | Organization/mode/scopes/expiry, one-time reveal, status, revoke/rotate recovery | Fine-grained scope details, receipt IDs and sanitized payload diagnostics. Revoking a compromised credential is not buried under Advanced |
| People and account access | `/admin/users` → user detail; account menu → Account | Platform global-account administration today; separate tenant-member/holder model proposed | Authorized identity, verification, membership/session consequences; own-account safety controls | Global identity-provider/session diagnostics only for authorized platform recovery. Do not reuse the cross-org Users projection for tenant managers |
| Events, admission and staff | `/admin/scanning` → Sessions / Events / Staff; session → Passes / Admission / Device defaults | Tenant session admin/manager | Accepted passes/event, time zone, direction/flow, capacity/re-entry policy, required staff and unsigned role, lookup/photo privacy, prerequisites and pause state | Detailed windows/constraints and diagnostics; effective limits and override authority stay visible. Staff setup must be real/ready before promising required-staff operation |
| Devices, purpose and pairing | Scanning → Devices / session detail → device sheet; `/scan` pairing | Session admin plus physical-device operator | Purpose, Scanner/Operator/Customer layout, reader, permissions, pairing/revoke, inherited policy and exception count | Explicit supported per-device overrides, report/firmware/connection detail. Read-only purpose and authority change only by an explicit authorized operation, never a rename/layout side effect |
| Operator preferences and recovery | Paired `/scan` → dock/menu, lookup/recent/shift overlays | Operator; local preference or active shift as labelled | Sound, Keep results until tapped, camera/manual/reader fallback, Look up, Done/Undo, event context, connectivity, unresolved actions and shift recovery | Detailed history/diagnostic information; no PIN/raw credential persistence; do not hide recovery or safety behind Advanced |
| Native and OS controls | Android reader configuration; app/OS permission settings; embedded `/scan` | Device operator/managed-device admin; native/OS scope | Camera availability/permission, input readiness, supported fallback and privacy guidance | Deployment/reader URL or broadcast configuration where supported; HID pairing remains OS/device-specific. NDEF and Wallet VAS are not interchangeable; unimplemented/unapproved VAS is not an enabled “advanced” capability |
| Status, audit and test evidence | `/admin/status`, `/admin/audit`, `/admin/test-inbox`; entity/overview deep links | Platform operations versus tenant-scoped history/test inbox | Current state, last checked/run, known failures, filters and safe recovery; captured-test versus real-delivery distinction | Request IDs, component checks, sanitized payloads/runs. Status is not hidden merely because diagnostics are technical |

Current inventory anchors: `src/web/lib/nav.ts:24-69`; `src/web/ui/layout/admin-layout.tsx:20-83`; `src/web/admin/orgs/org-detail.tsx:54-193`; `src/web/admin/passes/detail/pass-tabs.tsx:20-84`; `src/web/admin/templates/detail-page.tsx:42-155`; `src/web/admin/scanning/scanning-page.tsx:20-113`; `src/web/admin/scanning/sessions/session-fields.tsx:13-249`. Connection, native, privacy and lifecycle boundaries are elaborated in the reused reports, not newly runtime-verified here.

## 5. Basic / Advanced: exact safe classification

### Rules

- **Basic = completing the ordinary job safely. Advanced = rare technical configuration. Risk does not make a control Advanced.** Admission restrictions, privacy, recipient selection and irreversible consequences must be understandable in Basic.
- Use a labelled Basic/Advanced segmented control for substantial settings pages, with stable links and valid panel names. Within a workflow, use task sections and a single contextual “Advanced options” disclosure instead of nested accordions inside tabs inside sheets.
- Basic always displays the effective result, nondefault exception count, errors/warnings and an edit link for hidden policy. Search/deep links reveal the correct section. A submit error in a collapsed area opens it and focuses its labelled invalid control.
- Switching disclosure never saves, resets, grants access or discards drafts. The single save bar includes hidden dirty fields; e.g. **“2 unsaved changes · 1 in Advanced.”** Switching organizations/resources follows the existing unsaved-change guard.
- Explain unavailable controls: permission, unsupported capability, missing prerequisite or read-only deployment policy are different reasons. Authorized read-only users get understandable policy, not fake disabled switches.
- Remain task-local: do not move every connection/device field into global Settings or invent organization scanner defaults that do not exist.

### Exact platform split

There are nine current UI fields (`src/web/admin/settings/fields.ts:27-113`). The proposed split covers twelve operational policies by adding the **three API-only** scanner controls already identified in the settings reviews. Exact registry keys and defaults are confirmed in `src/shared/contracts/settings.ts:26-46`:

| Presentation | Controls | Basic summary / explanation |
| --- | --- | --- |
| **Basic: Sign-in** | `auth.magicLinkEnabled` | Enabled: **“Holders can sign in with an email link.”** Disabled saved state: **“Email-link sign-in is off. Holders need Polaris ID.”** Unsaved disabling: **“After saving, holders without Polaris ID will not be able to sign in.”** Retain the existing affected-user confirmation; unavailable counts are unknown, not zero. |
| **Basic: Email** | `email.senderName` | State whether this is the platform default; organization-facing support/branding stays in Organization settings. |
| **Basic: Policy summary** | Read-only summary and links, not duplicate editable fields | Email-proof policy; retention/version counts with units; notification/refresh/scan safeguards; deployment-managed OIDC source; any warnings/nondefault overrides. |
| **Advanced: Identity trust** | `oidc.trustEmail` | Explain verified-provider-claim versus additional proof. This is an authority-sensitive setting, not an invitation to disable verification invariants. |
| **Advanced: Pass updates** | `refresh.userCooldownSeconds`, `push.budgetPerDay` | Cooldown is **per pass** per prior enforcement review; describe notifications in a rolling 24-hour budget, and what silent updates mean. |
| **Advanced: Retention** | `retention.passVersionsKeep`, `retention.auditDays`, `retention.eventsDays`, `retention.scansDays`, `sandbox.purgeDays` | “Historical versions, plus current”; days in accessible labels; deletion timing and affected records. Defaults are application defaults, not legal obligations or erasure guarantees. |
| **Advanced: Scanner safeguards** | `scan.undoWindowMinutes`, `scan.lookupsPerHour` | Undo window in **minutes**; name/email lookup allowance **per scanner per hour**. Link to where the operator experiences the policy. |

The target Advanced panel contains **10 policies**: trust (1), updates (2), retention (5), scanner safeguards (2). The three new-to-UI policies retain their current registry defaults: 396-day scan retention, 10-minute undo and 200 lookups/scanner/hour. The additional registered `nfc.enabled` flag remains **gated and excluded from an enabling UI**: registry presence is not a functioning/approved VAS capability. Do not add aliases or duplicate policy keys.

Current source confirms the magic-link guard exists (`settings-page.tsx:15-24`; `magic-link-impact.tsx:14-26`); the proposal corrects unconditional helper wording without removing that protection.

### Controls that must stay prominent elsewhere

- **Organization:** active/suspended state, support recipient experience, readiness, signer expiry/default applicability and lifecycle impact. Keep urgent suspension/recovery accessible; deletion remains deliberate and cannot mean “erase everything.”
- **Authoring/release:** selected audience/provider, privacy classification, validity/required semantics, exact draft/revision/mode, blocking issues, approval and Live-impact review. Raw JSON can be Advanced; publication safety cannot.
- **Pass/delivery:** holder, validity, actual recipient/attachment, credential retirement, provider failures, partial creation/delivery and retry intent.
- **Scanning:** accepted passes/event/time zone, automatic versus review flow, in/out action, staff/unsigned authority, repeat/capacity approval, lookup/photo privacy, read-only customer purpose, pause/revoke, camera/manual fallback, Hold results, Undo and uncertain-action reconciliation.
- **Integrations/security:** credential Set/Missing/Expiring, selected tenant/mode/scopes, Test validity, connection automation/live impact, revoke/rotate and last successful sync. Technical limits may collapse; security status does not.

## 6. Reusable control and progressive-disclosure contracts

These are **compositions of the existing kit**, not a proposal for another component library. Backend-dependent outcomes must be returned by the actual operation; a UI cannot repair them by changing copy alone.

### 6.1 Context header

Keep breadcrumbs, title, at most three visible header actions, then a metadata row: **organization/resource · viewing mode or actual effect scope · lifecycle state · version/release where applicable**. Role/origin is neutral, selection is accent, health uses semantic state tokens; teal must not imply authority or health.

For platform Settings use **“Platform policy · All organizations · Live and Test”**, not a misleading tenant picker. For an org resource show the resource's real owner even if a URL filter changes. Target platform-support access identifies the scoped grant/expiry; it must not impersonate a holder. Advanced never changes the header's authority.

### 6.2 Effective setting row

Order: label → saved/effective value or control → scope/provenance → effect timing → help/error. Include units in the accessible name/description, not only a visually appended suffix. Examples:

- **“Audit retention (days)”** → `180` → **“Platform override; default 365 days.”** This is a platform policy, not an invented tenant override.
- **“Show member photos”** → Off → **“Inherited from North entrance session”** → **“Used on subsequent authorized results.”**
- **“Default signing identity”** → approved identity → **“Applies to new passes; existing passes keep their signer.”**

Use three distinct verbs: **Discard changes** (restore loaded draft), **Reset to default / Use session setting** (persist removal of this override), and **Restore from connection** (change pass field source). Reset names the resulting effective value/source and uses an explicit supported reset contract; blank input must not silently mean either “leave unchanged” or “clear.” Do not render a reset action before its consumer can persist it.

### 6.3 Save and application state

Reuse `SaveBar`/`SaveBarGroup`: one page, one bar, one unsaved-navigation guard. Preserve separate dirty, saving, waiting-for-connection, refused and failed results (`src/web/ui/save-bar.tsx:18-35,92-121,143-216`; settings form `:108-137,184-210`). Retain draft on failure, focus invalid fields, and keep cross-form partial failures identifiable.

“Saved” means the server accepted the intended values. It does not mean every offline scanner applied them, existing passes rebuilt or every wallet fetched an update. Show **“Saved · applies to new passes”**, **“Saved · rollout pending”** or **“Saved on server · device application not verified”** as supported by real evidence. Do not invent acknowledgement telemetry. Disabling a connection must describe in-flight behavior accurately; a spinning icon is not proof that writes stopped.

### 6.4 Graduated safety review

Follow `src/web/lib/confirms.ts:1-13` and the kit's blast-radius rule:

- Local, reversible preferences: direct change, truthful preference persistence, no confirmation ceremony.
- Ordinary settings: explicit page save, dirty protection and visible effective state.
- Publication, holder transfer, binding takeover, risky bulk sends: review **who/what/mode/version/recipient changes**, before/after, affected scope, unknown counts and next steps. Do not automatically approve because the form validates.
- Irreversible multi-record/holder-impact deletion: existing typed-confirm convention when warranted. Never add typing to urgent key/device revocation; those stay a plain clearly targeted confirmation.
- Scanner manager approval: focused, accessible, specific to the attempted action and original scan; PIN is transient, not stored in history/offline retry. Override is not Undo, and neither is completed until server-confirmed.

Async confirmation errors belong to the current operation and remain inside its dialog; reopening another target must not inherit an old error. After closing, restore the invoking control or a meaningful surviving destination. Consequence copy must distinguish suspension, archive, void, revoke, portal removal, soft deletion and erasure; do not repeat existing promises of instantaneous physical Wallet removal.

### 6.5 Secrets and credential replacement

Reuse `SecretReveal`, `CopyButton`, labelled controls and one-time acknowledgment (`secret-reveal.tsx:42-57,80-105`). Stored credential: **“Set · stored encrypted · not shown again”**, then deliberate Replace/Keep current. Clipboard failure must be visible as well as announced; retain safe manual selection if appropriate. Never show a successful check on failure or put secrets/capability URLs into screenshots, toasts, history or general diagnostics. Revoke describes the precise credential boundary; rotating a public link is not rotating installed-pass fetch/scan credentials.

### 6.6 Preview, validation and release review

Preview header: **Draft / approved revision / issued instance**, audience, provider/surface, fixture source, clock/locale/time zone and last successful preview status. A failed new build can retain the old preview only with **“Last successful preview · not current draft.”** Synthetic preview is never a real admission or issued credential.

Release review binds the immutable tenant/mode/revision and selected provider/adapter projections, required guarantees and acknowledged optional omissions. Show author/reviewer/approval and exact old→new impact. Any relevant edit requires a new approval. Publish/upload/import/raw JSON all converge on the same gate. A stale activation or superseded rollout is conflict/stopped work, not a successful application of the newest release.

Current source is versioned authoring, not this approval workflow; see the version-lifecycle report. Proposed UI controls require corresponding authorization, compare-and-swap and rollout-generation enforcement before they can be enabled.

### 6.7 Delivery intent and bulk operation ledger

Show intended recipient, attachment/provider actions, pass/holder/credential generation, approved mode/revision and immutable operation identity at review. For one unchanged retry retain correlation/idempotency and original intent; a changed recipient/artifact/generation is a new reviewed operation. Do not silently reuse current holder data to redefine an old send.

Durable outcome ledger: **selected/eligible → queued/running → completed, not started, skipped, failed or unknown**, with per-item reasons and a stable denominator/snapshot or explicit reconciliation. Queue acceptance, provider acceptance and actual receipt/installation are separate columns. Retrying targets only the eligible unfinished original items; keep already committed work visible. Cancellation reports what could no longer be cancelled. “3 queued · 1 not queued” is not “4 emailed,” and “Complete” cannot leave unexplained items.

Reuse existing counts/selection controls, but return real per-item outcomes; the current sequential bulk-email failure described in the lifecycle report cannot be fixed by a toast alone. Async provider fan-out similarly retains sibling successes and shows desired/applied state per instance.

### 6.8 Operator result and recovery

System-owned verdict, direction and required check are the primary content, mirrored in speech and retained history. Next: only authorized identity/details, then the action that resolves this state. Keep accepted/warning/refused/system-failure distinct; timeout after submission says **“Outcome not confirmed”**, not “Refused” or “Checked in.”

Uncertain actions retain original organization/event/configuration/release scope. Reconnection reconciles their receipt before retry; End shift explains unresolved work and offers reconciliation, not silent discard or a permanent dead end. Preserve the operator's manual reader/camera choice through capability refresh. Hold results applies to every verdict including Undo; a long reading time is not the same preference as reduced motion.

Scanner layout, reader technology and authority are three separate concepts: **Scanner / Operator / Customer display** are presentation purposes, **Camera / hardware-keyboard / supported native input** are readers, and **paired read-only / scanning + staff rights** are authorization. Changing metadata or appearance cannot change authority implicitly. Customer display stays a separately routed/sanitized status projection; native acknowledgements and customer presentation events are different consumers and both need correct routing.

## 7. Common state, empty, loading, error and partial patterns

| State | Required composition and copy direction | Action / access / motion |
| --- | --- | --- |
| Initial load | Final-shape skeleton after the kit's 150ms delay; named busy region, stable header/context | No misleading empty/zero counts or interactive skeleton. No pulse under reduced motion. |
| Background refresh | Keep prior rows/values; loading rail and `aria-busy`; last successful timestamp where material | Do not remount art, lose selection/focus or replace usable content with a full-page spinner. |
| Truly empty | Entity-specific `EmptyState`; explain what belongs here; one appropriate create/setup action | Header create becomes secondary; no empty table toolbar. Read-only users get an authorized next step, not a creation button they cannot use. |
| Filtered empty | “No passes match” with current filter scope, not “You have no passes” | Clear filters; keep search/filter context. Entity-picker loading/error must not become “No results.” |
| Missing prerequisite | “Signing identity needed” / “Staff setup unavailable”; name blocked operation | Link to the real permitted setup path; do not expose a nonworking action as ready. |
| Unsupported versus unverified | “Not supported” and “Availability not verified” are distinct | Do not render a fake NFC/VAS/provider action. Required unsupported semantics block that capability; optional omission is explicit. |
| Unauthorized / read-only | Non-disclosing boundary for inaccessible resources; within authorized resources, explain missing capability or deployment ownership | No switch that appears editable; no tenant data revealed to justify a denial. Restore focus on closing overlays. |
| Validation refusal | Field-associated error plus one polite summary; draft retained | Reveal hidden Advanced section if necessary; focus first invalid field. Never mark server refusal saved. |
| Request failure, no data | Shared neutral `ErrorState`, semantic danger icon, one sentence and Retry; sanitized request ID in Details | No raw exception/secret/payload. Failure shake only after an attempted action, not on first render. |
| Request failure, existing data | Keep existing list/preview, mark stale/last successful refresh; local retry/pagination feedback | Do not remove earlier pages on Load more failure. Stale data is not authority for a safety-critical mutation. |
| Pending async work | “Queued,” “Running” or “Waiting for connection,” scoped progress and operation link | Neutral/information tone; essential pending indicator only while work is actually pending; no success Buddy. |
| Partial completion | Warning-toned summary with completed/failed/skipped/unknown breakdown and item ledger | Retry only applicable outstanding work; no blanket success, lost selection provenance or replay of committed items. |
| Unknown submitted outcome | “Outcome not confirmed,” original scope/receipt, reconciliation path | Neither acceptance nor guest refusal. Do not offer a blind new admission. |
| Terminal success | Exact confirmed operation and affected scope; persistent resulting state plus optional concise toast | One bounded confirmation motion; no inference of installation, inbox receipt, physical deletion or complete rollout. |
| Paused / revoked / expired / disconnected | Use correct lifecycle label, reason and available recovery; keep status as-of time | A neutral lifecycle tone does not mean harmless. Emergency pause/revoke and recovery remain discoverable without Advanced. |

For screen readers, routine save/progress messages use persistent polite status regions; blocking errors and urgent verdicts use the established assertive channel without narrating every poll. Repeated scan labels are **events**, so use operation/event identity to reannounce identical results once. Current scanner announcer handles repeated messages; the customer live-display gap remains the existing accessibility finding. Activity/history includes textual outcome and reason, not only an aria-hidden glyph.

## 8. Icon, color, motion and accessibility policy

### Icon semantics

- Reuse `ENTITY`, `ACTION_ICON`, `actionOf` and the shared status map; no page-specific duplicate symbol set. Examples: Pass `Ticket`, Template `LayoutTemplate`, Connection `Cable`, Organization `Building2`, identity `FileBadge`, API key `KeyRound`, version `History`. Key glyph is for API keys, not every form of permission.
- Reuse action semantics: `RefreshCw` for source pull/reload, `Mail` for send, `Send` for update devices, `Zap` for connection Test, `Stethoscope` for dependency recheck, `RotateCw` for rotate, `Ban`/`Undo2` for void/unvoid, `Trash2` for removal. The **label names the domain**: “Sync source,” “Refresh pass,” “Retry delivery” are not interchangeable even when glyphs are related.
- Navigation identifies an entity; action icons identify a verb; status icons identify a state. Keep that distinction. Use at least glyph shape + readable text for safety-critical states. Never encode success/refusal solely in red/green, a mascot, sound or haptic pattern.
- Icon-only controls use the existing labelled `IconButton` and tooltip/touch-accessible treatment. Essential actions keep visible wording at operational scale. Decorative glyphs/Buddy are hidden from assistive technology; repeated meaningful statuses retain accessible names.
- Lucide sizing remains 16px in controls/nav, 14px in status pills and 20px in a 36px entity tile. Provider actions use official localized provider artwork, not newly drawn Lucide wallet substitutes or altered branded badges.

### Truthful state and motion matrix

| Trigger / authority | State and icon/text | Motion / Buddy |
| --- | --- | --- |
| User changes a draft | Unsaved indicator and visible changed value | Existing switch/selection response; no “Saved” check or success celebration |
| Operation submitted | Exact busy verb, pending/info state | Existing action-specific pending treatment; never delay processing for animation |
| Server confirms scoped success | Completed operation, check/status text | Existing bounded confirmation; happy only for that confirmed scope |
| Queue/provider accepts work | “Queued” / “Provider accepted,” not received/installed | Pending/progress stays neutral unless the specific claim has completed; no global completion celebration |
| Warning/check required/capacity | Warning icon plus actual required check | Curious/restraint; no green admission cue before authorized confirmation |
| Server refuses admission | Refusal glyph/text/reason | Scanner's red refusal beat; customer uses generic “Please see the desk” and apologetic treatment, never exposed staff detail |
| System/network failure or unknown outcome | System error/unknown text, recovery | Sorry/neutral, not a guest-blaming refusal and not a happy ready mascot |
| Refetch, filter, cached revisit | Existing content and rail/as-of status | No re-entry, number restart or remount celebration |

Follow existing motion tokens, not new timings: chrome 80–280ms; art 400–600ms once; signature 480–900ms. Focus is instant; data/input never waits for motion. No ambient loops. Scanner result beat follows the existing dedicated contract: verdict at T0, one 150ms reaction delay, settled by T0+700ms; a new scan cuts the previous reaction without replaying the seated entrance. The known double delay/remount defects remain prior findings, not new timing guidance.

**Reduced motion:** no transform/3D/tilt, decorative entrance, beat, count-up, highlight or hover confirmation. Show final poses/values; opacity swaps remain at most 150ms (scanner at most 120ms per its own spec). Preserve only the existing `.wl-essential` pending spinner/ring/loading/sync indicators while actually pending. Do not impose a blanket animation reset that removes state feedback. Reduced motion does not change authority, content, result dwell or sound preference. Email is static; official Wallet badge artwork never animates, glows, scales or dims.

### Accessibility and layout requirements

Use the documented surfaces/tokens and contrast semantics in both themes; do not treat current placeholder contrast as approved because tokens are shared. Text/units/errors and nontext control/focus/state boundaries need their applicable contrast. Brand/accent cannot replace semantic warning/danger.

Retain keyboard focus, named panels, field descriptions/invalid metadata, modal containment/opener restoration and visible focus. A phone section-select must still name its active panel. No hidden face/control remains a keyboard stop. Grouping/visual reordering must preserve logical reading order. All actions remain reachable at large text, zoom and short landscape heights; decorative reserve yields to the verdict and recovery controls.

Honor the kit: 36px fine-pointer default controls, 44px touch hit height, 14px normal control text and 16px touch inputs; scanner dock can retain its larger operational targets. Use wrapping min-height buttons, safe areas and available-width popups rather than nowrap/clipping. Preserve policy/capability words when truncating titles. Do not rely on hover alone, camera alone, audio alone or gesture-only editing.

## 9. Render-ready mockup specification

All frames below represent the **ideal post-audit state**, using synthetic organizations/people/counts. They are not current screenshots, executable workflows, provider approval or proof of backend enforcement. Label each set “Proposed UX · synthetic state.” The parent deliverable is a local, non-networked interactive HTML mockup set; it is additive and does not replace unmocked current routes or capabilities. See [`mockups/README.md`](../mockups/README.md).

### Shared visual geometry

Use `AppShell`: 56px top bar; 15rem sidebar at ≥1024 and navigation sheet below. Full main width, no page-level max-width. Gutters 16px below 640, 24px above, plus safe areas; 24px section gaps; 48px card headers and 16px body padding. `TwoPane` uses a 20rem aside at ≥1280, stacked below. Cards use existing raised/page/overlay surfaces, `rounded-lg`, dividers and elevation; editable/read-only controls remain visibly distinct. Use existing title/body/help scale and one primary per view. No nested card borders or oversized ornamental dashboard chrome.

Common frames: **1440×1000** desktop and **390×844** phone. Supplement scanner with **844×390** landscape. Reflow/AT acceptance later includes 320px and the documented 195-CSS-pixel zoom case; a static frame is not proof of those behaviors.

### Set A — redesigned admin interfaces

**A1. Platform Settings: Basic and Advanced companion frames**

- Header: **“Platform settings”**, metadata **“Platform policy · All organizations · Live and Test”**. No tenant directory/selector pretending to scope the page. Role context **“Platform administrator”** is neutral, not a green badge.
- Basic/Advanced segmented choice immediately below header. Basic contains **Access and sign-in**, **Email**, **Policy summary** cards in that order. Magic-link switch On; helper **“Holders can sign in with an email link.”** Effective email-proof summary **“Additional proof required”** links to Advanced. Sender **“PassBook”**. Retention summary explicitly names days and **“Current version + 3 historical versions.”** Read-only Polaris ID source remains recognizable.
- Advanced companion: four groups from §5, including three explicitly new-to-UI API-backed policies. Synthetic draft example **Audit retention: 180 days**, provenance **“Platform override · default 365 days.”** Do not show an unsupported organization retention override. Bottom SaveBar: **“1 unsaved change · Not applied”**, Discard / Save; a lowering-retention review names deletion consequences, not legal assurance.
- Phone: same hierarchy, values/help stack, persistent summary/warnings and visible disclosure state; safe-area save bar never covers the last field or keyboard. Inactive panel has a valid accessible relationship, not dangling tab IDs.

**A2. Organization settings and access boundary**

- Tenant header **“Example Guild”**, metadata **“Organization settings · Active · Your role: Administrator.”** Only authorized tenant navigation is visible; platform directory is a distinct platform route/context.
- Basic cards: Details, Brand and support, Pass email preview, Readiness. Aside: approved signer **“Used for new passes”**, expiry/readiness and a clearly labelled resource-safety area. Add **Access** with real tenant member/service-principal permissions in the target, not the current global Users page.
- Advanced: technical configuration and allowed source defaults, never the only place to find suspension, compromised-credential revocation, support errors or signer expiry. Platform-owned shared/APNs fields show who manages them.
- Optional platform-directory companion is clearly **All organizations**, authorized only to platform provisioning; changing an org context must constrain the data query, not just the URL.

**A3. Scanning session policy with device exceptions**

- Header **“North entrance”**; metadata **“Example Guild · Live · Autumn Open Day · Europe/London · Paused.”** Primary Resume/Pause reflects confirmed session state. No fake “all devices applied” assertion.
- Basic task sections: **Passes and event**, **Admission and staff**, **Privacy**, **Devices**. Visible summary: event-ticket acceptance; automatic versus review; entry/exit; required staff readiness; repeat-admission and capacity-override authority; Look up people / Show photos; read-only customer purpose. Capacity approval is independently described, not hidden inside “admit again.”
- Device list: **Entrance scanner — Scanner — Camera**, **Support desk — Operator — Hardware/keyboard**, **Visitor screen — Customer display — Read-only**. Each row shows policy source and an exceptions count. Example **“1 device override”** links to a detail drawer showing parent and device value plus **Use session setting**. No layout thumbnail can silently promote read-only authority.
- Advanced details: only supported device behavior overrides, diagnostics and detailed timing constraints. Pair/revoke, incompatible event assignment, privacy warnings and staff prerequisites stay in Basic. Show a blocked-readiness variant if required staff cannot be provisioned; do not mock a nonworking sign-in as configured success.

**A4. Provider-neutral authoring and immutable release review**

- Main structured outline: **Content, Validity and credentials, Audience and privacy, Presentations**. Separate surface selectors for **Wallet / Staff decision / Operator lookup / Customer display**; within Wallet select Apple/Google/Samsung independently of audience. Preview labels **“Synthetic · Draft R12 · Not an issued pass.”** System verdict area is visibly locked/system-owned.
- Right issues panel: required-versus-optional semantics and provider readiness/omissions. Show any unavailable required policy as a publication blocker; no decorative green provider row can override it. Apple fidelity stays first-class; another provider is a native projection, not “Export Apple JSON.”
- Review companion: **Example Guild · Live · Revision R12 / hash… · Release L42**, author/reviewer, provider/adapter projection revisions, audience-policy revision, explicitly approved optional omissions, actual affected Live/Test counts and prior→target release. Primary **Publish approved release** enabled only for a current authorized approval. Changed draft variant says **“Approval no longer matches this revision.”**
- Below: rollout ledger by canonical pass/provider instance, desired/applied revision and pending/failed counts. Rollback names the superseding release and unfinished prior work; it is not an unqualified “all devices restored.”

**A5. Partial outcome and safe retry panel**

- Example operation **“Email 4 passes · Example Guild · Live”**, snapshot/release identity and reviewed recipient **“holder@example.invalid”**. No real address or secret URL.
- Headline **“3 queued · 1 not queued.”** Subline **“Delivery has not been confirmed.”** Four stable rows show pass title, recipient, queue outcome and reason; the fourth **“Not queued · recipient limit.”** Already queued rows stay present.
- Primary retry names only **“Retry 1 not queued”** and is unavailable until current eligibility permits it, with honest reason. No fabricated retry time, blanket resend or 4/4 green success. A changed-recipient/generation variant requires a new reviewed intent.

### Set B — other redesigned interfaces

**B1. Holder wallet chooser, pass detail and handoff**

- At 390×844, issuer identity and pass validity first; one logical pass, not three duplicate pass tiles. Main action recommends the actually eligible wallet for the platform signal; **Other wallets** is visible, keyboard-operable and exposes every other eligible action.
- Example generic-Android fixture: Google available/recommended; Apple **“Registration observed on another device”** or **“Registration observed; current device unknown”** according to actual evidence; Apple Add again remains eligible. Samsung row is available only with confirmed readiness/eligibility, otherwise **“Not available for this pass”** with a truthful reason. The fixture explicitly assumes the target adapters exist; current product is Apple-only.
- Provider-status section separates artifact applied revision from saved/registration observations and unknown current-device state. Opening a save URL does not change the label to Added. Show cross-device QR/link instructions without exposing raw bearer tokens as body text.
- Use official licensed localized provider assets when available. Until then, an annotated wireframe may reserve the action area with plain text; do not invent branded buttons. Remove from My passes is separate from provider-instance retirement and entitlement cancellation.

**B2. Scanner and Operator operational states**

- Pairing retains the successful existing task-first hierarchy; paired view adds stable organization/session/event, direction, reader readiness and connectivity. No admin/global settings controls appear merely because the user chooses Operator layout.
- State board includes **Ready, Checking, Checked in, Checked out, Check required, Refused, Outcome not confirmed, Paused**. Main verdict + distinct glyph + actual reason and action; authorized identity/details below. Sound and Keep results until tapped are readily discoverable; manual Look up / camera fallback and Undo remain reachable.
- Operator desktop: lookup/activity rail plus result stage; phone: accessible lookup sheet and one result column. Landscape 844×390 prioritizes verdict/actions and lets content scroll; no fixed decorative reserve consumes the whole height.
- Unknown-outcome frame shows original event/receipt and **Reconcile**, not a green offline acceptance. End shift shows unresolved work and a genuine resolution path. Manager override asks for the specific permission and action; no PIN appears in history.

**B3. Customer/visitor display paired to B2**

- Side-by-side with staff frame using the same synthetic event/state ID. Customer view shows only generic **“Please wait,” “Checked in,” “Please see the desk,”** or service-unavailable recovery. No holder name/photo, pass title, raw code, email, staff-only flag or manager action.
- Show accepted, warning/refusal and reconnecting companions. Happy only for confirmed acceptance; warning/refusal uses apologetic/restraint, not the scanner's guest-facing head shake. Repeated identical accepted captions still represent distinct announceable events.
- Customer purpose is read-only server authority; no hidden actionable controls. Native accessory frame is explicitly availability-gated/status-only, not a claim that an unintegrated iOS worktree or physical display was tested.

**B4. Provider-complete email and no-JavaScript public handoff**

- Issuer-first static email/pass summary; include every eligible provider's compliant action and concise requirements, not a guessed recipient-device recommendation. Each bundle-item action names its pass.
- Public/SSR Other wallets works without hydration; email uses real provider-supported durable/click-time flows, not a short-lived token embedded in a static send. Readiness/failure wording matches B1 and A5. No animation, fake save-success or generic Apple attachment masquerading as Google/Samsung.

A4 is an admin-authoring frame; B1/B3/B4 are its customer-safe projections, not duplicate editors. Share a labelled synthetic fixture/release across the two sets so an audience change visibly demonstrates privacy and provider differences while preserving the underlying entitlement.

## 10. Acceptance and implementation dependencies — not exercised

The mockups are design evidence only. A functional implementation is acceptable when these observable contracts hold:

1. **Authority/context:** tenant A cannot discover/read/change B through selectors, direct routes, IDs, global Users, previews, history or background work. Platform-wide directory/policy and scoped platform-support elevation are distinct. Basic/Advanced never changes authorization.
2. **Discovery/classification:** every domain in §4 has a permitted route and owning persona; all critical controls in §5 remain visible or directly named in Basic. API-only additions use the existing registry and exact consumers, not duplicate settings.
3. **Field/save:** every row conveys scope, source, unit, timing and supported reset. Switching panels preserves drafts; hidden-field errors reveal/focus correctly; failure retains edits; per-form partial save cannot become universal Saved. Magic-link helper reflects saved versus draft enabled state.
4. **Release:** authoring, upload, JSON and provider mappings bind approval to one tenant/mode/version/release. Stale approvals/activations fail without losing the draft; superseded workers cannot publish an old release. Counts disclose actual Live effects even from a Test-filtered view.
5. **Provider lifecycle:** one entitlement can coexist across eligible wallet/device instances with shared authoritative admission. Desired/applied/observed state is independent; transfer retires old credential authority; revocation commits denial before provider fan-out. No remote physical-erasure promise or click-as-installed inference.
6. **Safety/retry:** copy failure is visible/announced; urgent revoke is reachable; confirmation names the exact target. Alternate-recipient attached email retry preserves intent or requires review. Bulk 3-queued/1-not-queued recovers only outstanding work and does not hide committed operations.
7. **Scanning/privacy:** current event/policy scope and real staff prerequisites are clear. Metadata/layout changes do not change read-only rights. Same system verdict/direction/reason reaches screen, speech, recent history and correctly routed customer/native output; only customer-safe data crosses that boundary. Unknown submissions reconcile before retry/end shift.
8. **Accessibility/motion:** keyboard, screen reader, switch access, text enlargement, both themes, short landscape, reduced motion, clipboard denial, stalled loads/errors, repeated verdicts and mobile section selectors retain meaning/focus/actionability. No decorative motion or hidden face supplies the only information.

Backend prerequisites are explicit rather than illustrated away: tenant RBAC/grants; immutable approval/release/mode fencing; durable per-item and provider-instance outcomes; recipient/credential-generation-bound delivery; safe reset contracts; scanner privacy/authorization/routing and uncertainty reconciliation. These are dependencies on the existing audit work, not a new request to implement unrelated platform features in this design slice.

**Delivery boundary:** report/spec only. No application source edits, provider accounts, secrets or production actions in this slice. The separate mockup set is a local interactive HTML prototype with browser screenshots; it does not exercise product services or prove backend enforcement. The general platform audit keeps its verdict/findings separate and links this dedicated UX deliverable.
