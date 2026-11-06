# Scanner M1 integration

Integrated from `next/integration` and `next/n8-{pt,sv,sc,ds,cc,ui,bu,ad}` on 2026-11-05.
Android came from `feat/p400-android-reader` (`9a7016e0`, `ae987f98`). The source worktrees and their uncommitted work were preserved.

## Use

1. Clone a starter template into the organization, then issue passes from it.
2. In Admin → Scanning, create a scanner accepting those templates or an event.
3. Open the pairing link on the scanning device and confirm the organization and scanner name.
4. Tap Start. Use the camera, a keyboard barcode reader, Type a code, or Look up.
5. Review the server result. Undo is available on Recent and in the console scan log.

For Android, install the signed APK from [GitHub Releases](https://github.com/vladzaharia/passbook/releases).
Set its verifier URL to the installation's HTTPS origin followed by `/scan`, pair, then tap Start.
New installs default to `https://passbook.mobile/scan`; existing installs preserve their URL.
Use BCScan keyboard output with Enter or configure the device's documented broadcast action.

`SCAN_ENABLED` is enabled in the committed configuration. The existing installation still needs an owner deployment.
No remote migrations or Worker deployment were run during this integration.

## Included

- Scanner CRUD, pairing, scope and live/test isolation.
- Check-in with idempotency, atomic first-scan and capacity gates, duplicate suppression and counters.
- Server-rendered template displays, role-filtered bindings, visit history and default displays.
- Prefix/exact-email lookup, masked addresses, rate limits and query-free audit records.
- Atomic check-in undo through device and console APIs; audit and pass ledger commit with it.
- Camera decoding in a worker using self-hosted zxing wasm, keyboard input and the Android bridge.
- Unconfirmed-request persistence, scope clearing, revocation handling, and camera lifecycle.
- Console scanner pages, event creation/detail/archive and the scan log with undo.
- Android builds on GitHub and signed pilot APK releases from `android-v<versionName>` tags on main.

Shared integration fixes include `validityOf`, the lightweight Test label, audit vocabulary,
scanner entry code splitting, decoder prebundling and the NFC import rejection assertion.
No new database migration was needed. `0014_scan.sql` is the existing Phase 0 migration.

## Validation

Worker regression coverage includes capacity races across different passes, concurrent undo,
idempotent undo replay, mode isolation, email masking and daylight-saving midnight boundaries.
Browser coverage pairs an unauthenticated device, scans through the Android bridge, checks
server acceptance and duplicate protection, undoes the scan, and decodes a real QR frame in wasm.
Android unit tests, lint and signed assembly pass. APK updates use the original pilot signing identity.

## Remaining milestones and device checks

M1 is the door software milestone. Value actions and staff sign-in/admin are M2; live displays,
occupancy, access plans and NFC backend verification belong to later scanner milestones.
Those unfinished streams and the separate Blueprints worktrees were not represented as complete.
Encrypted Apple VAS reads receive an error acknowledgement and direct the operator to the barcode.
The APK remains a pilot: physical P400 RF behavior, venue glare, Safari/home-screen and accessibility
assistive-technology checks still need the devices described in `scanner-plan.md` and `android/ACCEPTANCE.md`.

Before public publication, Gitleaks scanned all reachable integration history. Its reviewed
findings were throwaway test keys, a public NFC fixture and false positives; exact fingerprints
are recorded in `.gitleaksignore`. Signing keys and passwords remain ignored locally and are
configured only as encrypted GitHub Actions secrets.
