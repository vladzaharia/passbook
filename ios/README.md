# iOS scanner

Native iPhone/iPad shell for the shared `/scan` web application. Camera decoding remains in the web scanner; native code supplies permission/lifecycle handling, NDEF text/URI reads, and a versioned bridge. iOS does not expose reliable generic HID keyboard connection state; wedge data is handled by the web scanner.

## Build and run

Requires current Xcode and XcodeGen. iOS 27.1+ SDK APIs are needed for planned iPhone Duo support.

```sh
cd ios
xcodegen generate
xcodebuild -project PassBookScanner.xcodeproj -scheme PassBookScanner \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO build
```

Set the development team and bundle identifier in Xcode before signing on a device. Run on a physical device to validate camera, NFC, keyboard, and iPhone Duo display behavior; the simulator does not provide a camera or NFC reader.

## Hardware limits

- Camera: WKWebView uses the existing `getUserMedia` scanner. Native code grants capture only to the trusted `https://passbook.mobile` main frame while foregrounded.
- Reader: USB/Bluetooth HID keyboard wedges are handled by iOS and received by the web scanner. iOS does not expose generic HID presence; this app does not claim generic USB serial, Bluetooth SPP, or ExternalAccessory access.
- NFC: this build reads user-started NDEF text/URI tags only. It does not read Apple Wallet passes. Apple documents Wallet VAS reading through ProximityReader/Tap to Pay with the required entitlement and PSP token; server-side verification is also needed before accepting a pass.
- iPhone Duo: reserved-region and outside-display support is planned for iOS 27.1+ and requires physical-device validation. The current shell uses one web view and does not yet implement Duo panes or an outside display.

See `PassBookScanner/PassBookScanner.entitlements` and `PassBookScanner/Info.plist` for the NDEF entitlement and privacy descriptions. Wallet VAS support remains blocked on Apple reader entitlement, PSP integration, and server-side verification.
