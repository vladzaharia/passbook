# Cross-platform scanner capability audit

**Verdict: incorrect — capability integration and fallback behavior need fixes.** Confidence: **0.97, confirmed-source**. No runtime or hardware verification performed.

**Inspected boundaries:** shared scanner/scan/NFC contracts; device reporting, persistence and surface selection; web input/runtime dispatch; Android bridge reports; iOS native reports and their web consumers.

Paths use **M** = `/Users/vlad/Repos/wallet`, **I** = `/private/tmp/wallet-ios-scanner`. Reviewed main’s Android patch and iOS changes relative to main.

## Capability matrix

| Feature | Maximum possible / detected | Reported / persisted | Actually used |
|---|---|---|---|
| Camera | All three use web decoding. Android enumerates cameras and permission/policy; iOS queries AVFoundation. | Main persists browser availability only. I adds native availability and permission. | Runtime selects camera versus configured reader; native permission does not itself grant capture. Reconfiguration defect below. |
| USB/Bluetooth HID | OS keyboard input; neither wrapper identifies whether a barcode reader is connected. | Native reports supported keyboard, `connected:null`, `connectionObservable:false`. `nativeBarcode` means Android platform/bridge—not detected hardware. | Web wedge input works independently of that boolean, but iOS/web reader controls incorrectly depend on it. |
| NDEF | Android platform supports NDEF; this wrapper does not implement it. Chrome Android supports permissioned Web NFC, unused here. iOS implements Core NFC text/URI reads. | I persists `nfc.formats`; Android reports `wallet-vas`, iOS `ndef`. | iOS `readNfc()` has no production UI caller. This is explicitly documented, not an accidental missing button. |
| Wallet VAS | Android captures encrypted ISO-DEP data. Supported iPhones can use ProximityReader subject to entitlement/provider requirements. | Both report `vas.available:false`; hardware support is separate. | Raw Android VAS is rejected by the web adapter. No implemented end-to-end verifier. |
| Layout / customer display | Browser viewport; I additionally detects Duo posture and system accessory availability. | I preserves native layout/display snapshot; server chooses automatic surface from width. | Local layout consumes posture. Native customer-display verdict delivery misses ordinary camera/HID scans. |

Evidence: M `android/.../reader/MainActivity.java:302-361`; I `ios/PassBookScanner/ScannerHardware.swift:13-23`; I `src/shared/contracts/scanning-sessions.ts:18-76`; M `src/shared/scan-surfaces.ts:3-14`; I `src/web/scan/platform/runtime.ts:65-74,272-274`; I `ios/README.md:31-36`.

## Findings

### 1. P2 — Consume Android capability events in the main web scanner

**Confirmed-source; confidence 1.00.** Patch anchor: M `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:365-369`.

Android now emits nested snapshots, but its actual main-repo consumer discards every event except scans/cancellation/timeouts: M `src/web/scan/input/android-reader.ts:44-49`. The generic bundled `ReaderClient` update therefore does not make `/scan` persist NFC, camera-permission or reader-state changes.

**Fix:** land the native-capability consumer, reporter and server schema together; the iOS worktree contains that integration.

**Acceptance:** toggle Android NFC and change camera permission; the session device snapshot updates without requesting permission or scanning a pass.

### 2. P2 — Initialize capability reporting outside the scanning runtime

**Confirmed-source; confidence 0.99.** Patch anchor: I `src/web/scan/platform/runtime.ts:194-195`.

Native snapshots enter shared state only inside `createRuntime()`. However, customer/monitor, staff-required and unassigned views bypass `Paired`, which creates that runtime: I `src/web/scan/scan-app.tsx:116-143`, `paired.tsx:33-37`. Their device reporter runs, but has no native handshake/consumer, so fresh native screen devices persist browser-only capabilities.

**Fix:** establish one capability bridge at the application/reporting boundary, independently of scan authorization and arming.

**Acceptance:** reload a paired customer screen and a staff-required scanner; both persist platform and permission information before starting scanning, with capture still stopped.

