# Customer and business lifecycle audit

**Scope:** Portal/account/pass routes, public pass/bundle SSR, administrative passes/templates/messages/connections, and corresponding ownership, delivery, synchronization and workflow contracts.

Paths below are relative to `/Users/vlad/Repos/wallet`. Findings are **confirmed-source**; interleavings and proposed acceptance checks were not exercised by this slice. These are baseline audit findings, not attributed to the unrelated Android working-tree patch.

## Highest-impact findings

### 1. P1 — Correcting a recipient can still deliver fresh credentials to the old address

Email intent stores `{to, attach}`, but execution loads the **current** pass, download token and attachment. Reassigning and rotating the link do not invalidate that intent.

**Evidence:** `src/worker/modules/delivery/service.ts:137-147`; `delivery/email.ts:38-46,59-78,127-138`; `holders/repo.ts:234`; `passes/repo.ts:132-143`—all module paths under `src/worker/modules/`.

A delayed/retrying email to mistaken recipient A can therefore receive B’s updated pass and newly rotated URL. Organization-active checks and outbox leases do not prevent this.

**Fix/check:** Bind delivery to recipient/link generation and cancel stale intents. Queue to A, reassign/update/rotate for B, then consume: A must receive neither fresh capability nor artifact.

### 2. P1 — Broadcasts discard the requested scan audience

The API accepts and persists `target.scan`, but recipient selection drops it. Preview is broadened too, so it cannot expose the mistake.

**Evidence:** `src/shared/contracts/broadcasts.ts:33-40`; `src/worker/modules/broadcasts/service.ts:56-67,167-179`; `broadcasts/apply.ts:117-144`; `passes/repo-list.ts:5-85`.

This affects API clients; the current composer does not produce scan filters. Organization, mode, template and eligibility constraints still apply.

**Fix/check:** Implement scan predicates throughout count and paging queries—not merely field forwarding. Checked-in/not-checked-in fixtures must yield only the requested audience in preview and outcomes.

### 3. P1 — An unchecked takeover option still relinquishes manual fields

Binding initializes “Let the connection take over every field” unchecked, but omits `resetFieldSources` when false. The service interprets omission as takeover, queues refresh, and subsequent synchronization overwrites formerly manual fields.

**Evidence:** `src/web/admin/passes/detail/connection-tab.tsx:47,55-59`; `src/worker/modules/passes/connection-bind.ts:43-47,65`; `connection-passes.ts:49-54`.

**Fix/check:** Send the explicit checkbox boolean. Bind a manually edited pass with takeover unchecked; source refresh must preserve manual values and ownership.

### 4. P1 — Older reissue workflows can undo newer activations

Reissue workflows retain a fixed target version. Each page selects passes *different* from that target and republishes them without checking whether the target remains active.

**Evidence:** `src/worker/modules/passes/stale-reissue.ts:52-63`; `passes/bulk.ts:38-62`; `passes/repo-ops.ts:122-137`; `templates/repo-stale.ts:35-42`.

If v3 finishes before an older v2 workflow resumes, that v2 page can downgrade v3 passes. The already-claimed v3 marker prevents automatic correction.

**Fix/check:** Fence superseded upgrade runs at publication. Interleave v2/v3 pages; final passes must remain on v3.

### 5. P1 — Activation can claim zero impact while changing live passes

Confirmation uses the selected mode’s `passCount`, while template propagation targets active passes across modes. In Test mode, “No passes use this template yet” can precede updates to live holders.

**Evidence:** `src/web/admin/templates/activate-dialog.tsx:20-21,52-54`; `src/worker/modules/templates/service.ts:133-150`; `templates/repo-usage.ts:5-15`; `passes/repo-ops.ts:122-137`.

Shared templates are intentional; the inaccurate impact statement is not.

**Fix/check:** Show the worker’s exact eligible scope, explicitly identifying live impact. Test with zero test passes and an eligible live pass.

### 6. P2 — Installing one bundle part invalidates later parts

