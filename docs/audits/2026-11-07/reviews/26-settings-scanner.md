# Scanner Settings, Native and Hardware Audit

**Inspected:** web preferences, admin session/device forms, Worker enforcement/persistence, Android configuration/bridge, and iOS capabilities/customer display.

Paths below use **M** = `/Users/vlad/Repos/wallet`, **I** = `/private/tmp/wallet-ios-scanner`. Reviewed baseline `8f5bee0`, observed Android changes, and iOS additions through `0458552`. Source inspection only; no edits or verification commands.

## Settings inventory

| Scope | Settings and actual use |
|---|---|
| Platform | Undo defaults to 10 minutes; people lookup to 200/hour; scan retention to 396 days. These reach Worker authorization/rate-limit/retention consumers (`M/src/shared/contracts/settings.ts:39–46`; `modules/scan/outcome.ts:135–136`, `lookup.ts:29`, `jobs.ts:76`). |
| Organization/session/event | Sessions own accepted passes, admission restrictions, staff rights and time zone. New session forms default to all passes and lookup enabled. Worker defaults are automatic flow, unsigned door role, anyone may admit again, camera reader, offline disabled (`M/src/web/admin/scanning/sessions/draft.ts:12–16`; `M/src/worker/modules/scan/dto-console.ts:12–21`). Event time zone overrides session time zone during binding (`scanning-workspace.ts:53–58`). No separate organization scanner-default settings were found. |
| Device | Overrides are limited to flow, reader, direction, lookup and photos. Reset replaces overrides with `{}`, restoring session inheritance; server settings combine parent plus overrides (`M/src/shared/contracts/scanning-sessions.ts:30–38`; `M/src/web/admin/scanning/sessions/device-sheet.tsx:129`; `M/src/worker/modules/scan/scanning-devices.ts:101–107`). |
| Browser/shift | Sound, held results, camera selection and torch are runtime choices. Menu sound changes only machine state; the sound player’s persistent setter is not connected there (`M/src/web/scan/scan-loop.tsx:67,111–124`; `machine/reduce-env.ts:94–95`; `sound/player.ts:70–74`). End shift reloads while retaining pairing (`ui/scan-overlays.tsx:91`). |
| Native/OS | Android persists verifier URL, Pass Type IDs and broadcast configuration in private preferences (`M/android/app/src/main/java/im/plrs/passbook/reader/ReaderConfig.java:54–64`). iOS fixes the verifier origin and delegates permissions to the OS (`I/ios/PassBookScanner/ScannerViewController.swift:8–9,264–272`). HID pairing/layout remain OS/device settings; neither wrapper claims generic serial/SPP integration. |

## Findings

### P1 — Preserve standalone monitor rights during metadata edits
**Confirmed-source; confidence 0.99.** Patch anchor: `M/src/shared/scan-surfaces.ts:12–14`.

The new `desk` → `operator` mapping also reaches `updateScanningDevice`, including a name-only PATCH. Its consumer computes the effective surface at `scanning-devices.ts:93–94`, then writes the associated scanner role at line 114. `repo-scanning-devices.ts:122` converts a display into a device with scanning rights. Consequently, renaming a standalone legacy desk monitor can make its existing paired credential actionable. Capability reporting separately preserves standalone desks (`scanning-workspace.ts:79–80`), but only reverses this after another report.

**Fix:** preserve standalone monitor purpose on metadata/override updates unless explicitly converting its purpose.  
**Acceptance:** rename a paired standalone monitor; its role remains `monitor`, and `/scan/resolve` remains forbidden before and after capability reporting. Urgent notice sent.

### P2 — Connect Android capability events to the deployed scanner adapter
**Confirmed-source; confidence 0.99.** Patch anchor: `M/android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:204`.

The Android patch emits nested snapshots in `ready` and `capabilities` (`MainActivity.java:367–369`), but the actual `/scan` consumer discards every event other than scans/cancellations (`M/src/web/scan/input/android-reader.ts:45–49`). Its device-report contract also lacks native snapshots. Thus the new permission/NFC capability information never reaches this web runtime or admin configuration.

