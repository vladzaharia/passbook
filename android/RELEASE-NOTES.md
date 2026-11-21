# PassBook Reader 0.2.4

- A scan no longer blocks the next one while staff review the first: the page acknowledges receipt (`scanAck`, additive, still bridge v2) and the reader frees its gate on that. An older page keeps the old behaviour. Update the reader and the web together.
- Links off PassBook hosts open in the browser; the reader stays on the verifier.
- Settings open on press and hold. Switching to another verifier asks first, naming it, and clears this device's sign-in and pairing.
- Scan broadcasts are rate limited. Zebra profile version 2 turns keystroke output off so a scan is not delivered twice.
- Rotating the device or attaching a keyboard scanner no longer reloads the scanner.
- A crashed WebView renderer rebuilds the verifier instead of closing the app; repeated crashes show Reload.
- Android below 14 no longer reports built-in keys and scan engines as an attached keyboard. Hardware ids stay stable across reconnects.
- Saved settings a newer rule rejects reset to defaults instead of crashing on launch.
- Release builds are shrunk with R8.

## 0.2.3

- Shared scanning sessions pair multiple scanners and displays under one admission policy.
- Scanner, camera-free Operator, Desk and Customer layouts adapt to phones, tablets and computers.
- Administrators join as devices; session and device settings update while scanning stays started.
- Camera decoding covers the whole frame, including its edges; aiming marks are only a guide.
- Hardware enumeration reports cameras, NFC, scanners and input devices. The manifest declares BLUETOOTH_CONNECT (never requested; used only if device policy grants it). Ship after the web schema accepts `hardware`.
- Keyboard and Android barcode inputs retain the same configured automatic or review flow.


- Camera access survives the first Android permission dialog and grants only in the foreground.
- Navigation and browser cancellation revoke pending camera requests.
- Hosted scanning now supports eight camera barcode formats, recovery and background/resume.
- Opens the PassBook scanner at `https://passbook.mobile/scan` by default.
- Pair in Admin → Scanning, tap Start, then scan hardware barcodes.
- Barcode acceptance uses the server check-in rules, duplicate protection and undo.
- NFC captures encrypted Apple VAS data; server verification is unavailable. Use the barcode.
- GitHub SDK setup explicitly installs the supported platform tools.
- Signed APKs, SHA-256 checksums and certificate fingerprints are attached to this GitHub pilot release.
- Uses the original pilot signing identity so 0.1.0 installs can update in place.

Physical P400 RF and venue acceptance checks remain required; see `android/ACCEPTANCE.md`.
