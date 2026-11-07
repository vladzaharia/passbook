# PassBook Reader for P400

Android app for NFC-enabled Apple Wallet passes and P400 hardware barcodes. Hosts an HTTPS web verifier and forwards scans through an origin-restricted bridge. NFC reads return encrypted VAS data; decrypt and decide acceptance on your backend.

The app opens `https://passbook.mobile/scan`. Pair it in Admin → Scanning, tap Start, and scan barcodes through the same check-in and undo rules as the web scanner. Apple VAS cryptograms remain unverified; use the barcode. The bundled diagnostics never marks a pass accepted.

## Install

Install `dist/passbook-reader-0.2.3.apk` on the P400. Allow this installation source when Android asks, or use:

```sh
adb install -r android/dist/passbook-reader-0.2.3.apk
adb shell am start -n im.plrs.passbook.reader/.MainActivity
```

Verify `dist/SHA256SUMS` and `dist/signature.txt` before distributing. Debug and release builds have separate application IDs and settings.

## Set up

1. Enable NFC in Android Settings.
2. In Reader Settings, enter your Apple Pass Type ID. The default is `pass.im.plrs.wallet`; change it to match your pass. Up to eight IDs are supported.
3. Leave the verifier URL empty to test diagnostics. Open and authenticate the NFC pass in Wallet, then hold the phone against the **back** of the P400.
4. Set the verifier URL to your PassBook HTTPS origin followed by `/scan`. Pair this browser using the code from Admin → Scanning. Tap Start before scanning.
5. For hardware barcodes, configure BCScan for keyboard output with Enter as its suffix, tap **Scan barcode here**, and use a scan button. If your firmware provides broadcast output, enter its documented action and text extra in Reader Settings instead.

The exact BCScan broadcast action is firmware-specific and is intentionally not guessed. Test barcodes from an iPhone display as well as printed ones. Codes retain leading zeroes. Camera fallback can run inside the web verifier after granting camera permission.

Bluetooth scanners work in HID/keyboard mode: pair in Android Settings, choose a US keyboard
layout and Enter suffix, then focus **Scan barcode here**. USB HID readers use the same field.
Scanned codes and IDs follow the setup's automatic/review setting. Name and email searches
in **Look up** require an explicit **Check in**. Serial/SPP or proprietary BLE output needs a
model-specific integration. The app's keyboard path does not open a raw Bluetooth connection.

## NFC limits

The P400 documents ISO 14443 A/B, but real-device ISO-DEP and VAS compatibility still require [acceptance testing](ACCEPTANCE.md). No ECP support is claimed. Expect manual Wallet selection/authentication; Apple Watch behavior varies. This is an uncertified VAS reader implementation, based on Kormax's research, with no payment transaction support. Passes still need Apple's NFC entitlement and matching encryption configuration.

The app never stores a VAS private key. It does not implement Google Smart Tap, offline verification, or a Famoco LED API. Feedback uses the screen and vibration where available.

## Build and test

Requires JDK 17–21, Android SDK platform/build-tools 35, and Node 24+. Set `JAVA_HOME` and `ANDROID_HOME`. On macOS, Android Studio includes a usable JDK at `/Applications/Android Studio.app/Contents/jbr/Contents/Home`.

```sh
cd android
./gradlew :app:testDebugUnitTest :app:lint :app:assembleDebug
node --test web/reader-client.test.mjs
./gradlew :app:connectedDebugAndroidTest
python3 tools/release.py
```

The connected tests need an emulator/device with a current Android System WebView. They exercise real WebView/native messages and diagnostics, not RF communication. Test the physical device before a venue rollout.

The API 35 toolchain and dependencies are pinned for the P400 pilot. Lint fails on warnings; version-update recommendations and target-version recommendations are excluded from lint and reviewed separately. Gradle wrapper downloads are checksum-verified.

## Signing and updates

`tools/release.py` checks the app, signs with the existing update identity, verifies the release APK and writes checksums. It refuses a missing signing key. It never uploads anything. The signing key and password are under the repository's ignored `.secrets/android-reader/`, mode 700/600. Back them up securely: future updates require this same key and an increased `versionCode`.

GitHub builds debug APKs on Android changes. Tags `android-v<versionName>` from main build signed pilot releases at [GitHub Releases](https://github.com/vladzaharia/passbook/releases). The release job requires `ANDROID_READER_KEYSTORE_B64` and `ANDROID_READER_SIGNING_PASSWORD` repository secrets; it never creates an update key. `dist/` stays ignored.