“Add all” links use numbered offsets over passes not yet registered in Wallet. Installing part one removes those rows from subsequent queries.

**Evidence:** `src/web/portal/my-passes-page.tsx:148-159`; `src/worker/modules/me/repo.ts:71,83,92-93`; `me/service.ts:251-258`.

With 12 passes, registering the first ten makes the still-visible part-two link return `BUNDLE_EMPTY`. Larger sets can skip passes.

**Fix/check:** Use stable membership/cursors rather than offsets over shrinking eligibility. Sequential installation must deliver every displayed pass exactly once.

### 7. P2 — Bulk email failures conceal committed partial work

Bulk processing queues emails sequentially and throws when a later recipient/org cap is reached. Previously queued items remain, but the caller receives no partial result and retains the original selection.

**Evidence:** `src/worker/modules/passes/bulk-actions.ts:31-64`; `delivery/service.ts:25-26,166-169`; `src/web/admin/passes/selection-bar.tsx:57-73`.

Four passes sharing one recipient exceed the three-email cap: three queue, the fourth fails. Repeating the batch later can resend the same three and repeatedly starve the fourth.

**Fix/check:** Return durable per-item outcomes and make retry target unfinished intents. Exercise that four-pass case without duplicate queues.

### 8. P2 — Creation reports email success when nothing queued

Pass creation suppresses email-cap errors; bundle creation suppresses enqueue errors generally. Both interfaces derive “sent/emailed” from requested intent rather than delivery acceptance.

**Evidence:** `src/worker/modules/passes/create.ts:179-189`; `bundles/service.ts:142-156`; `src/web/admin/passes/new-pass-create.ts:43`; `detail/callouts.tsx:89-96`; `bundle-dialog.tsx:123-124`.

The pass-created callout also hides its immediate send recovery action.

**Fix/check:** Return and display queued/not-queued outcomes while preserving successful creation. Saturate the cap, create, and verify truthful feedback plus a retry path.

## Supplemental confirmed lifecycle defects

All entries below are **P2, confirmed-source**.

