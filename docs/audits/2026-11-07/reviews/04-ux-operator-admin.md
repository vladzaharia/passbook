# Scanner Operator & Admin Workflow Audit

**Scope:** Baseline `8f5bee0`: setup/types, event assignment, pairing/staff, scanning/lookup/actions/undo, live displays, reconnect/offline, session end and recovery. Reviewed relevant scanner feature history. Findings distinguish the latest refinement regression from earlier baseline defects.

**Read-only:** No edits, builds, tests, formatters, production calls or secret-value inspection. Acceptance scenarios below are proposed, not executed.

## Findings

All findings are **confirmed-source**; consequences follow the specified trigger conditions.

### 1. P1 — Bind uncertain actions to their original event

**Evidence:** `src/web/scan/platform/runtime.ts:196-205`; `src/web/scan/machine/commands.ts:198-215`; `src/worker/modules/scan/act-claim.ts:16-31`.

Live session updates retain unsure requests when event A changes to B. Retries retain their input/key but contain no paired-scanner event binding; the Worker resolves the current event (`scanning-workspace.ts:54-57`). An unclaimed timeout or reopened failed request can therefore admit the pass to B when both events accept it.

**Fix:** Bind operations to their original event/configuration, reject stale retries, and reconcile local state before adopting another scope.

**Acceptance:** Timeout an A action, switch to B, then reconnect. Neither an unclaimed request nor a failed-row retry may mutate B.

**Counter-control:** Completed-key replay prevents ordinary duplicate writes, but not cross-scope execution. Introduced in `08db0d`.

### 2. P2 — Mount the newly exposed staff sign-in handler

**Evidence:** `src/web/scan/boot/staff-start.tsx:28-30`; `src/web/scan/api/scan-api.ts:220-222`; `src/worker/modules/scan/routes-staff.ts:3-4`.

The new form submits to `/api/v1/scan/staff`, but no mounted Worker route consumes that request. The empty `/api/v1/scan-staff` router is a separate console prefix. Even an existing staff member’s valid PIN cannot complete sign-in, leaving a staff-required scanner blocked.

**Fix:** Implement scanner-authenticated, CSRF-protected sign-in/out handlers and staff binding.

**Acceptance:** A valid PIN returns an updated session and permits scanning; invalid PINs remain retryable and rate-limited.

**Counter-control:** Null staff roles fail closed. This form-to-missing-handler regression was introduced in `08db0d`; deferred roster administration is a separate limitation.

### 3. P2 — Preserve legacy Desk roles during unchanged-layout saves

**Evidence:** `src/shared/scan-surfaces.ts:14`; `src/web/admin/scanning/sessions/device-sheet.tsx:26-40`; `src/worker/modules/scan/scanning-devices.ts:93-114`.

A legacy Desk monitor retains `surface: 'desk'` when renamed. The new resolver converts that value to Operator, and PATCH consequently changes its role to `scan` without an explicit layout change. The scanner dispatcher then leaves the read-only display path.

**Fix:** Use consistent standalone-aware resolution for PATCH and capability reports; require explicit Operator conversion.

**Acceptance:** Rename a standalone Desk monitor: role, kind and read-only behavior remain unchanged. Explicit Operator selection may convert it.

**Counter-control:** Capability reporting separately preserves standalone Desk monitors (`scanning-workspace.ts:79-80`), but PATCH does not. Introduced in `8f5bee0`.

### 4. P2 — Offer only valid event-assignment targets

**Evidence:** `src/web/admin/scanning/events/assign-dialog.tsx:46-50`; `src/worker/modules/scan/events.ts:284-287`.

“Assign scanners” offers every non-revoked device, including displays and shared-session Scanner/Operator devices. The server rejects displays and rejects shared devices with `SCANNING_SESSION_CONFIG_REQUIRED`; one invalid selection fails the operation.

**Fix:** Make assignment session-aware, or exclude invalid devices and link administrators to shared session rules.

