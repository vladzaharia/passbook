# PassBook Reader 0.2.3

- Shared scanning sessions pair multiple scanners and displays under one admission policy.
- Scanner, camera-free Operator, Desk and Customer layouts adapt to phones, tablets and computers.
- Administrators join as devices; session and device settings update while scanning stays started.
- Camera decoding covers the whole frame, including its edges; aiming marks are only a guide.
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
