# Multi-editor template lifecycle audit

Source-only review; no edits, builds, tests, browser checks, or production requests. Workflow facts below are source-backed; proposed UX improvements are recommendations, not observed usability failures.

## Current capabilities and boundaries

This is **versioned authoring, not collaborative authoring or approval**:

- Built-in templates are read-only; duplication creates an independent organization copy and records source template/version in audit (`src/worker/modules/templates/mutations.ts:63–120`).
- Template versions have an immutable-update trigger (`migrations/0001_platform.sql:173–190`).
- The designer already provides structured editing and live front/back preview. **Save version** preserves the active version until activation (`src/web/admin/templates/designer/save-flow.ts:37–60`).
- Activation asynchronously reissues live passes; incompatible passes remain on their previous version (`src/worker/modules/passes/stale-reissue.ts:43–72`).
- Organization-scoped API keys have read boundaries. All template writes currently require an admin session—not a scanner operator identity (`src/worker/modules/templates/routes.ts:43–50`).

## Findings and recommendations

### 1. High: organization selection is not delegated ownership

**Persona/state:** an organization author maintaining a shared or copied template.

Admin sessions are platform-wide: `assertOrgAccess` restricts scoped API keys and scanner principals, not administrators (`src/worker/platform/auth.ts:189–197`). Organization-scoped admin roles were explicitly excluded from the existing design (`docs/design/next-wave.md:21–23`). This is an intentional current boundary, **not evidence of an existing tenant authorization bypass**.

The UI’s “All organizations” describes availability, while “Change organization” alters the same template’s association (`src/web/admin/templates/template-overview.tsx:50–66`). Reassignment checks foreign-organization pass usage and name collisions (`src/worker/modules/templates/org-assignment.ts:16–39`).

**Recommendation:** before tenant delegation, distinguish owner, permitted consumers, library publisher, and responsible maintainer. Enforce organization membership plus author/reviewer/publisher permissions server-side. Copying, sharing, and transferring ownership must be distinct actions; a global-library edit must disclose its cross-organization impact.

### 2. High: publication safety depends on the editing route

**Persona/state:** an author saving work without intending to publish.

Designer saves explicitly set `activate: false`. Imports and manifest replacement call `commitVersion` without that setting, whose default activates existing templates (`src/web/admin/templates/designer/save-flow.ts:49`; `src/worker/modules/templates/import-pipeline.ts:188–203`; `src/worker/modules/templates/mutations.ts:202–216`; `src/worker/modules/templates/persist.ts:65–66,106–114`).

Consequently, “Upload version” and “Manifest saved” can publish and trigger reissue without the designer’s separate activation step. Technical validation is not approval: activation checks `report.ok`, not reviewer authorization (`src/worker/modules/templates/mutations.ts:129–150`).

**Recommendation:** route upload, structured editing, and advanced JSON through one staged lifecycle. Review must bind to an exact immutable revision, with author, reviewer, decision, and release notes. Any change invalidates its approval.

### 3. High: immutable versions do not prevent competing publications or stale rollback work

**Persona/state:** two publishers, or an operator rolling back during reissue.

Activation accepts only a target version and updates by template ID, without an expected active revision (`src/shared/contracts/templates.ts:147–149`; `src/worker/modules/templates/repo.ts:236–247`). Competing activations therefore overwrite the active pointer.

Separately, reissue workers retain their requested version and select passes on any different version (`src/worker/modules/passes/bulk.ts:38–59`; `src/worker/modules/passes/repo-ops.ts:118–136`). An older worker resumed after rollback can republish its superseded version. The cron’s queued-version marker does not itself fence those writes (`src/worker/modules/templates/repo-stale.ts:25–40`).

**Recommendation:** compare-and-swap publication against the reviewed active revision, preserve conflicting work as a branch, and fence every rollout publication with a release generation. Rollback must supersede outstanding work, not merely change the active pointer.

### 4. Medium: recovery is personal and browser-local, not a handoff mechanism