| Defect and affected flow | Evidence | Fix and observable acceptance check |
|---|---|---|
| **Archive does not prevent issuance.** API and connection creation can still use archived templates. | `src/worker/modules/passes/create.ts:64-80`; `templates/registry.ts:120-127`; archive promise: `src/web/admin/templates/template-lifecycle.tsx:72-73`. | Add an issuance-only active-status guard. Archived creation must fail without inserting; existing-pass rebuilds must remain possible. |
| **Uploading silently restores an archived template.** Upload remains available, and default activation writes `status='active'`. | `src/web/admin/templates/detail-page.tsx:193-210`; `src/worker/modules/templates/import-pipeline.ts:188-200`; `persist.ts:106-111`; `repo.ts:241-246`. | Require Restore or explicitly confirm restore-and-activate. Upload alone must not silently unarchive. |
| **Delete can archive while reporting deletion.** UI eligibility uses mode-scoped, undeleted usage; backend protects all physical references. | `src/web/admin/templates/api.ts:146-148`; `template-lifecycle.tsx:47-50,94-97`; `src/worker/modules/templates/mutations.ts:258`; `repo.ts:118-124`. | Preserve/display the returned outcome. With only hidden-mode or deleted references, report archive and retain discoverable Restore. |
| **Reissue diagnostics misclassify queued/failed work as incompatible fields.** A queued-version marker is treated as settled. | `src/worker/modules/templates/repo-stale.ts:35-42,74-84`; `service.ts:140-152`; `src/web/admin/templates/template-overview.tsx:102-107`. | Derive progress/error from actual execution and outcomes. Paused work must show Updating; workflow failure must not claim invalid fields. |
| **Reissues silently truncate beyond 100,000 passes.** The page limit exits into Complete with work remaining. | `src/worker/workflows/bulk-reissue.ts:9,30-56`; page size: `src/worker/modules/passes/bulk.ts:12`. | Continue/requeue or surface incomplete status. At 100,001 eligible passes, none may remain silently unprocessed. |
| **Discard can leave “Never expires” checked despite restoring expiry.** The optional-date flag initializes only once. | `src/web/admin/passes/schema-form/datetime-input.tsx:51,57,99-103`; `detail/fields-tab.tsx:265-266`. | Reconcile external resets with the control state. Check Never expires, then Discard: saved date and checkbox must agree. |
| **Holder-change timing and partial failure are misleading.** Copy promises loss after new sign-in, but ownership clears immediately; failed email leaves a committed transfer and disabled same-address retry. | `src/web/admin/passes/detail/holder-tab.tsx:48,55-62,77,84`; `src/worker/modules/holders/repo.ts:234`. | Warn of immediate removal and distinguish assignment success/email failure. An unverified destination plus email failure must offer send-only recovery. |
| **Removing email does not remove already-owned passes as promised.** Ownership is sticky; removal deletes only verification. | `src/web/portal/account-emails.tsx:133`; `src/worker/modules/me/repo.ts:44,49,51-55`; shared admin promise: `src/web/lib/confirms.ts:97-98`. | Correct the promise to existing ownership semantics. Verify previously attached passes remain after removal/reload without misleading confirmation. |
| **Auto-clear can erase a newer message.** Expected text is checked before, rather than within, the retrying publication mutation. | `src/worker/modules/broadcasts/apply.ts:57-89`; `passes/publish.ts:87-91,225-229`. | Recheck on every CAS attempt. Insert a replacement between comparison and publish; replacement must survive. |
| **Completed broadcasts can retain incomplete progress.** Initial count is fixed, but subsequent pages re-evaluate eligibility. | `src/worker/modules/broadcasts/run.ts:35-47`; `apply.ts:142-145`; `repo-target.ts:14-25`. | Snapshot recipients or reconcile skipped outcomes/counts. Expire a later-page pass; final progress must account for it. |
| **Disable does not fence the current synchronization slice.** Generation fencing excludes `enabled`. | `src/worker/modules/connections/service-shared.ts:17-27`; `service-update.ts:124-140`; `sync.ts:251-260`. | Fence record writes on disable. Disable after slice preflight; subsequent writes/auto-emails must stop. Future slices already stop. |
| **Manual mode can strand webhook-only connections.** Intake rejects Manual while Sync now is unavailable. | `src/web/admin/connections/lifecycle-fields.tsx:32-51`; `detail-page.tsx:81-82,133-144`; `src/worker/modules/connections/webhooks.ts:36-40`. | Offer only executable modes. A webhook-only connector must retain a working ingestion path. |
| **Blank interval cannot restore the promised default.** Blank omits the patch, preserving the custom value. | `src/web/admin/connections/lifecycle-fields.tsx:56-63,139-150`; `src/worker/modules/connections/service-update.ts:94-95`. | Support an explicit default-reset value. Clear/save/reload a custom interval; the default must be effective. |
| **Test success/sample outlive source or credential edits.** Results are stored separately and not invalidated. | `src/web/admin/connections/create-wizard.tsx:77-78,110-114`; `detail-page.tsx:54,93-98`; `config-tab.tsx:107-125`. | Invalidate results on relevant edits. Test endpoint A, change to B: A’s success/sample must disappear. |

## Counter-controls, recommendations and limitations

**Strengths:** Verified-email attachment, explicit ownership reassignment, user-removal blocks, typed destructive confirmations, optimistic pass edits, scoped broadcast targeting and outbox leases/provider replay provide substantive controls. Public SSR uses private/no-store responses and non-disclosing link-preview metadata. Connections explicitly warn that they create live passes even in Test mode.

**Product recommendations—not additional proven bugs:** Explain send-time audience re-evaluation when scheduling; disclose live propagation before ordinary import/manifest saves, whose default activation is documented. Push-only webhook operators need receipt/replay recovery; their Health/Webhook views currently provide no usable replay action.

No edits, builds, tests, lint, formatters or production calls were performed here. Physical Wallet behavior, provider timing and browser rendering remain unverified by this slice; parent verification is separate.
