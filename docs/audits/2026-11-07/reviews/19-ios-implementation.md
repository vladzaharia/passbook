# iOS/iPadOS Scanner Audit

**Scope:** `/private/tmp/wallet-ios-scanner`; all five Swift files, scene/project configuration, WKWebView bridge consumers, camera lifecycle, capability reporting, and Duo layout/overlays. References below are worktree-relative. No edits, builds, tests, hardware verification, secret reads, or production requests.

**Verdict: incorrect.** One high-priority bridge defect and four medium-priority integration/recovery defects. Findings are **confirmed-source**, not runtime reproductions.

## Findings

### 1. P1 — Align WKWebView configuration with App-Bound Domains

**Evidence:** `ios/PassBookScanner/Info.plist:20`; `ios/PassBookScanner/ScannerViewController.swift:25-30`.

The app declares `WKAppBoundDomains`, but its WKWebView never enables `limitsNavigationsToAppBoundDomains`. [WebKit documents](https://webkit.org/blog/10882/app-bound-domains/) that declaring the key denies script injection, message handlers, and JavaScript evaluation unless the WebView opts into app-bound navigation. These are precisely the mechanisms used by this bridge.

**Impact:** The native handshake/capability channel cannot operate as designed; web-camera availability alone would not demonstrate working native integration.

**Fix:** Make the domain declaration and WebView configuration consistent. If enabling app-bound navigation, account explicitly for off-origin authentication redirects rather than continuing to allow them inside that WebView.

**Acceptance:** Against a controlled HTTPS fixture, confirm the injected bridge exists, `hello` receives schema-valid capabilities, native messages round-trip, and authentication/external navigation still behaves correctly.

### 2. P2 — Forward camera and HID outcomes to the customer display

**Evidence:** `ios/PassBookScanner/ScannerViewController.swift:145-154,160-167`; `src/web/scan/input/native-reader.ts:66-78`; `src/web/scan/platform/runtime.ts:106-109,207-212,251-259`.

Native display updates require a `pendingID` created by `sendScan`. However, normal camera and HID reads enter the web runtime directly. Although the runtime calls `native.result`, that adapter silently returns unless the input originated from a native `scan` event.

**Impact:** The advertised camera-capture customer display remains **Ready** while camera/HID scans are checked and accepted/rejected.

**Fix:** Add an explicit, correlated display-status channel covering every scanner input source. Preserve the existing native-read acknowledgment protection rather than weakening its ID check.

**Acceptance:** With fixture verdicts, camera and wedge inputs must produce checking → accepted/rejected/error model transitions. Physical Duo verification must then confirm the outer screen displays those transitions.

### 3. P2 — Break the script-handler retain cycle when scenes close

**Evidence:** `ios/PassBookScanner/ScannerViewController.swift:20-34`; `ios/PassBookScanner/AppDelegate.swift:12-31`.

The controller strongly owns its WKWebView and registers itself directly as its content controller’s message handler. [WebKit retains that handler](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKUserContentController.mm#L185-L186). There is no handler removal or scene-disconnection teardown.

**Impact:** Closing an iPad window leaves its controller/WebView pair retained. Repeated window creation accumulates otherwise-discarded scanner instances.

**Fix:** Use a weak forwarding handler or explicitly remove the handler during scene teardown. Cleanup solely in `deinit` cannot break this cycle.

**Acceptance:** Open and close several iPad Simulator windows; Memory Graph should show the discarded scanner controllers and WebViews being released.

### 4. P2 — Keep Duo dialogs outside the hinge region

**Evidence:** `src/web/scan/scan-loop.tsx:155-156,298-319`; `src/web/scan/ui/scan-shell.tsx:94-98`; `src/web/scan/ui/scan-overlays.tsx:95-104`; `src/web/ui/dialog.tsx:78-90`; `src/web/ui/overlay.tsx:69-72`.

Duo geometry reaches the main scanner shell only. Scanner dialogs are separate body portals and retain viewport-centered positioning. Consequently, opening **Reader tips** or a camera-error dialog on a partially folded device places the panel across the central division instead of within either safe pane.

**Fix:** Propagate the reserved-region geometry into overlay placement, using a pane-aware portal/container.

**Acceptance:** In Duo Simulator, open these dialogs in book and laptop poses, then rotate while open. Their bounds and interactive content must remain outside the active division region.

### 5. P2 — Direct denied-camera users to the iOS app’s settings

**Evidence:** `ios/PassBookScanner/ScannerHardware.swift:39-46`; `src/web/scan/camera/controller.ts:130-136`; `src/web/scan/ui/camera-layer.tsx:78-100`.

After native camera authorization is denied, the shared screen instructs users to enable access in **browser settings**. The permission actually belongs to the installed iOS app, so changing Safari/browser permission does not recover it.

**Fix:** Select recovery guidance using native platform/permission capabilities and identify the app’s iOS camera setting; retain browser wording for browser clients.

**Acceptance:** On a physical iPhone, deny access, follow the displayed recovery instructions, return, and use Resume/Retry to obtain a live camera. Manual entry remains a useful existing fallback.

## Strengths and counter-controls

- Swift UI/hardware/model state is main-actor isolated. NFC callbacks hop to that actor and reject superseded reader instances (`NFCReader.swift:32-50`).
- Camera generation checks stop late permission grants after teardown; track termination and decoder failures expose retryable states (`camera/controller.ts:20-37,78-127`).
- Background handling deliberately stops capture and requires user-driven Resume; this is **not** an automatic-restart defect (`platform/runtime.ts:214-227`; `machine/reduce-env.ts:32-52,70-76`).
- Capability reporting distinguishes unknown HID connectivity and unavailable Wallet VAS instead of claiming unsupported hardware functionality (`ScannerHardware.swift:18-23`).
- The architecture sensibly reuses web decoding while keeping native permissions, bridge, NFC, and customer-display presentation separate.

## Verification gaps and platform limits

There are no configured native test targets (`ios/project.yml:29-30`). Simulator checks can cover bridge behavior, failed-load Retry, window disposal, rotation, and fold-aware dialog geometry—but **not actual camera/NFC/HID hardware or outer-display activation**.

Apple specifies that the [camera-capture accessory](https://developer.apple.com/documentation/avfoundation/registering-a-camera-capture-accessory-on-iphone-duo) is system-controlled and requires foreground camera capture; its factory and reserved-region APIs require iOS/iPadOS 27.1.

Also verify fold-only posture changes without resizing: Apple documents reserved-region tracking through [`updateConstraints`](https://developer.apple.com/documentation/uikit/uiview/reservedregions(kind:options:)), while this implementation reads regions through controller property/layout updates. This remains **inference requiring runtime evidence**, not a confirmed finding.

**Testing recommendation, not a product defect:** provide a controlled test origin before simulator checks; the shipping controller hardcodes production (`ScannerViewController.swift:8-9`). No production-backed acceptance checks are recommended.
