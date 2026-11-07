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

Before the first upload, the Account Holder must register `mobile.passbook.scanner`, enable **NFC Tag Reading** for its App ID, and create the matching App Store Connect app record.

Create a GitHub environment named `iOS TestFlight` with required reviewers. Set `APPLE_TEAM_ID` as a repository variable, and add `ASC_KEY_ID`, `ASC_ISSUER_ID`, and base64-encoded `ASC_KEY_P8_BASE64` as environment secrets. Use an **Admin** App Store Connect team key so Xcode can manage signing profiles. Never commit the `.p8` file.

Run **Actions → iOS TestFlight** from `main` and enter the marketing version. The workflow runs `npm run check` and the browser E2E suite, archives with automatic signing, and uploads the build. After processing, add it to an internal TestFlight group; external testers require Beta App Review.

## Hardware limits

- Camera: WKWebView uses the existing `getUserMedia` scanner. Native code grants capture only to the trusted `https://passbook.mobile` main frame while foregrounded.
- Reader: USB/Bluetooth HID keyboard wedges are handled by iOS and received by the web scanner. iOS does not expose generic HID presence; this app does not claim generic USB serial, Bluetooth SPP, or ExternalAccessory access.
- NFC: Core NFC reads user-started NDEF text/URI tags, but the current scanner UI does not expose an NDEF action and this does not read Apple Wallet passes. Apple documents Wallet VAS reading through ProximityReader/Tap to Pay with the required entitlement and PSP token; server-side verification is also needed before accepting a pass.
- iPhone Duo: the app uses UIKit reserved-region geometry to split the single web scanner into scan and desk panes, keeping the hinge clear. The outside customer screen uses a camera-capture scene accessory; the system controls availability and may withdraw it at any time.

See `PassBookScanner/PassBookScanner.entitlements` and `PassBookScanner/Info.plist` for the NDEF entitlement and privacy descriptions. Wallet VAS support remains blocked on Apple reader entitlement, PSP integration, and server-side verification.
