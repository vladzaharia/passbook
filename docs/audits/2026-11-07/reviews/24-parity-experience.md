# Cross-platform scanner runtime audit

**Inspected:** main repository scanner boot, input bus, camera, platform reporting, state machine, server settings/contracts, Android bridge; corresponding iOS-worktree implementations and native lifecycle/customer display.

Paths below are relative to the named checkout. **Read-only:** no edits, builds, tests, hardware verification, production calls, or secret access.

## Findings

### 1. P2 — Connect Android capability events to `/scan`
**Confidence: confirmed-source, 0.99. Main checkout.**

The new Android producer emits capability updates at `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:365-369`, but `/scan` discards every event except scan/cancellation/timeout at `src/web/scan/input/android-reader.ts:45-49`. Its device reporter still derives native barcode support solely from bridge presence (`src/web/scan/boot/use-device-report.ts:14`), and the server’s strict capability schema has no native snapshot field (`src/shared/contracts/scanning-sessions.ts:17-26`).

Consequently, the new OS permission, NFC-reading and accessory capability snapshots never reach PassBook’s device diagnostics. Updating `android/web/reader-client.js` does not fix the separate adapter actually used by `/scan`.

**Fix:** integrate the shared consumer, capability store, reporter and server schema together. The iOS worktree contains these components; this is **branch integration drift**, not an Android limitation.

**Acceptance:** toggle NFC and change camera permission, then return to `/scan`; device reports must reflect the new native state without requesting permission merely to report it.

### 2. P2 — Reconcile camera settings without resetting fallback
**Confidence: confirmed-source, 0.98. iOS worktree.**

The new runtime calls `store.configure()` followed by `syncCameraMode()` (`src/web/scan/platform/runtime.ts:240-241`), but configuration still unconditionally assigns `disabled` for hardware-reader settings and `off` when changing away from them (`src/web/scan/machine/store.ts:180-181`).

This produces two observable failures:

- On iOS camera fallback with `reader=barcode`, every ordinary session refresh disables and restarts the camera. Refreshes occur every ten seconds while ready (`src/web/scan/boot/use-scan-session.ts:14,69-72`); restarting stops the existing stream and decoder (`src/web/scan/camera/controller.ts:69-70`).
- Changing a running Android hardware-reader device to Camera leaves state `off`; `syncCameraMode()` only starts from `disabled` (`src/web/scan/platform/runtime.ts:174-184`). The former explicit restart path was removed, so the operator must tap **Use camera**.

**Fix:** give effective camera-mode transitions one owner; preserve an unchanged running fallback and explicitly start when switching from hardware to camera.

**Acceptance:** unchanged session refreshes must not reacquire the camera; changing Hardware → Camera must start it once without another operator action.

### 3. P2 — Preserve explicit camera fallback through capability updates
**Confidence: confirmed-source, 0.97. iOS-worktree shared web code with Android.**

For Android `reader=barcode`, `cameraDisabled()` remains true even after the operator explicitly enables the camera (`src/web/scan/platform/runtime.ts:69-72`). Every subsequent capability snapshot invokes reconciliation (`:194-204`), which stops any camera not already marked disabled (`:174-179`), undoing the exposed camera control (`src/web/scan/scan-loop.tsx:140-143`).

Android reports camera availability changes itself (`android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:71-77`). Android documents that opening a camera triggers unavailability callbacks, including for the opening application—so enabling fallback can trigger its own shutdown ([official callback documentation](https://developer.android.com/reference/android/hardware/camera2/CameraManager.AvailabilityCallback)).

**Fix:** distinguish the automatic reader default from an explicit operator camera override.

**Acceptance:** enable camera fallback on Android, then deliver capability updates—including its camera-open callback and an NFC toggle. Camera scanning must remain active.

### 4. P2 — Forward camera and HID verdicts to the customer display
**Confidence: confirmed-source, 0.99. iOS worktree.**

When the customer-display accessory is active, supported web-camera and ordinary HID scans cannot update it. The runtime calls `native.result()` (`src/web/scan/platform/runtime.ts:251-259`), but the adapter sends a result only for a pending **native-originated** scan (`src/web/scan/input/native-reader.ts:66-79`).

Native customer-display updates likewise require that native pending ID (`ios/PassBookScanner/ScannerViewController.swift:144-177`). Camera and browser HID inputs never create it. The customer screen therefore remains **Ready** through their check-ins.

**Fix:** add a correlated customer-display status path for all web input sources, retaining the server-verdict requirement for acceptance.

**Acceptance:** with the accessory active, camera and HID scans must show checking, accepted/refused/error, and return to ready appropriately; offline/local outcomes must never display acceptance.

## Capability limits and recommendations—not additional bugs

- **NDEF is not currently operator-accessible:** `runtime.readNfc()` exists, but no UI calls it. This omission is explicitly documented (`ios/README.md:33`), so it is a product gap rather than an accidental regression.
- **iPhone Wallet VAS is possible, but not implemented here.** Apple supports independent loyalty-pass reads through ProximityReader; entitlement, supported-device/region/provider setup and backend processing remain necessary ([Wallet VAS](https://developer.apple.com/documentation/proximityreader/accepting-loyalty-passes-from-wallet), [Tap to Pay prerequisites](https://developer.apple.com/documentation/proximityreader/adding-support-for-tap-to-pay-on-iphone-to-your-app)). Core NFC NDEF reading is a different capability.
- **External readers:** HID keyboard input is supported; generic USB serial/Bluetooth SPP is not. Unknown connection state is correctly reported rather than inventing connectivity (`ios/README.md:32`; Android `MainActivity.java:337-356`).
- **Offline:** running scans fail locally with a network outcome, rather than admitting offline (`src/web/scan/machine/reduce-read.ts:56-60`). Product wording should distinguish this from usable offline admission.

## Counter-controls and missing evidence

Strengths include a shared normalization bus, same-signature suppression, Android pending-read deduplication, foreground/origin restrictions, lifecycle cancellation, and refusal to treat captured VAS data as verification.

Not established: deployed web/native version alignment, physical accessory reconnect behavior, real permission transitions, sustained mixed-input duplicate rates, or customer-display hardware behavior. Required device scenarios include sleep/wake, HID reconnect, camera/native overlap, delayed responses and network loss during check-in.

**Overall correctness: incorrect. Confidence: 0.97.** The source shows integration defects; no P0 release-blocker finding was established within this slice.
