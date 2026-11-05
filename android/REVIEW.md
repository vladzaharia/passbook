# Release review

Scope: Java Android application, VAS APDUs/TLV parser, web bridge, barcode ingestion and APK packaging.

Security review checks: exact HTTPS origin and main-frame messages; no generic JavaScript interface; no file/content access or cleartext; camera grants scoped to current trusted page; navigation/pause invalidates pending acceptance; unknown/expired/duplicate results refused; local diagnostics cannot accept; no private keys, scan logs or demo credentials shipped; cloud/device transfer excluded.

Protocol review checks: VAS applet selection, ApplePay provider/version checks, VAS-only requests, correct last-profile continuation, fresh request nonce, bounded frame/TLV lengths, duplicate required fields refused, authentication statuses preserved, cryptogram retained without local decryption, NFC connection closed after reads and on pause.

Validation: 11 Java unit tests passed, including 10,000 malformed TLV inputs; 3 web-adapter tests passed; 3 Android 14 emulator tests passed through the real WebView/native bridge, including keyboard+Enter input and frame/origin rejection. Android lint passed with warnings treated as errors. Unit tests use synthetic APDU fixtures. They do not claim certification or validate NFC radio behavior. Physical acceptance remains open in ACCEPTANCE.md.

Repository verification: all 2,632 platform tests, typechecking, rules and build passed. `npm run check` stops at three pre-existing formatting errors in untracked `.omc/` JSON files. Android assets pass Biome separately. Those unrelated files were left unchanged.

Review fixes: bounded TLV lengths and duplicate-tag checks; corrected final-profile continuation flag; cancellation generation checks and closing active NFC connections; camera-only grants; read-only local diagnostics; timeout/late-result rejection; excluded backup/transfer of WebView sessions; checksummed Gradle distribution; dedicated release signing identity.

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
