# Physical P400 acceptance

Run before calling this release production-ready. Emulator tests cannot establish these results.

- Record P400 model, firmware, Android build, NFC controller if available, WebView version, iOS/watchOS versions, pass type and app version.
- Enable NFC. Confirm an ISO-DEP tag/Wallet device can connect through Android reader mode.
- Use an NFC-enabled pass for your configured Pass Type ID. Test wrong ID, no matching pass, authentication required, and NFC-disabled pass.
- Test manual Wallet selection, authenticated payment-card presentation, and locked/unlocked iPhones. Record exactly which flows work. No ECP automatic presentation is promised.
- Test Apple Watch independently on current watchOS. Do not infer compatibility from iPhone results.
- Verify backend decryption with your VAS key, credential lookup, wrong key, expired/voided passes, wrong tenant and already-used credentials.
- Hold a device in the field, retap, scan twice rapidly, tap two different passes, remove the phone mid-read, pause/resume, lock/unlock the P400 and navigate during a request. No stale result may grant acceptance.
- Disconnect Wi-Fi, restart the verifier, return HTTP errors, delay results beyond 15 seconds and send malformed results. Each must remain unverified or show an error.
- Scan printed and on-screen QR/Code128 barcodes with leading zeroes. Test BCScan keyboard+Enter and the firmware's documented broadcast mode. Compare exact values against the camera flow.
- Test real operator sign-in, session expiry and camera permission. Confirm the reader reconnects after login redirects.
- Run at least 100 mixed scans at the intended venue, recording successful reads, time to decision and retries without recording credentials.
- Install the signed APK over the prior signed version to verify updates preserve settings. Protect the signing key and test operator offboarding/device revocation on the backend.

Optional diagnostics when the device is attached:

```sh
adb devices -l
adb shell getprop ro.build.version.release
adb shell pm list features
adb shell dumpsys nfc
adb shell dumpsys webviewupdate
```
