# iOS/iPadOS Scanner Audit

**Scope:** `/private/tmp/wallet-ios-scanner`, supplied revision `0458552`. Paths below are worktree-relative.

Reviewed all five Swift files, Info.plist, entitlements, project/generator settings, archive scheme, TestFlight workflow, iOS README, and connected web bridge, session, storage, camera and update-recovery code. Read-only; no builds, tests, signing operations, production calls or secret-value reads.

## Findings

### 1. P1 — App-bound configuration omits the privileged-WebView opt-in
**Confidence: inference**

**Evidence:** `ios/PassBookScanner/Info.plist:20`; `ios/PassBookScanner/ScannerViewController.swift:20-30,180-187`.

`WKAppBoundDomains` is declared, but `limitsNavigationsToAppBoundDomains` is never enabled. Under WebKit’s documented [App-Bound Domains rules](https://webkit.org/blog/10882/app-bound-domains/), this configuration restricts script injection/message-handler use—the mechanisms supplying `PassBookNative` and native capabilities. Rendering `/scan` therefore does not establish that its native bridge works.

**Fix:** Opt the privileged scanner WebView into app-bound navigation; keep necessary off-domain authentication separate.

**Acceptance:** On a signed device build, observe `hello → capabilities → start`, then a genuine bridge read/result. Off-domain redirects must not inherit bridge access.

### 2. P2 — Customer display cannot receive normal camera/HID verdicts
**Confidence: confirmed-source**

**Evidence:** `src/web/scan/input/native-reader.ts:56-78`; `src/web/scan/platform/runtime.ts:106-110,202-208,251-259`; `ios/PassBookScanner/ScannerViewController.swift:144-176`.

The adapter sends a result only when its input ID matches a pending **native-origin** scan. Camera decoding and HID wedges originate in JavaScript and never create that pending correlation. Native customer-display status changes depend on that correlation, so ordinary supported scans leave the customer screen at **Ready**, despite a server verdict.

**Fix:** Correlate customer-display lifecycle events for every input source, retaining server-verdict-only acceptance and stale-result rejection.

**Acceptance:** Camera and USB/Bluetooth HID scans visibly progress through checking and the matching accepted/rejected state; timeout or unrelated responses never display acceptance.

### 3. P2 — Closing an iPad scanner window leaks its WebView/controller
**Confidence: confirmed-source**

**Evidence:** `ios/PassBookScanner/ScannerViewController.swift:7,20-30`; `ios/PassBookScanner/AppDelegate.swift:15-21`; `ios/PassBookScanner/Info.plist:18`.

`WKUserContentController` retains its script-message handler. Registering `self` creates a controller → WebView → content-controller → controller cycle. No handler removal or explicit scene teardown breaks it. Multiple scenes are enabled, making repeated window creation/dismissal a credible resource-exhaustion path.

**Fix:** Use a weak message-handler intermediary or explicit scene shutdown that removes the handler and releases hardware/accessory resources. Cleanup solely in `deinit` cannot break this cycle.

**Acceptance:** Repeatedly open and dismiss scanner windows; dismissed controllers/WebViews deallocate, registrations disappear, and retained memory does not grow per window.

### 4. P2 — Renderer termination has no recoverable native UI
**Confidence: inference**

**Evidence:** `ios/PassBookScanner/ScannerViewController.swift:215-225,227-261`.

Recovery handles navigation failures only; there is no `webViewWebContentProcessDidTerminate` handler. WebKit renderer termination, including memory-pressure termination during camera use, therefore has no implemented reload/error-overlay path. The scanner can remain unusable until externally restarted.

**Fix:** Handle renderer termination by cancelling pending native work and exposing native retry/reload recovery.

**Acceptance:** Terminate the renderer while idle and while checking. Recovery must work without force-quitting, falsely acknowledging a scan, or blindly repeating a possibly committed admission.

### 5. P2 — Revocation discovered during bootstrap bypasses durable-data cleanup
**Confidence: confirmed-source**

**Evidence:** `src/web/scan/boot/use-scan-session.ts:105-126`; `src/web/scan/scan-app.tsx:88,143-149,185-190`; `src/web/scan/platform/runtime.ts:287-294`; `src/web/scan/offline/unsure-store.ts:24-30,38-55`; `src/web/scan/machine/ports.ts:26-30`.

Uncertain scans persist raw codes/action data in IndexedDB. If the app closes and its scanner is subsequently revoked, reopening produces the blocked bootstrap view without creating the runtime that hydrates/prunes those records. Runtime disposal only closes the database. The nominal twelve-hour retention is consequently not an expiry guarantee.

**Counter-control:** Machine-level revocation does wipe data; stored retries strip manager PINs (`machine/commands.ts:27-31,130-145`). This is a retention defect, not demonstrated remote exfiltration.

**Fix:** Perform revocation cleanup at the session boundary, independently of runtime creation.

**Acceptance:** Create an uncertain scan, close the app, revoke it, then reopen online. Durable scan stores must be empty while the blocked screen remains displayed.

## Controls and useful negative evidence

- Bridge messages require HTTPS, the trusted hostname and main frame; version/body bounds and JSON serialization limit malformed-input exposure. Camera permission also checks foreground state and denies microphone requests.
- No ATS exceptions, certificate-trust bypass or release-enabled Web Inspector were observed. Host checks do not constitute a complete scheme/host/port comparison.
- The shell uses persistent WebKit storage, **not Keychain**. Scanner cookies are Secure/HttpOnly/Strict (`src/worker/modules/scan/routes-pair.ts:22-29`); CSRF is memory-only (`boot/use-scan-session.ts:18-25`).
- TestFlight upload is main-only, follows validation, references an environment, uses pinned actions, and restricts/cleans temporary key files (`.github/workflows/ios-testflight.yml:16-51,63-76`). Configured environment reviewers and runner isolation were not observable.
- Deployment chunk failures have a one-reload mechanism (`src/web/lib/chunk-reload.ts:7-26`). This does not address native renderer termination.

## Platform/compliance limits and recommendations — not additional confirmed bugs

Primary references below were **not fetched live**; platform-policy conclusions are **[INFERENCE]** pending current Apple documentation/approval.

- [Core NFC](https://developer.apple.com/documentation/corenfc) NDEF reading is not Wallet VAS verification. The entitlement permits NDEF only; hardware availability is checked. The README explicitly acknowledges no current NDEF UI action.
- [ProximityReader](https://developer.apple.com/documentation/proximityreader) / [Tap to Pay](https://developer.apple.com/tap-to-pay/) requires supported hardware/territory, Apple entitlement, provider integration and verification. `PaymentCardReader.isSupported` is not authorization. Correctly, VAS availability remains false and raw VAS input is rejected.
- No universal-link entitlement/custom URL scheme was observed: pairing links cannot presently be assumed to open/pair this app.
- [App Review guidelines](https://developer.apple.com/app-store/review/guidelines/) §4.2 eligibility and privacy disclosures need review; a wrapper is not automatically rejected. No privacy manifest was found, but no native required-reason API usage was identified.
- [TestFlight](https://developer.apple.com/testflight/) builds expire after 90 days; production deployment needs an appropriate durable distribution channel.

**Coverage limitations:** No signed artifact, provisioning approval, upload/processing evidence or hardware results were available. Parent verification should include permission denial/regrant, backgrounding, multiwindow operation, customer-screen privacy, and the guarded iOS 27.1 APIs. No direct cross-origin disclosure path was established.
