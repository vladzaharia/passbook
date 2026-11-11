# Android Reader implementation audit

## Scope and evidence

Read-only inspection of `android/`: Java implementation, NFC/APDUs/TLV parsing, WebView trust and lifecycle, camera permissions, barcode input, configuration, layouts, tests and documentation. Traced native messages into the actual `/scan` consumer.

The checkout contains an uncommitted capability-reporting patch; findings below distinguish that patch from existing limitations. No builds, tests, emulator sessions, production requests or hardware checks were performed. No secret material was read.

## Patch finding

### P2 — Consume capability snapshots in the actual `/scan` adapter

**Confidence: confirmed-source, 0.99.**

**Patch anchor:** `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:365-369`.

The new native `capabilities` event is sent after permission, NFC and lifecycle changes, but the application’s actual consumer discards every event except `scan`, `timeout` and `cancelled`: `src/web/scan/input/android-reader.ts:44-49`. Consequently, neither the initial snapshot nor subsequent native availability/permission updates reach the scanning runtime. Only the standalone example client handles the new event (`android/web/reader-client.js:19-34`); that client is not what `src/web/scan/platform/runtime.ts:160-168` instantiates. `android/BRIDGE.md:3` also points to a nonexistent `native-reader.ts` in this worktree.

**Fix:** Route `ready.capabilities` and subsequent capability events through the actual adapter/runtime. Preserve the distinction between native VAS availability and independent keyboard-wedge input.

**Acceptance:** In a local verifier fixture, change camera permission and NFC state, background/resume, and reconnect after navigation. Confirm the scanning runtime receives updated snapshots without requiring reload, while keyboard barcodes continue through authenticated verification.

## Existing product/release constraints—not new merge defects

### P2 — Define activity-recreation behavior

**Confidence: confirmed-source; operator disruption is inference.**

`android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:89-97` recreates the UI and reloads the configured URL unconditionally; `armed` initializes to `true` at line 50. There is no saved WebView/native pause-state restoration. Rotation therefore creates a fresh page rather than preserving the current operator workflow.

**Counter-control:** Destroy/pause resets the native transaction gate, preventing an old native result from becoming accepted.

**Recommendation:** Preserve intentional pause state and define recovery for login, review and in-flight decisions. Do not restore stale acceptance.

**Acceptance:** Rotate before Start, during review, while paused and during a delayed decision. Preserve the intended operating state and reconcile any server-side admission exactly once.

### P2 — Validate compact landscape and side insets

**Confidence: confirmed-source layout; visual impact is inference.**

`android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:106-107` applies only top/bottom system insets. The header, status, actions and barcode field reserve at least 208dp vertically (`:114-158`), before system bars, leaving little WebView height on short landscape displays.

[Android’s edge-to-edge guidance](https://developer.android.com/develop/ui/views/layout/edge-to-edge) confirms enforcement for target SDK 35 on Android 15 and requires handling side bars/cutouts too.

**Recommendation:** Apply four-edge system-bar/cutout insets and provide compact native chrome.

**Acceptance:** Inspect portrait/landscape, three-button navigation, cutouts, large text and tablet split-screen. All controls and scanning decisions must remain reachable.

### P2 — Treat kiosk deployment as a separate managed-device requirement

**Confidence: confirmed-source.**

The app keeps the screen awake but remains an ordinary activity. Back can exit it (`android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:182-184`), and native Settings permits changing the verifier origin (`:117-122`). No lock-task integration was found.

This is **not** an origin-check bypass: changing the configured trust destination requires local interaction.

**Recommendation:** For unattended/customer-facing use, specify DPC-managed lock-task deployment and controlled settings access. [Android requires DPC allowlisting](https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode); screen pinning is escapable.

**Acceptance:** Under the intended management policy, Home/Overview cannot escape the kiosk, while authorized administration and recovery remain possible.

## Strengths and counter-controls

- **Bridge isolation:** Exact configured HTTPS origin, main-frame checks, bounded string messages and navigation invalidation are implemented in `android/app/src/main/java/im/plrs/passbook/reader/WebSurface.java:94-109,127-135`. HTTPS identity-provider navigation does not grant other origins the bridge.
- **Camera grants:** Video-only requests, foreground gating and renewed origin checking appear in `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:274-288` and `android/app/src/main/java/im/plrs/passbook/reader/CameraPermissions.java:43-47`.
- **Concurrency/cancellation:** NFC uses single-flight admission, generation checks and connection closure in `android/app/src/main/java/im/plrs/passbook/reader/NfcController.java:59-108`. No source-supported stale-result acceptance defect was established.
- **Input/acceptance:** Barcode length/control-character checks, transaction identity, timeout and deduplication are explicit. Diagnostics cannot accept passes: `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:211-219,236-251`; `android/app/src/main/java/im/plrs/passbook/reader/ScanGate.java:11-30`.
- **Honest capability limits:** Keyboard connection is unknown; native VAS verification and customer-display support remain false (`android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:337-361`). No generic serial/SPP/BLE implementation was found; documented accessories use OS keyboard input.
- The small Java classes and isolated protocol implementation are straightforward to maintain; no Kotlin migration is warranted by this audit.

## Documentation and missing evidence

`android/REVIEW.md:15` incorrectly retains the historical claim that no web verifier/API exists. Its recorded test counts are historical evidence, not verification of the present patch.

VAS is capture-only, not admission verification. Reader-mode A/B flags and skipped NDEF checking match the documented limitation ([Android NFC reference](https://developer.android.com/reference/android/nfc/NfcAdapter)). Real P400 ISO-DEP/VAS interoperability, Wallet authentication, Watch behavior, USB/Bluetooth reconnect, keyboard layouts and venue throughput remain unverified. The physical acceptance checklist appropriately acknowledges these gaps.

## Concrete emulator checks—not executed

Use a disposable, offline emulator with already-built debug/test APKs; select bundled diagnostics or a local HTTPS fixture, not production.

- Existing instrumentation: `adb -e shell am instrument -w -r im.plrs.passbook.reader.debug.test/androidx.test.runner.AndroidJUnitRunner`
- Launch: `adb -e shell am start -n im.plrs.passbook.reader.debug/im.plrs.passbook.reader.MainActivity`
- Focus the native barcode field, then run `adb -e shell input text 000123` and `adb -e shell input keyevent 66`; verify exact leading zeroes and one read.
- Permission recovery: `adb -e shell pm revoke im.plrs.passbook.reader.debug android.permission.CAMERA`; relaunch and exercise the real permission dialog.
- Background/resume: `adb -e shell input keyevent 3`; relaunch during a delayed fixture decision and verify stale native acceptance is refused.
- Landscape: `adb -e shell settings put system accelerometer_rotation 0`, then `adb -e shell settings put system user_rotation 1`; restore rotation afterward.
- Tablet sizing: `adb -e shell wm size 1280x800` and `adb -e shell wm density 160`; restore with `wm size reset` and `wm density reset`.

**Overall correctness: incorrect for the observed capability patch, confidence 0.98.** One evidenced integration defect; no P0/P1 finding established within this source-only slice.
