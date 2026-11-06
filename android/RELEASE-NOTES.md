# PassBook Reader 0.2.0

- Opens the PassBook scanner at `https://passbook.mobile/scan` by default.
- Pair in Admin → Scanning, tap Start, then scan hardware barcodes.
- Barcode acceptance uses the server check-in rules, duplicate protection and undo.
- NFC captures encrypted Apple VAS data; server verification is unavailable. Use the barcode.
- Signed APKs, SHA-256 checksums and certificate fingerprints are attached to this GitHub pilot release.
- Uses the original pilot signing identity so 0.1.0 installs can update in place.

Physical P400 RF and venue acceptance checks remain required; see `android/ACCEPTANCE.md`.
