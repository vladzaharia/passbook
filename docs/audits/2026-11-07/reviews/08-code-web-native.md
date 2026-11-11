# React Scanner, Admin, Portal and Bridge Audit

**Verdict: incorrect — actionable defects found; no P0 established. Confidence: 0.90.**

Paths below are relative to `/Users/vlad/Repos/wallet`, except explicitly identified iOS-worktree paths. Findings are **confirmed-source**; acceptance scenarios were not executed. Most concern baseline code, not the current Android capability-only delta.

## Inspected boundaries

Scanner runtime, reducer/command dispatch, native acknowledgements, camera lifecycle, session refresh, offline retries, lookup and live/operator views; admin scanner/session forms and template images; portal routes, query caching and email mutations; shared contracts and Android result consumption. Also inspected the iOS worktree’s changed web/native-consumer integration, excluding native iOS internals.

## Findings

### 1. P1 — Bind pending retries to their original scanning scope

**Evidence:** `src/web/scan/machine/commands.ts:103-106,199-214`; `src/web/scan/platform/runtime.ts:60-64,196-205`; `src/worker/modules/scan/act-claim.ts:42-47`.

Unsure requests retain scanner identity and input, but not their original event/configuration. Reassigning the same scanner from event A to B leaves retries alive. If the original request never committed, its retry uses the current server actor and can record A’s scan against B when both accept that pass. Scope reconciliation runs only during runtime creation.

**Counter-control:** Idempotency protects an already-committed request, not one lost before commit.

**Fix:** Bind retries to immutable scope/revision, reject mismatches server-side, and reconcile in-memory/persisted state on reassignment.

**Acceptance:** Lose A’s request before commit, reassign to B, then retry; no B check-in is created.

### 2. P2 — Keep queued native reads and acknowledgements consistent

**Evidence:** `src/web/scan/platform/runtime.ts:153-158`; `src/web/scan/input/android-reader.ts:59-61`; `src/web/scan/machine/reduce-read.ts:95-98,110-114`; `src/web/scan/machine/reduce-tick.ts:42-43`.

A native read received during another check or the first 350 ms of a verdict can be queued. `emit()` returns null because it checks only the current input, so the bridge immediately acknowledges an error and retains no pending mapping. The reducer later processes that queued read and may check it in.

**Counter-control:** Native acceptance requires a matching pending ID, preventing a later corrective acknowledgement.

**Fix:** Make queue admission and native ownership atomic; never enqueue a read already acknowledged as discarded.

**Acceptance:** Queue a second native barcode during a verdict; receive exactly one acknowledgement matching its eventual server decision.

### 3. P2 — Synchronize camera hardware before overwriting its status

**Evidence:** `/private/tmp/wallet-ios-scanner/src/web/scan/platform/runtime.ts:174-184,238-241`; that worktree’s `src/web/scan/machine/store.ts:180-181`.

The iOS frontend patch calls `configure()` before `syncCameraMode()`. Barcode→none changes status to `off`, so synchronization no longer sees `disabled` and does not start the camera. None→barcode changes status to `disabled`, causing synchronization to skip stopping the existing stream. Reported state and actual capture diverge.

The shared store also resets a manually enabled fallback camera on unchanged reader configuration refreshes in main.

**Fix:** Separate configuration/preferences from actual camera status; perform start/stop transitions using the previous hardware state.

**Acceptance:** Switch reader modes both ways while started; verify stream state matches UI state and unchanged polling preserves manual fallback.

### 4. P2 — Allow expired uncertainty to leave the pending-shift state

**Evidence:** `src/web/scan/ui/scan-overlays.tsx:89`; `ui/shift-sheet.tsx:79`; `machine/reduce-answer.ts:203`; `machine/commands.ts:203`, all beneath `src/web/scan/`.

End shift counts every unsure entry, including expired ones. After two minutes those entries stop retrying but remain retained for the shift; therefore one unresolved timeout can disable End shift indefinitely while the page stays open.

**Counter-control:** Retaining expired entries preserves diagnostic history, but does not provide reconciliation or dismissal.

**Fix:** Distinguish actively pending work from expired history, with an explicit acknowledgement/reconciliation path.

**Acceptance:** Expire an unsure request and reconnect; staff can finish the shift without unpairing or silently losing its history.

### 5. P2 — Represent “clear direction override” explicitly

**Evidence:** `src/web/admin/scanning/scanners/scanner-fields.tsx:253-263`; `scanner-draft.ts:109`; `src/worker/modules/scan/scanning-sessions.ts:128-135`.

“Use pass rules” encodes direction as `undefined`. JSON serialization omits it, while the service merges submitted settings over stored settings. A previously saved entry/exit override therefore survives a successful save. Session forms reuse this encoder (`sessions/draft.ts:46-51`).

**Fix:** Add an explicit clearing representation and remove the stored override when selected.

**Acceptance:** Save Entry only, change to Use pass rules, save/reload; direction is absent and pass rules determine behavior.

### 6. P2 — Fence mutation completion to the owning dialog

**Evidence:** `src/web/admin/scanning/sessions/session-dialog.tsx:37-38,51-52,91-92,105-106`; `session-page.tsx:203-214`.

Cancel remains available during writes, but completion callbacks still run after dismissal. A delayed duplicate-session creation can navigate after cancellation; a delayed rules save can close a replacement dialog through the parent’s shared dialog-state callback.

**Counter-control:** Dirty-form confirmation protects unsaved input, not already-running mutations.

**Fix:** Prevent dismissal during pending writes or invalidate completion ownership when dismissed.

**Acceptance:** Delay a response, dismiss/open another dialog, then resolve; no stale navigation or closure occurs.

### 7. P2 — Ignore superseded image-read completions

**Evidence:** `src/web/admin/templates/designer/section-images.tsx:22-31,47-57`; `src/web/admin/passes/detail/image-slot-row.tsx:35-40`.

Image selection awaits `file.arrayBuffer()` without per-slot request ownership. Replacement and removal remain enabled. An earlier read completing later can overwrite a newer selection or restore a removed image, which can then be saved.

**Fix:** Use per-slot generations covering selection, removal and unmount.

**Acceptance:** Delay image A, select B or remove the image, then finish A; the newer edit remains.

### 8. P2 — Recompute portal detail seeds when the pass ID changes

**Evidence:** `src/web/portal/pass-detail-page.tsx:112-118`; `src/web/routes/passes/$passId.tsx:4-8`; `src/web/lib/query-client.ts:16-20`.

The list seed is captured once, but the detail query key follows the current `passId`. A mounted A→B route transition can initialize B’s uncached query with A’s pass. The list timestamp can make that incorrect data appear fresh for 30 seconds, including A’s download action.

**Counter-control:** ID-specific query keys are correct; supplied `initialData` is not checked against that ID.

**Fix:** Derive the seed from the current ID.

**Acceptance:** Navigate A→B without remounting; B never renders A’s details or actions.

## Strengths, recommendations and limitations

- Camera capture and decoder paths use generation guards, worker termination and stale-frame suppression.
- Native VAS ciphertext is refused by the scanner consumer rather than submitted as a barcode.
- Session mutations invalidate session/scanner queries; server revision checks and template validation remain useful independent controls.
- **Recommendation, not a proven regression:** consolidate duplicated bridge protocol definitions. Main’s production adapter discards the newly added capability snapshots; the richer reporting integration currently exists in the iOS worktree.
- No edits, builds, tests, formatters, production calls, secret reads or hardware verification were performed. Device suspension, accessory timing and the proposed delayed-response scenarios remain verification gaps.