**Fix:** land the corresponding adapter, contract and reporting cutover together. The iOS branch contains that receiving implementation.  
**Acceptance:** changing camera permission or NFC state updates the web snapshot and stored admin device capabilities.

### P2 — Obtain native capabilities before non-scanning boot screens
**Confirmed-source; confidence 0.98.** Patch anchor: `I/src/web/scan/boot/use-device-report.ts:21–22`.

The iOS cutover derives Android barcode support exclusively from a received native snapshot. However, the handshake exists only inside the operational runtime (`platform/runtime.ts:186–206`), instantiated by `paired.tsx:37`. Paused, unassigned, staff-required and customer-display branches bypass that runtime (`scan-app.tsx:93–127`). Those screens therefore report no native metadata and can persist `nativeBarcode: false` on Android.

**Fix:** acquire capability metadata at scanner boot independently of arming readers.  
**Acceptance:** paused, staff-required and customer-display devices report their native platform/capabilities without requesting camera permission or starting NFC.

### P2 — Preserve explicit camera choices across capability refreshes
**Confirmed-source; confidence 0.98.** Patch anchor: `I/src/web/scan/platform/runtime.ts:174–183`.

`syncCameraMode` reapplies the reader-derived default on every native capability event (`:204`). On Android configured for hardware barcodes, choosing **Use camera** starts capture, which produces native camera-availability callbacks; the ensuing snapshot causes this function to stop the camera again. It cannot distinguish a default-disabled camera from an operator’s explicit opt-in.

**Fix:** track explicit camera choice separately from capability-derived defaults.  
**Acceptance:** enable camera fallback with a barcode reader configured; permission/availability events and unchanged session refreshes leave it enabled.

### P2 — Forward web-originated verdicts to the native customer display
**Confirmed-source; confidence 0.99.** Patch anchor: `I/ios/PassBookScanner/ScannerViewController.swift:144–151`.

The native customer display accepts results only for `pendingID`, created by native `sendScan`. Camera decoding and HID keyboard reads originate in JavaScript; `input/native-reader.ts:75–77` refuses to send their results because they have no pending native read. Therefore the outside display remains “Ready” during the app’s primary camera/HID scanning flows.

**Fix:** add a generic, non-PII customer-status route for every applicable scanner verdict, separate from native-read acknowledgement.  
**Acceptance:** camera and HID success/refusal/network failure update the outside display; names, photos and codes never appear there.

## Strengths and counter-controls

- Session policy is reread server-side; device overrides cannot replace admission/staff policy.
- Lookup and member-photo settings have server enforcement (`M/src/worker/modules/scan/rules.ts:79–80`; `member-photo.ts:11–20`).
- Offline reads fail without inventing acceptance. Uncertain submitted requests retain codes/actions, exclude approval PINs, expire locally after a 12-hour shift and are scope-cleared (`machine/commands.ts:28–31`; `offline/unsure-store.ts:12`; `offline/wipe.ts:61–75`).
- Accessible text/live regions and reduced-motion handling supplement sound and color. Android disables backup/transfer of app data.

## Product recommendations and missing evidence

**Recommendations, not introduced bugs:** explicitly define which operator preferences survive reload; retain a manual camera-off option for HID workflows despite unknown connection presence; place unsupported VAS configuration behind clearly labelled advanced controls.

NDEF is deliberately not exposed in the current iOS UI. Apple distinguishes [Core NFC NDEF reading](https://developer.apple.com/documentation/corenfc/nfcndefreadersession) from [Wallet VAS](https://developer.apple.com/documentation/proximityreader/accepting-loyalty-passes-from-wallet), whose reader setup requires appropriate entitlements/provider integration. The [outside-display API](https://developer.apple.com/documentation/uikit/uisceneaccessory/cameracapture(sceneconfiguration:userinfo:)) requires iOS 27.1 and system-controlled active-camera availability.

No physical-reader, permission-lifecycle, VoiceOver/TalkBack or outside-display verification was performed.

**Overall correctness: incorrect. Confidence: 0.98.** The role-conversion defect and native integration gaps warrant correction before merging affected changes.
