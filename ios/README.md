# iOS scanner

Native iPhone/iPad shell for the shared `/scan` web application. Camera decoding remains in the web scanner; native code supplies camera permission/lifecycle handling, HID wedge input reporting, an NDEF tag-read bridge, Duo posture geometry, and an optional camera-capture customer display.

## Build and run

Requires current Xcode and XcodeGen. The app targets iOS 17; iOS 27.1+ is required for iPhone Duo reserved-region and camera-capture accessory APIs.

```sh
cd ios
xcodegen generate
xcodebuild -project PassBookScanner.xcodeproj -scheme PassBookScanner \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO build
```

Signed device builds need provisioning for `mobile.passbook.scanner` and your Apple Developer team. Run on physical iPhone/iPad devices to validate camera, NFC and keyboard behavior. Validate Duo folding, hinge-safe layout and outside customer display on iPhone Duo; the outside display is system-managed and only appears when it is available during active camera capture. Simulator has no camera and cannot verify this flow.

If the startup network load fails, tap **Retry**; the error overlay clears after the scanner page loads.

## TestFlight

One-time setup, by the Account Holder (team `48H7CLBV8Y`):

1. Register the App ID `mobile.passbook.scanner` (Certificates, Identifiers & Profiles) with **NFC Tag Reading**.
2. Create the App Store Connect app record: My Apps, **+**, New App, iOS, bundle ID `mobile.passbook.scanner`.
3. Create an **Admin** team API key (Users and Access, Integrations, App Store Connect API). Admin lets Xcode create the
   distribution certificate and profiles. Keep the `.p8` out of the repo.
4. Create the `iOS TestFlight` GitHub environment with required reviewers. Add secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`,
   `ASC_KEY_P8_BASE64` (`base64 -i AuthKey_XXXX.p8`). Add repository variable `APPLE_TEAM_ID`; optionally
   `PASSBOOK_TESTFLIGHT_GROUP`, `PASSBOOK_BUILD_NUMBER_OFFSET` (default 1000) and `PASSBOOK_RELEASE_XCODE_BUILD`.
5. Create an internal TestFlight group on the app record.

Run **Actions, iOS TestFlight** from `main` with the marketing version (X.Y.Z). It runs `npm run check` and the E2E
suite, then archives with cloud-managed signing, checks the archive, uploads, waits for processing, sets What to Test
and adds the build to the group. The build number is the run number plus the offset (`.N` on re-runs); a re-run after
a completed upload skips the upload. External testers need Beta App Review.

Scripts in `ios/scripts/` (no fastlane): `build.sh` (xcodegen, archive, export), `check-archive.sh`, `version.sh`,
`secrets.sh` (key file for one command), `asc-jwt.sh` and `asc-testflight.sh` (App Store Connect API),
`select-xcode.sh`, `install-xcodegen.sh`. Local check without signing:

    APPLE_TEAM_ID=48H7CLBV8Y ios/scripts/build.sh --archive --no-sign --marketing-version 1.0.0 --build-number 1
    ios/scripts/check-archive.sh ios/build/PassBookScanner.xcarchive

`build.sh` refuses the API key outside the workflow, so only the pipeline passes `-allowProvisioningUpdates`.

## Hardware limits

- Camera: WKWebView uses the existing `getUserMedia` scanner. Native code grants capture only to the trusted `https://passbook.mobile` main frame while foregrounded.
- Reader: USB/Bluetooth HID keyboard wedges are handled by iOS and received by the web scanner. iOS does not expose generic HID presence; this app does not claim generic USB serial, Bluetooth SPP, or ExternalAccessory access.
- Tags (bridge wire v2): the desk **Tap to read** button sends `tagRead`. The app opens one `NFCTagReaderSession` (ISO 14443) and reports UID, tech, `uidRandom` and the first NDEF text or URI record as an `nfc-tag` scan. One sheet per read, at most 60 s, no continuous reading: iPhone and iPad are desk readers, not door readers. MIFARE and ISO 7816 tags only. See `android/BRIDGE.md`.
- NFC: Core NFC reads user-started NDEF text/URI tags, but the current scanner UI does not expose an NDEF action and this does not read Apple Wallet passes. Apple documents Wallet VAS reading through ProximityReader/Tap to Pay with the required entitlement and PSP token; server-side verification is also needed before accepting a pass.
- iPhone Duo: UIKit preserves active and inactive reserved-region geometry. The inside keeps the camera and actionable Operator pane separate. The outside camera-capture accessory loads `/scan?customer-display=1` and shows the shared Buddy, generic status, and display-only org name/accent/logo hash. Only display branding and status cross the customer-display bridge; pass/person data and credentials do not. The logo uses the authenticated scan endpoint and falls back to the org initial if unavailable.

See `PassBookScanner/PassBookScanner.entitlements` and `PassBookScanner/Info.plist` for the NDEF entitlement and privacy descriptions. Wallet VAS support remains blocked on Apple reader entitlement, PSP integration, and server-side verification.

## Owner checklist: tag reading

1. Certificates, Identifiers & Profiles: open App ID `mobile.passbook.scanner` and enable **NFC Tag Reading** (the TAG format).
2. Regenerate the provisioning profile. TestFlight's cloud-managed signing does it on the next run; for a local device build, download the new profile.
3. Install on a physical iPhone and run the device checks:
   - UID-only tag (MIFARE Classic or Ultralight): Tap to read returns the UID.
   - NDEF tag (NTAG21x, URL or text): returns the UID and the record.
   - DESFire or NTAG 424 tag: confirm whether it reads as MIFARE or ISO 7816 (the AID `D2760000850101` is in Info.plist).
   - Two tags together: the sheet says "Hold one tag".
   - A card Core NFC cannot read (ISO 15693, FeliCa) is not detected; an unsupported ISO 14443 card shows "not supported".
   - Cancel the sheet, let it time out, and background the app mid-read: the scanner page shows no stale pending read.
   - Random-ID tag (first byte `08`): `uidRandom` is true and the server refuses it.
4. Run `ios/scripts/check-archive.sh` on the signed archive; it checks the NDEF and TAG entitlements.

Unit tests need no device:

    xcodebuild test -project PassBookScanner.xcodeproj -scheme PassBookScanner \
      -destination 'platform=iOS Simulator,name=iPhone 18 Pro' CODE_SIGNING_ALLOWED=NO
