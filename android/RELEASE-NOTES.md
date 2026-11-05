# PassBook Reader 0.1.0 — P400 pilot

- Native Android app, minimum Android 8, target Android 15/API 35.
- Apple VAS-only NFC reads using configured Pass Type IDs; encrypted data forwarded to a web verifier.
- P400 keyboard+Enter barcode input and configurable scanner broadcasts.
- Origin-restricted WebView bridge, camera permission support and native decision feedback.
- Standalone reader diagnostics that never grants acceptance.
- Signed, installable APK with signature report and SHA-256 checksum.

This is a pilot release. P400 RF compatibility, current iPhone/Watch behavior and a live verifier integration have not been validated. The verifier page/API is absent from this checkout. Automatic pass presentation/ECP, Google Smart Tap and offline acceptance are not implemented.

The local release package is in `android/dist/`. No remote release destination is configured.
