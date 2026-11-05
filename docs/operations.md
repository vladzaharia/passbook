# Operations

## Local dev

    npm ci
    npm run dev:vars   # fills missing .dev.vars: KEK, mock OIDC, fixture signer, PUBLIC_BASE_URL
    npm run db:local   # apply migrations to the local D1
    npm run dev:oidc   # mock Pocket ID on :5174
    npm run dev        # http://localhost:5173

- `dev:vars` never overwrites. An old `PUBLIC_BASE_URL` on another port must be edited by hand.
- Local dev has no APNs binding and no Analytics SQL binding: push is "unavailable", charts read D1.
- Email asset URLs write `@` as `%40`; dev decodes it for files in `public/` (`vite.config.ts`),
  as production's static assets do.
- Real Pass Type ID certificate: `P12_PASSWORD=… npm run credentials -- Pass.p12` writes
  `.secrets/platform-{certificate,key}.pem` and `.dev.vars`. Neither is committed.
- Demo data: with `npm run dev` running, `node tools/seed-demo.ts` (token from `npm run breakglass`;
  `--url` for another port) adds 3 orgs, ~45 passes, portal users, connections and API keys.
- Tests: `npm run test:unit|worker|web`, `npm run test:e2e`, `npm run coverage`.
- `npm run gen` rewrites `src/generated/*` and `worker-configuration.d.ts`. Commit the result.

## Go-live checklist

Do in order. `npm run predeploy` lists what is still a placeholder in `wrangler.jsonc`.

