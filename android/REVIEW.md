# Release review

Scope: Java Android application, VAS APDUs/TLV parser, web bridge, barcode ingestion and APK packaging.

Security review checks: exact HTTPS origin and main-frame messages; no generic JavaScript interface; no file/content access or cleartext; camera grants scoped to current trusted page; navigation/pause invalidates pending acceptance; unknown/expired/duplicate results refused; local diagnostics cannot accept; no private keys, scan logs or demo credentials shipped; cloud/device transfer excluded.

Protocol review checks: VAS applet selection, ApplePay provider/version checks, VAS-only requests, correct last-profile continuation, fresh request nonce, bounded frame/TLV lengths, duplicate required fields refused, authentication statuses preserved, cryptogram retained without local decryption, NFC connection closed after reads and on pause.

Validation: 11 Java unit tests passed, including 10,000 malformed TLV inputs; 3 web-adapter tests passed; 4 instrumented tests passed on each of Android 13 and Android 14 at 480×800. These exercise the real WebView/native bridge, keyboard+Enter input, frame/origin rejection and a trusted verifier acceptance round trip. Android lint passed with warnings treated as errors. The signed release APK was installed, launched and smoke-tested with barcode input on the emulator. Unit tests use synthetic APDU fixtures. They do not claim certification or validate NFC radio behavior. Physical acceptance remains open in ACCEPTANCE.md.

Repository verification: the complete `npm run check` passed in an isolated clean worktree, including 231 test files / 2,632 tests, Biome, typechecking, rules and build. In the original checkout, three pre-existing formatting errors in untracked `.omc/` JSON files block that command; those unrelated files were left unchanged. Android assets also pass Biome separately.

Review fixes: bounded TLV lengths and duplicate-tag checks; corrected final-profile continuation flag; cancellation generation checks and closing active NFC connections; camera-only grants; read-only local diagnostics; timeout/late-result rejection and cancellation events; binary bridge messages refused; explicit hardware Enter handling; acceptance color cleared on state changes; excluded backup/transfer of WebView sessions; checksummed Gradle distribution; dedicated release signing identity.

Known integration gap: the repository has no web verifier/API. BRIDGE.md specifies the contract; actual operator login and backend decryption/authorization must be exercised with that implementation.

Research sources:

- https://github.com/kormax/android-universal-reader/tree/8a4c887d068abe0de9ec81fd35446d01caac275c
- https://github.com/kormax/apple-vas
- https://github.com/kormax/apple-enhanced-contactless-polling
- https://tera-digital.com/products/android-13-barcode-scanner-pda-p400
- https://tera-digital.com/pages/user-manual
- https://developer.android.com/reference/android/nfc/NfcAdapter
- https://developer.android.com/reference/android/nfc/tech/IsoDep
- https://developer.android.com/reference/androidx/webkit/WebViewCompat
- https://developer.android.com/tools/apksigner