### 3. P2 — Reconcile camera tracks before configuration overwrites camera state

**Confirmed-source; confidence 1.00.** Patch anchor: I `src/web/scan/platform/runtime.ts:238-241`.

`store.configure()` changes camera state before `syncCameraMode()` examines it. Changing barcode-reader configuration to `none` produces `off`, so synchronization never starts the camera. The reverse transition sets `disabled` before synchronization, so it skips `camera.stop()` and leaves existing tracks alive. Evidence: I `src/web/scan/machine/store.ts:169-184`; `platform/runtime.ts:174-184`. The previous runtime explicitly started/stopped on reader changes.

**Fix:** reconcile from the pre-change state, or make one layer own camera policy and physical stream transitions.

**Acceptance:** change a running phone scanner both directions between camera and barcode reader; camera starts automatically when required, and tracks actually stop when disabled.

### 4. P2 — Preserve controls for configured HID readers

**Confirmed-source; confidence 0.99.** Patch anchor: I `src/web/scan/scan-loop.tsx:86-91`.

The new `readerUsable` predicate requires `nativeBarcode`, which is deliberately false on iOS and ordinary browsers: I `src/web/scan/boot/use-device-report.ts:19-22`. Consequently, configured USB/Bluetooth keyboard scanners lose reader status and **Camera off** controls, although their wedge input still works. The menu gates those controls on `hasReader`: I `src/web/scan/ui/scan-menu.tsx:136-153`.

**Fix:** distinguish configured keyboard-reader operation from native barcode delivery; preserve unknown connection state rather than treating it as unsupported.

**Acceptance:** configure an iOS/browser HID reader, scan successfully, disable the camera through the menu, and continue scanning without claiming an observable connection.

### 5. P2 — Forward web scanner outcomes to the native customer display

**Confirmed-source; confidence 0.99.** Patch anchor: I `ios/PassBookScanner/ScannerViewController.swift:144-151`.

On a device where the accessory display is available, ordinary camera and web-HID scans cannot update it. Web verdict forwarding requires a pending **native** scan ID (`src/web/scan/input/native-reader.ts:75-77`), and native display updates require the corresponding `pendingID`. Camera/HID inputs create neither. The display therefore remains “Ready” despite server decisions.

**Fix:** add a separate, redacted display-state path covering every input source; retain native acknowledgement correlation.

**Acceptance:** camera and HID accepted/refused outcomes update the accessory display; heads-up, timeout and local outcomes never show successful check-in.

## Compatibility, controls and limitations

- **Versioning:** envelopes accept only version 1, without negotiation. Main’s strict capability schema lacks `native` (M `src/shared/contracts/scanning-sessions.ts:17-26`), while I sends it. Deploy matching web/worker contracts; explicitly check older v1 apps without nested snapshots.
- **Counter-controls:** reports are authenticated, CSRF-checked and tenant-scoped; explicit customer roles cannot become scanners through width reports. Native capability claims do not authorize admission. See M `guard.ts:102-112`, `repo-scanning-devices.ts:92-102`, `scan-surfaces.ts:11-14`.
- **Platform limits:** [Apple](https://developer.apple.com/documentation/proximityreader/adding-support-for-tap-to-pay-on-iphone-to-your-app) requires supported iPhone hardware, entitlement and provider integration; [VAS payload processing](https://developer.apple.com/documentation/proximityreader/accepting-loyalty-passes-from-wallet) remains separate. [Web NFC](https://developer.chrome.com/docs/capabilities/nfc) is NDEF-only, not ISO-DEP. [ExternalAccessory](https://developer.apple.com/documentation/externalaccessory) requires supported MFi protocols, not generic Bluetooth serial.
- **Product recommendation, not bug:** decide whether to expose the documented dormant NDEF action.
- Missing evidence: physical HID disconnect/reconnect, camera removal/revocation, accessory withdrawal, actual entitlements and deployed-version compatibility. No builds, tests, production calls or edits performed.