1. **Pocket ID** (`id.plrs.im`). PassBook registers itself with a Client ID Metadata Document:
   `vars.OIDC_CLIENT_ID` is `${PUBLIC_BASE_URL}/auth/oidc/client-metadata.json`, which the
   Worker serves (public client, PKCE, no secret; callback and post-logout URLs come from
   `PUBLIC_BASE_URL`).
   - Groups: `wallet-admins`, `wallet-users`. Pocket ID's generated names (`wallet_admins`) match
     too. A refused sign-in logs the groups it received (`auth.oidc_no_access`).
   - Application Configuration → OIDC: add that exact URL to the client metadata document allowlist.
   - After the first sign-in creates the client, set its allowed groups to both groups. PassBook
     also checks the groups claim itself.
   - Metadata changes reach Pocket ID within an hour, or at once with Refresh in its client list.
   - Logo: Pocket ID ignores the document's `logo_uri`. On the client, set Logo URL (and Dark logo
     URL) to `${PUBLIC_BASE_URL}/icons/icon-512.png`; Pocket ID downloads and keeps it.
   - Emails: Settings → "Trust Polaris ID emails" links and verifies an address only when Pocket ID
     sends `email_verified: true` (the user verified it in Pocket ID, or an admin ticked "Email
     verified"). Never set Pocket ID's `EMAILS_VERIFIED=true`: a user could then claim any address.
   - A registered client still works: set its id in `vars.OIDC_CLIENT_ID`; a confidential one also
     needs `OIDC_CLIENT_SECRET` (step 5). Local dev only loads secrets listed in
     `secrets.required`, so the mock provider runs as a public client.
2. **Apple certificate**
   - Pass Type ID `pass.im.plrs.wallet`, team `48H7CLBV8Y`. Export the `.p12`.
   - `P12_PASSWORD=… npm run credentials -- Pass.p12` (checks the chain, key match and dates).
3. **APNs mTLS binding**
   - `npm run identity:add` prints the plan (dry run). `npm run identity:add -- --apply` uploads
     `.secrets/platform-*.pem` with `wrangler mtls-certificate upload` and adds
     `mtls_certificates: APNS` to `wrangler.jsonc`. Then `npm run gen`.
   - Without the binding the platform signs passes but cannot push updates.
   - Or add a team push key (.p8) on the identity's Push card. After deploy, press Check there:
     failures with `APNS_TOKEN_TRANSPORT_FAILED` in the logs mean the runtime cannot reach APNs over
     HTTP/2. Apple answers 429 `TooManyProviderTokenUpdates` if tokens are re-signed too often
     (after setting a key, or on many isolates at once); the push job retries it.
4. **Turnstile**: a widget whose hostnames include `PUBLIC_BASE_URL`'s host. Site key in
   `vars.TURNSTILE_SITE_KEY`, secret in step 5. The always-pass test key is refused by `predeploy`.
5. **Secrets** (`wrangler secret put <NAME>`, value on stdin)
   - `KEK_V1`: `openssl rand -base64 32`. Back it up outside Cloudflare. Losing it loses every
     stored credential.
   - `TURNSTILE_SECRET` (and `OIDC_CLIENT_SECRET` only for a registered Pocket ID client).
   - `SIGNER_PLATFORM_CERTIFICATE` and `SIGNER_PLATFORM_PRIVATE_KEY`: contents of
     `.secrets/platform-certificate.pem` and `.secrets/platform-key.pem`.
   - `BREAKGLASS_TOKEN_SHA256`: run `npm run breakglass`, then paste the printed command. See
     [Break-glass admin](#break-glass-admin).
   - Optional: `SIGNER_PLATFORM_INTERMEDIATE` (defaults to the bundled WWDR G4),
     `MAGIC_LINK_DAILY_CAP`, `KEK_V2` (rotation).
6. **Provision** (owner only): `node tools/provision.ts` prints the wrangler commands;
   `--apply` runs them. It creates the D1 database `wallet-platform` (id written to
   `wrangler.jsonc`), the queues and the R2 bucket, adds the R2 lifecycle rule (`uploads/` expires
   after one day) and deletes the legacy secrets `ADMIN_TOKEN`, `SIGNER_HENRYS_CERTIFICATE` and
   `SIGNER_HENRYS_PRIVATE_KEY` from the `wallet` Worker. Each step probes first; a rerun skips what
   exists. `npm run deploy -- --apply` (step 9) then applies all migrations.
7. **R2 lifecycle**: done by step 6.
8. **Analytics Engine**: needs the Workers Analytics Engine entitlement on the account. The
   `EVENTS` dataset `wallet_events` is created by the first write. Charts query it through the
   `ANALYTICS_SQL` binding (no API token); if the query fails they fall back to D1 and the
   overview says which source it used.
9. **Deploy**: `npm run check`, then `npm run deploy` (dry run, prints the plan), then
   `npm run deploy -- --apply`. That refuses on placeholders, records a D1 Time Travel bookmark in
   `.wrangler/d1-bookmarks.log`, applies remote migrations, runs `wrangler deploy`.
   Queues, workflows and rate-limit namespaces are created by the deploy.
10. **First admin**: sign in through Pocket ID as a `wallet-admins` member (or break-glass if
    Pocket ID is down). Check Status: every
    component should be verified or configured.
11. **Device acceptance test** (a real iPhone)
    - Create an org, a template and a pass from the admin console; email it to yourself.
    - Add it to Wallet from the link.
    - Update a field. The pass updates on the phone within a minute (push).
    - Near a venue the pass appears on the lock screen. The barcode scans.
    - Void the pass; the phone shows it as voided.

## Domains

`vars.PUBLIC_BASE_URL` (`https://passbook.mobile`) is the only origin the app serves; pass
`webServiceURL`s, emails, the OIDC metadata, `index.html`'s preview tags and the break-glass
URL all derive from it. `src/worker/platform/host-policy.ts`:

- `PUBLIC_BASE_URL`'s host serves everything; plain http on it gets a 308 to https.
- A `vars.REDIRECT_HOSTS` host (`wallet.plrs.im`) answers every request, any path or method, with
  an uncached 308 to the same path and query on `PUBLIC_BASE_URL`.
- Any other host gets 421.
- The files `public/` ships (icons, email images, fonts, `robots.txt`) come from the asset layer
  before the Worker runs, so they load as they are on every attached host.

`npm run predeploy` checks that every custom domain in `routes` is the canonical host or a
redirect host, and that `EMAIL_FROM` is an allowed sender.

A pass keeps the `webServiceURL` it was issued with (`passes.web_service_url`). Apple documents
neither what Wallet does when an update carries a different one nor whether its web service
calls follow redirects, so once a pass is on a device its host must keep serving `/wallet/*`
itself. Moving again after that means serving the Apple web service on both hosts, not
redirecting.

### Move to passbook.mobile

Done (2026-11-03, through the Cloudflare API):

- `passbook.mobile` is an active zone in the deploying account (`account_id`), next to `plrs.im`.
- The Turnstile widget (`vars.TURNSTILE_SITE_KEY`) allows `passbook.mobile`. Without it the email
  sign-in form cannot pass the challenge.
- Email Sending is onboarded for `passbook.mobile` with its `cf-bounce` MX, SPF, DKIM and DMARC
  records. Without it every send from `delivery@passbook.mobile` fails
  (`E_SENDER_DOMAIN_NOT_AVAILABLE`): no sign-in links or codes, no pass emails.

Owner steps:

1. **Pocket ID**, before the deploy. OIDC settings → Client ID Metadata Documents → Allowed
   metadata document URLs: add `https://passbook.mobile/auth/oidc/client-metadata.json` (or
   `CIMD_URL_ALLOWLIST` when the UI config is disabled). The `wallet.plrs.im` entry does not match
   it. Until then Pocket ID sign-in fails; break-glass still works.
2. **Deploy**: `npm run deploy -- --apply`. The token needs Workers Routes Write on
   `passbook.mobile` and `plrs.im`. If `passbook.mobile` already has an apex record, delete it
   first; the custom domain creates its own. The deploy applies `migrations/0008_passes.sql`,
   which moves stored web service URLs off wallet.plrs.im (no pass was on a device).
3. **First sign-in** through Pocket ID creates a new client: set its allowed groups
   (`wallet-admins`, `wallet-users`) and its logo as in [Go-live](#go-live-checklist) step 1. User
   ids (`sub`) do not change, so linked accounts carry over; everyone consents once.
4. If passes existed, rebuild their files: Identities → the platform identity → Re-sign.

Sessions are host-only cookies, so everyone signs in again on passbook.mobile. Sign-in links in
recent emails still work through the redirect; a sign-in code requested on wallet.plrs.im does
not (it is bound to that host's cookie), so request a new one.

Verify:

    curl -sI https://passbook.mobile/health                          # 200
    curl -sI 'https://wallet.plrs.im/p/x?y=1'                        # 308 to https://passbook.mobile/p/x?y=1
    curl -s https://passbook.mobile/auth/oidc/client-metadata.json   # every URL on passbook.mobile

- Sign in with Pocket ID and with an email link on passbook.mobile. Status shows Email Sending
  and Turnstile configured.
- Issue a pass and add it to Wallet: its back shows the passbook.mobile support link, and an
  update reaches the phone.
- Once a rollback is off the table, remove the old Pocket ID client, its allowlist entry and
  `wallet.plrs.im` in the Turnstile widget.

Rollback: revert the change (`routes`, `PUBLIC_BASE_URL`, `REDIRECT_HOSTS`, `OIDC_CLIENT_ID`,
`EMAIL_FROM` and `send_email` move together) and deploy. The old Pocket ID client and allowlist
entry must still exist. Stored web service URLs stay on passbook.mobile: restore the D1 bookmark
the deploy logged (this drops later writes), or set them back with the reverse `UPDATE`.
Redirects are uncached, so no browser loops. Everyone signs in again. A pass added to Wallet in
between keeps calling passbook.mobile's web service, and Wallet does not follow redirects: its
holder re-adds it from a new link.

## Break-glass admin

Admin sign-in for when Pocket ID is down.

- `npm run breakglass` writes a new token to `.secrets/breakglass-token` (never printed) and its
  SHA-256 to `.dev.vars`, and prints the `wrangler secret put` command for production. The Worker
  only stores the hash. `--rotate` replaces an existing token; update the secret and deploy.
- Sign in at `/auth/breakglass` with the token. You get an admin session as "Break-glass admin":
  30 min idle, 4 h max. Every sign-in is in the audit log; failures are logged and rate limited.
- Turn it off: disable the "Break-glass admin" user in Users, or set the secret to `off`
  (anything that is not a 64-character hex hash makes the route 404).
- Pocket ID down: deploys still work (the client id is the metadata URL); sign in with
  break-glass. `--allow-no-oidc` only matters for a placeholder `OIDC_CLIENT_ID`.
- Keep the token offline (password manager). Rotate it after any use you did not expect.

## PassBook support

`vars.SUPPORT_EMAIL` in `wrangler.jsonc` (`support@passbook.mobile`) is the one address for PassBook's
own support. `npm run predeploy` refuses an empty or invalid value. It appears as:

- the "Pass service" back field on every pass ("PassBook · support@passbook.mobile" and the site);
- the support line on the holder pass page, the pass email's "Questions:" line and the voided
  note, for an org that has no support email or URL of its own (org settings win).

The Worker does not receive mail. In Cloudflare, Email Routing on `passbook.mobile` needs
`support@passbook.mobile` as a custom address that forwards to the owner's inbox, with the
destination verified. Changing the address is an edit to `SUPPORT_EMAIL` and a deploy. Issued
passes keep the old one until a template change or Identities, Re-sign all rebuilds them.

## Day two

- **Migrations**: `npm run deploy` handles them. Manual: `npx wrangler d1 time-travel info wallet-platform`,
  note the bookmark, then `npx wrangler d1 migrations apply wallet-platform --remote`.
  Restore: `npx wrangler d1 time-travel restore wallet-platform --bookmark <bookmark>`.
- **Certificate renewal** (yearly, Apple): get a new Pass Type ID certificate, then
  - platform: `npm run credentials`, update the two `SIGNER_PLATFORM_*` secrets, re-run
    `npm run identity:add -- --apply`, deploy;
  - other identities: admin console, Identities, Rotate certificate (admin session only; `POST /api/v1/identities/{id}/rotate`). Re-sign all passes is on the same page.
    Passes keep working; the pass type ID must match.
  Status warns 30 days before expiry.
- **KEK rotation**: add `KEK_V2` (`wrangler secret put KEK_V2`). The highest version encrypts; keep older ones for existing data. Keep the oldest KEK configured for as long as scan PINs and asset grants exist: their HMAC key derives from it, and removing it makes every staff PIN fail.
- **Status**: admin console, Status. Dead letters in `wallet-jobs-dlq` show there.
- **Suspended org**: public pages, Apple updates, pushes, syncs and webhooks stop for it.
- **Icons and social image**: `node tools/build-icons.ts` after the mark or the wallet art changes,
  then commit `public/`. `tools/site-meta.test.ts` checks sizes, the manifest and the heads.

## Runtime decisions

- **workerd versions**: `npm run test:worker` runs on the pool's miniflare (workerd 1.20260815), dev and prod on the root wrangler (1.20261012). The pool pins its own copy until a release catches up. The Dependabot `cloudflare` group tracks it; when one ships, align versions and drop the `overrides` entries in `package.json`. Stay on vitest 4 until the pool supports 5.
- **Placement**: default. `placement: smart` needs a latency comparison against D1 from production Observability data; none exists before launch. Revisit after a week of traffic.
- **Worker-first paths** (`assets.run_worker_first`): every path runs the Worker first, so the host policy sees every page visit, except the files `public/` ships (negated entries). The Worker serves the SPA's pages from `ASSETS` unchanged (`public/_headers` applies), keeps `/api`, `/auth`, `/wallet`, `/p`, `/hooks`, `/health` and `/assets` to itself, and answers an unknown file-like path (`/foo.js`, or a missing hashed chunk that would otherwise be cached immutable as the SPA page) with a 404. Add a file to `public/` and its negated entry in `wrangler.jsonc` together; `tools/wrangler-config.test.ts` fails when they differ. `scan.webmanifest` is the one exception: it goes through the scanner gate. Vite's dev paths (`/src/*`, `/@vite/*`, …) are added only in dev, by `vite.config.ts`. The cost is one invocation per page view.
- **Scanner gate** (`vars.SCAN_ENABLED`): `"0"` in `wrangler.jsonc` until scanner M1. Off, the Worker answers `/scan`, `/scan/*`, `/scan.html`, `/scan.webmanifest` and `/assets/decode-worker-*` with the not-found page (`no-store`); the scan API stays mounted and refuses as before. Tests, e2e and `npm run dev` (`.dev.vars`) set `"1"`. At M1 set it to `"1"` and deploy.
- **Baked template sync**: runs from the minute cron after a version change; the first template request still checks lazily as a fallback.
- **Passes follow their template**: when a template's active version changes (deploy of a baked
  template, import, activation, rollback), the minute cron (`passes.stale_reissue`, next to the
  branding reissue) waits for it to be quiet for a minute, then starts one `BulkReissue` for the
  template's live passes. Voided passes stay. Each active version is queued once
  (`templates.reissued_version`). A pass whose fields no longer fit the new version stays on its
  version, is logged (`bulk_reissue.pass_failed`, with the error code), counts in the run's
  `PARTIAL_FAILURE` on Status, and shows as "could not update" on the template page. Upload a fixed
  version to move it on.