**Persona/state:** an author changing computers, opening two tabs, or handing unfinished work to another person.

Drafts use one localStorage key per user/organization/template, with a size cap; autosave waits 800 ms (`src/web/admin/templates/designer/drafts.ts:4–19,40–49`; `src/web/admin/templates/designer/designer.tsx:128–147`). Older-base drafts receive Restore/Discard handling, and navigation has an unsaved-change guard. These are useful existing protections. Sign-out deliberately removes local drafts (`src/web/lib/local-drafts.ts:1–14`).

**Recommendation:** add durable, permissioned server drafts with author, base revision, revision counter, and explicit private/shared status. Keep browser recovery as a clearly labelled fallback; isolate simultaneous tabs and offer comparison rather than overwriting their recovery copies.

### 5. Medium: saved-version review and provenance are insufficiently surfaced

**Persona/state:** a replacement maintainer reviewing another author’s inactive work.

The designer opens the active version (`src/web/admin/templates/designer/designer-page.tsx:113–117`). Version rows offer Report/Activate, but no preview, comparison, or continuation action; they render date/count/hash despite receiving `createdBy` (`src/web/admin/templates/versions-panel.tsx:65–90`; `src/worker/modules/templates/service.ts:63–72`). Clone provenance exists in audit, not the template summary.

**Recommendation:** add “Preview this revision,” semantic/native diff, “Continue as draft,” and visible author/lineage/change notes. Clearly distinguish active, saved, local draft, and last-successful preview: the current check intentionally retains the last built card after validation failure (`src/web/admin/templates/designer/api.ts:54–58`).

### 6. Medium: queued work can be presented as failed work

**Persona/state:** an operator monitoring publication.

`reissued_version` is marked before workflow completion. That equality becomes `settled`, and remaining older passes become `passesBlocked` (`src/worker/modules/templates/repo-stale.ts:35–40,69–85`; `src/worker/modules/templates/service.ts:140–152`). The UI can therefore describe still-running work as passes that “could not update.”

**Recommendation:** expose queued/running/partial/failed/complete states, actionable error groups, release identity, and retry controls. Count domain passes separately from wallet installations.

## Recommended target lifecycle

Use:

**Library source → organization adoption/copy → durable draft → validated immutable revision → review → approved release → activation → instance rollout → monitored recovery/rollback.**

The canonical revision should describe platform-neutral entitlement semantics, inputs, audience policies, and assets—not Apple JSON plus export plugins. Apple remains the full-fidelity primary adapter. Google/Samsung may support narrower declared subsets, but require real native artifacts, previews, issuance, updates, and lifecycle status.

Approval must cover provider projections, explicit optional omissions, required capabilities, and adapter revisions. Required unsupported semantics fail closed. Maintain one domain entitlement with many provider/device wallet instances; failures or removal of one instance must not replace the others.

Preserve historical Apple versions, identifiers, and provenance during cutover. Import Apple packages into reviewable semantic drafts with an explicit mapping/loss report, not silent conversion.

## Deterministic acceptance cases

1. Org A author cannot read or mutate Org B drafts, revisions, assets, imports, approvals, or releases through direct endpoints.
2. Authors cannot publish through upload, manifest replacement, activation flags, or ownership reassignment when lacking publisher permission.
3. Two editors starting at revision R retain both branches; stale activation is rejected without losing either document.
4. Pause release R2’s worker, complete rollback to R1, then resume R2: no instance returns to R2.
5. A colleague can preview and compare an inactive revision without activating it; identity, lineage, omissions, and approval are visible.
6. Required semantics unsupported by a selected adapter block publication; explicitly accepted optional omissions remain visible in previews and release records.
7. One entitlement remains usable on simultaneous Apple and Android/Samsung instances; rollout, installation uncertainty, update failure, and revocation are reported independently.
8. Review, comparison, conflict recovery, and confirmation work by keyboard and on narrow screens. Use structured controls; lifecycle management supplies no evidence that drag-and-drop would help.
