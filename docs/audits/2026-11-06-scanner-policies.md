# Scanner policies, sessions and member photos — 2026-11-06

## Behavior

Pass and scanner settings support single-use, daily, unlimited and in/out admission,
event restrictions, admission dates, and duration from issue or first successful scan.
Explicit restrictions combine; a scanner supplies the admission type when the pass leaves
it unspecified. Daily limits can coexist with in/out tracking. Exits remain possible after
an admission window closes. Event re-entry restrictions, capacity and admission transitions
are enforced in the database, including simultaneous scans and undo.

Admin-created setups support scanners, customer screens and desk monitors. Each paired
screen follows selected scanners; monitors can follow an organization. Scan as Admin is an
explicit alternative to pairing and creates or reuses a managed setup for the user,
organization and mode. Admin sessions have no pairing credentials.

Member photos appear in authorized results and monitors. Wallet inclusion is an explicit
option for generic passes and event tickets without strip images. A photo replaces the
thumbnail during the normal signed build; disabling it restores the original asset.
Upload re-encodes and crops in the browser; the API validates the square PNG and removes
ancillary metadata. Failed publishing restores previous photo settings.

Operator instructions: [Scanning](../operations-scanning.md).

## Data and access

- `0021_scan_member_photos.sql`: private R2 photo metadata and Wallet inclusion.
- `0022_scan_check_in.sql`: per-pass policies and durable admission state. Backfill keeps
  previous usage after old scan history is pruned. Existing untracked visits do not invent
  an inside state when an operator enables in/out tracking.
- `0023_scan_setups.sql`: managed session ownership and screen subscriptions.
- The frozen scanner contract changes were reviewed separately in
  [PR #9](https://github.com/vladzaharia/passbook/pull/9).
- Member image requests require current authorization and short-lived, recipient-bound
  grants. Tenant, mode, template role and scanner photo settings apply to each request.
- The live hub uses SQLite Durable Objects and hibernating WebSockets. It keeps at most
  100 rows for 15 minutes. Credentials and setup revisions are rechecked before delivery.
  Revocation or configuration changes clear the view before reconnecting.
- Customer payloads omit member names, photos, pass IDs and scanner names, ignore manual
  lookup results, and do not replay an old customer's verdict on reconnect.
- Monitors use the public pass title rather than the source scanner's staff-only fields.
  Screen sessions omit staff lists, staff bindings and source template/event details.

The integration touches Worker wiring, generated bindings and Wrangler configuration.
Shared web changes add audit labels and optional time-zone formatting. Existing migration
`0014_scan.sql` and the template display-builder port remain unchanged.

## Verification

`npm run check` passed with 4,709 tests in 420 files, type checks, SQL ownership, file-size
and unused-code rules, lint, generated files, production build and Worker deployment dry run.
Initial gzip sizes are 239,934 bytes for the main app and 146,510 for the scanner, within
the existing budgets. A policy check-in with a photo uses five database round trips after
authentication.

Worker tests cover cross-device single-use limits, time zones, duration anchors, expiry,
in/out, no re-entry, capacity and transition races, undo, idempotent replay, retained usage,
and execution of the actual legacy-data migration. Photo tests inspect the signed Wallet
archive, thumbnail restoration, rollback, metadata removal, grants and role/mode isolation.
Live-view tests use the real Durable Object RPC and WebSockets, including replacement
credentials, revocation, source filtering, tenant isolation and customer redaction.

The unchanged Android host passed unit tests, bridge tests, lint and debug assembly.
[Reader 0.2.2](https://github.com/vladzaharia/passbook/releases/tag/android-v0.2.2) loads the
updated hosted verifier after a reload; these features require no native package change.

Camera methodology and physical-device limits are recorded in the
[camera audit](2026-11-06-scanner-camera.md). Browser-engine tests and an Android emulator
do not establish autofocus, glare or permission behavior on every physical device.
