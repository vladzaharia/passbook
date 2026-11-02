# Operations

## Local dev

    npm ci
    npm run dev:vars   # fills missing .dev.vars: KEK, mock OIDC, fixture signer, PUBLIC_BASE_URL
    npm run db:local   # apply migrations to the local D1
    npm run dev:oidc   # mock Pocket ID on :5174
    npm run dev        # http://localhost:5173

- `dev:vars` never overwrites. An old `PUBLIC_BASE_URL` on another port must be edited by hand.
- Local dev has no APNs binding and no Analytics SQL binding: push is "unavailable", charts read D1.
- Real Pass Type ID certificate: `P12_PASSWORD=… npm run credentials -- Pass.p12` writes
  `.secrets/platform-{certificate,key}.pem` and `.dev.vars`. Neither is committed.
- Demo data: with `npm run dev` running, `node tools/seed-demo.ts` (token from `npm run breakglass`;
  `--url` for another port) adds 3 orgs, ~45 passes, portal users, connections and API keys.
- Tests: `npm run test:unit|worker|web`, `npm run test:e2e`, `npm run coverage`.
- `npm run gen` rewrites `src/generated/*` and `worker-configuration.d.ts`. Commit the result.

## Go-live checklist

Do in order. `npm run predeploy` lists what is still a placeholder in `wrangler.jsonc`.

1. **Pocket ID** (`id.plrs.im`). Wallet registers itself with a Client ID Metadata Document:
   `vars.OIDC_CLIENT_ID` is `https://wallet.plrs.im/auth/oidc/client-metadata.json`, which the
   Worker serves (public client, PKCE, no secret; callback and post-logout URLs come from
   `PUBLIC_BASE_URL`).
   - Groups: `wallet-admins`, `wallet-users`.
   - Application Configuration → OIDC: add that exact URL to the client metadata document allowlist.
   - After the first sign-in creates the client, set its allowed groups to both groups. Wallet
     also checks the groups claim itself.
   - Metadata changes reach Pocket ID within an hour, or at once with Refresh in its client list.
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
4. **Turnstile**: widget for `wallet.plrs.im`. Site key in `vars.TURNSTILE_SITE_KEY`, secret in step 5.
   The always-pass test key is refused by `predeploy`.
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
- **KEK rotation**: add `KEK_V2` (`wrangler secret put KEK_V2`). The highest version encrypts; keep older ones for existing data.
- **Status**: admin console, Status. Dead letters in `wallet-jobs-dlq` show there.
- **Suspended org**: public pages, Apple updates, pushes, syncs and webhooks stop for it.

## Runtime decisions

- **workerd versions**: `npm run test:worker` runs on the pool's miniflare (workerd 1.20260815), dev and prod on the root wrangler (1.20261012). The pool pins its own copy until a release catches up. The Dependabot `cloudflare` group tracks it; when one ships, align versions and drop the `overrides` entries in `package.json`. Stay on vitest 4 until the pool supports 5.
- **Placement**: default. `placement: smart` needs a latency comparison against D1 from production Observability data; none exists before launch. Revisit after a week of traffic.
- **`/assets/*` worker-first**: kept. A missing hashed chunk would otherwise get the SPA fallback page cached immutable under the chunk URL; the guard turns it into a 404. The cost is one invocation per asset request.
- **Baked template sync**: runs from the minute cron after a version change; the first template request still checks lazily as a fallback.
