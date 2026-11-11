# Android Audit 2 — Platform and Trust Boundaries

## Yield — Inspected boundaries

Read-only review of `android/`: manifest, Gradle configuration and wrapper launchers, native bridge/navigation, broadcasts, camera permissions, storage/backup exclusions, NFC controller and VAS/TLV parser, diagnostics, release tooling, documentation and existing test sources. Also inspected `.github/workflows/android.yml` as the release reference.

**One surviving security finding.** No edits, execution, network calls, secret reads or runtime verification.

## Yield — Findings

### 1. P2 medium — Unauthenticated local broadcasts can inject scans into an authenticated reader

**Confidence:** confirmed-source; downstream check-in impact is conditional on verifier policy.

**Evidence**
- `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:55-59` accepts the configured action and forwards its string extra without authenticating the sender.
- `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:265-268` registers that receiver with `RECEIVER_EXPORTED`, without a sender permission.
- `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:236-251` converts the value into an ordinary native barcode event and delivers it to the connected verifier.

**Execution path and impact:** When broadcast integration is configured, a co-installed application knowing the firmware action/extra can submit a known valid credential while PassBook is foreground and connected. No scanner hardware, user interaction or access to PassBook’s private authentication storage is necessary. The verifier receives the input through its normal authenticated scanner session. **[INFERENCE]** In automatic check-in mode, this can consume someone else’s admission or contaminate attendance records without presenting their barcode.

**Counter-controls:** Broadcast integration is disabled by default. Inputs are bounded and screened for control characters; delivery requires foreground state and a ready trusted page. Pending-scan correlation and duplicate suppression apply. The server must still validate the credential and device authorization: this does **not** establish arbitrary admission or cross-tenant access. `android/BRIDGE.md` explicitly acknowledges broadcasts as untrusted and recommends managed devices.

**Recommendation:** Authenticate the firmware integration using its documented sender permission/authenticated channel. If firmware cannot establish sender identity, restrict this feature to an explicitly managed-app deployment or use a different integration. Merely targeting broadcasts to this package would not authenticate their sender.

**Observable acceptance check—not run:** An unrelated, permissionless application sending the correct action and a valid barcode must produce neither a native scan nor a ledger mutation; the genuine scanner must continue working.

## Yield — Defensive controls and negative evidence

- **Bridge isolation:** `android/app/src/main/java/im/plrs/passbook/reader/WebSurface.java:94-109` requires the configured exact origin, main-frame messages, current trusted top-level URL, string payloads, bounded size and protocol version. No generic `addJavascriptInterface` is used.
- **Navigation/TLS:** `WebSurface.java:42-50,57-78` disables release debugging, file/content access and mixed content; navigation/errors invalidate readiness. `android/app/src/main/AndroidManifest.xml:13` disables cleartext. No custom certificate-error bypass was found. Arbitrary HTTPS navigation is deliberately permitted for identity-provider redirects, but those origins do not gain bridge access.
- **Exported components/app links:** `AndroidManifest.xml:14-20` exports only the launcher activity. No VIEW/BROWSABLE filters, app links, manifest receivers, services or providers are declared. Activity code does not ingest incoming intent URLs/extras.
- **Camera:** `MainActivity.java:274-286` limits requests to video capture and a foreground trusted page. `CameraPermissions.java:26-58` defers pending grants until foreground and rechecks trust. Navigation cancels pending requests.
- **Storage/logging:** Reader configuration uses private preferences (`ReaderConfig.java:54-63`). No production scan-content logging sink was found in the inspected Android sources. `AndroidManifest.xml:10-12`, `res/xml/backup_rules.xml:2-6` and `res/xml/data_extraction_rules.xml:2-15` disable/exclude cloud backup and device transfer of the relevant app data.
- **NFC:** `NfcController.java:66-87,94-109` bounds transceive time, closes connections and rejects stale-generation callbacks. `protocol/BerTlv.java:13-49` bounds frames, checks lengths and rejects duplicate required tags. `protocol/VasReader.java:21-66` checks provider/version, bounds cryptograms and preserves authentication failures. These are parsing controls, **not cryptographic verification**.
- **Release:** CI actions are commit-pinned; signing releases require the tag commit to equal main (`.github/workflows/android.yml:54-60`). Signing material is restored with restrictive permissions and removed afterward (`:73-80,93-95`). The Gradle distribution has a checksum (`android/gradle/wrapper/gradle-wrapper.properties:3-4`).

## Product/release recommendations — not confirmed exploitable bugs

1. **Decide whether Settings is operator configuration or an administrative boundary.** `MainActivity.java:117-122` exposes unrestricted settings; `SettingsDialog.java:31-37` persists any accepted external HTTPS verifier. Someone with interactive access to an unlocked reader can intentionally redirect future barcode/VAS events to their server. This is not an origin-check bypass. For unattended/shared deployments, require an administrative gate or managed verifier allowlist. Acceptance: ordinary operators cannot change the trusted destination.

2. **Enforce signing continuity before publishing.** `android/tools/release.py:34-36,51-56` checks key existence and verifies the resulting APK signature, but does not compare its certificate against an independently pinned update identity. A mistakenly substituted valid key could produce a published APK that existing installations cannot accept as an update. Acceptance: a different valid signing key fails before publication.

3. **Extend dependency-integrity evidence.** Direct dependencies/plugin versions are pinned, but no dependency-verification metadata or lockfiles were found. The distribution checksum does not authenticate the checked-in wrapper JAR or every Maven artifact. No compromised dependency was established.

## Coverage summary and limitations

The inspected boundary has substantial origin, lifecycle, parsing and backup controls; no additional credible bypass survived review.

Existing tests were read, not run. Physical P400 RF behavior, vendor broadcast permissions, WebView camera behavior, OEM backup behavior, merged release manifest, wrapper-JAR provenance and actual APK/update compatibility remain unverified. Local `android/dist/release.json:2-12` describes **0.1.0**, whereas source configuration is **0.2.3**; that stale local artifact does not establish what GitHub currently distributes.

Documented VAS limits remain material: encrypted capture only, no integrated verification, no ECP claim, and Apple entitlement/device acceptance prerequisites—not demonstrated hardware support.