**Acceptance:** A session containing Scanner, Operator and Customer devices must have a successful event-assignment path without offering unsupported individual targets.

**Counter-control:** Server validation prevents partial or inconsistent assignments. The mismatch dates to `08db0d`; the latest creation-flow cutover increases exposure.

### 5. P2 — Keep legacy watch and terminal recovery controls reachable

**Evidence:** `src/web/admin/scanning/scanners/scanner-page.tsx:30-38`; `src/worker/modules/scan/setups.ts:120-127`; `src/web/admin/scanning/sessions/device-sheet.tsx:115-155`.

Setup-backed scanners redirect to session detail. That destination lacks the legacy monitor watch editor and terminal **Replace token** action. It instead offers terminals QR pairing, which `pairing.ts:60-64` rejects.

**Fix:** Preserve these operations in the session interface, including endpoint-kind metadata and appropriate controls.

**Acceptance:** Replace a revoked watched source on a migrated monitor and rotate a setup-backed terminal’s token through the UI. Terminals must not offer QR pairing.

**Counter-control:** Existing admin endpoints still enforce watch/token rules. Older `/scanners` records lacking setup metadata may retain the legacy page. Introduced in `08db0d`.

### 6. P2 — Honor explicit admin selection before resolving stale scanner cookies

**Evidence:** `src/worker/modules/scan/guard.ts:60-63`; `src/worker/modules/scan/auth-store.ts:35-38`.

Cookie resolution throws for a matching revoked or expired scanner credential before `adminChosen` is evaluated. Consequently, **Scan as Admin** cannot use an otherwise valid administrator session/setup in that browser.

**Fix:** Select the explicit admin authentication path first, retaining admin-role and setup-ownership validation.

**Acceptance:** Valid admin authentication plus a stale scanner cookie must successfully open the owned admin setup; scanner-only requests must remain denied.

**Counter-control:** Managed setup ownership is checked server-side. Introduced with explicit admin selection in `74300593`.

### 7. P2 — Provide reconciliation for expired uncertain scans

**Evidence:** `src/web/scan/machine/reduce-answer.ts:203`; `src/web/scan/machine/commands.ts:202-203`; `src/web/scan/ui/scan-overlays.tsx:89`; `src/web/scan/ui/shift-sheet.tsx:79`.

After two minutes, unsure entries become `expired` and stop retrying, but still count toward the disabled **End shift** button. Recent scans provides only a warning, not reconciliation. Restoring connectivity cannot clear this through the normal UI; reloading retains expired entries.

**Fix:** Provide receipt-based reconciliation and an explicit resolution path—not merely an enabled End button or silent discard.

**Acceptance:** Let an uncertain action expire, reconnect and reconcile its original receipt. End shift must become available without duplicating admission or wiping storage.

**Counter-control:** The end guard conservatively prevents losing unknown outcomes. The incompatible guard was introduced in `83500593`.

## Strengths and operational limits

- Customer identity/photo removal occurs server-side (`src/worker/modules/scan/live-render.ts:19-26`).
- Paused/ended sessions reject mutations even when held results delay UI refresh (`guard.ts:155-164`).
- New offline reads fail closed rather than falsely claiming queued admission (`reduce-read.ts:56-59`).
- Pairing previews remain non-consuming; confirmation performs pairing.
- Lookup, action and undo client requests otherwise reach corresponding Worker dispatch points.

**Product recommendation, not another regression finding:** Gate staff-required configuration while roster provisioning remains explicitly unavailable, and explain that operational prerequisite.

Settings/identity inspection covered scanner policy plumbing, undo-window settings and NFC enablement UI—not certificate, entitlement or hardware validation. Responsive CSS and source tests were inspected, but browser appearance, accessibility, camera/HID/NFC behavior and production state remain unverified.

**Overall correctness: incorrect. Confidence: 0.95.** The source contains actionable workflow regressions; no runtime or hardware verification is claimed.
