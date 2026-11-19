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
  `--url` for another port) adds 3 orgs, ~45 passes, portal users, connections and API keys. It waits for the
  baked blueprints, invites and signs in `demo.owner@example.com` (org_admin in every org; org work runs as
  them, since a platform admin without membership gets 404), and needs a valid signing identity in `.dev.vars`
  (the fixture one lasts 2 to 3 days; on "Incorrect or expired WWDR intermediate" delete its `SIGNER_PLATFORM_*` lines, run `npm run dev:vars`, restart).
  Sign-in mail is capped at 5 an hour per address, so reruns an hour apart.
- Visual sweep: `node tools/dev/visual-sweep.ts --url http://localhost:5173 --routes tools/dev/visual-routes/admin.json[,portal.json,public.json,scanner.json] [--only name] [--viewports desktop,tablet,mobile] [--themes light,dark] [--emails]`
  screenshots every route at 3 viewports and 2 themes into `.wrangler/visual-sweep/<run>/` with an `index.json` of console errors, failed requests and statuses.
- It signs in once per role (break-glass, `demo.owner@example.com`, a portal holder), keeps the state in `.wrangler/visual-sweep/state/` and needs seeded demo data (`tools/seed-demo.ts`).
- Journeys: `--journeys pass-lifecycle,join,import,connections-webhooks,messages,onboarding-signin,retention,bundles` (or `all`) follows one thing through several screens, emails included, and writes `.wrangler/visual-sweep/journeys/<name>/` with numbered shots at 390 (iPhone), 820 (iPad) and 1440, light and dark, plus an `index.html` in step order. Each run makes its own passes, addresses and bundles (stamped) and ends by revoking its keys; sign-in mail stays under the 5 an hour cap because sessions are reused. A journey is `tools/dev/visual-journeys/<name>.ts`; register it in `index.ts`.
- Tests: `npm run test:unit|worker|web`, `npm run test:e2e`, `npm run coverage`.
- e2e runs the dev server or, in CI, the built preview. Both raise `RL_SCAN_PAIR` (30 a minute in production) to 100,000: `vite.config.ts` for dev, `tools/e2e-server.ts` patches the built `wrangler.json` for preview. A worker test covers the real limit.
- `npm run gen` rewrites `src/generated/*` and `worker-configuration.d.ts`. Commit the result.

## Go-live checklist

Do in order. `npm run deploy:check` lists what is still a placeholder in `wrangler.jsonc`.

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
   `vars.TURNSTILE_SITE_KEY`, secret in step 5. The always-pass test key is refused by `deploy:check`.
5. **Secrets** (`wrangler secret put <NAME>`, value on stdin)
   - `KEK_V1`: `openssl rand -base64 32`. Back it up outside Cloudflare. Losing it loses every
     stored credential.
   - `TURNSTILE_SECRET` (and `OIDC_CLIENT_SECRET` only for a registered Pocket ID client).
   - `SIGNER_PLATFORM_CERTIFICATE` and `SIGNER_PLATFORM_PRIVATE_KEY`: contents of
     `.secrets/platform-certificate.pem` and `.secrets/platform-key.pem`.
   - `BREAKGLASS_TOKEN_SHA256`: run `npm run breakglass`, then paste the printed command. See
     [Break-glass admin](#break-glass-admin).
   - Optional: `SIGNER_PLATFORM_INTERMEDIATE` (defaults to the bundled WWDR G4),
     `MAGIC_LINK_DAILY_CAP`, `KEK_V2`, `MAC_KEY_VERSION` and `MAC_KEY_VERSION_PREVIOUS` (rotation).
6. **Provision** (owner only): `node tools/provision.ts` prints the wrangler commands;
   `--apply` runs them. It creates the D1 database `wallet-platform` (id written to
   `wrangler.jsonc`), the queues and the R2 bucket, adds the R2 lifecycle rule (`uploads/` expires
   after one day) and the receipt lock, and deletes the legacy secrets `ADMIN_TOKEN`,
   `SIGNER_HENRYS_CERTIFICATE` and `SIGNER_HENRYS_PRIVATE_KEY` from the `wallet` Worker. Each step
   probes first; a rerun skips what exists, so rerun it after a release that adds a queue.
   `npm run deploy -- --apply` (step 9) then applies all migrations.
7. **R2 lifecycle and receipt lock**: done by step 6. The lock rule `retention-receipts` keeps
   every object under `retention/receipts/` for 2190 days (the D1 receipt retention): no delete or
   overwrite, the Worker's included. Retention verification relies on it. Anyone allowed to edit R2
   bucket settings can remove it (`npx wrangler r2 bucket lock remove wallet-passes --name retention-receipts`); while it
   exists the bucket cannot be emptied.
8. **Analytics Engine**: needs the Workers Analytics Engine entitlement on the account. The
   `EVENTS` dataset `wallet_events` is created by the first write. Charts query it through the
   `ANALYTICS_SQL` binding (no API token); if the query fails they fall back to D1 and the
   overview says which source it used.
9. **Deploy**: `npm run check`, then `npm run deploy` (dry run, prints the plan), then
   `npm run deploy -- --apply`. That refuses on placeholders or an unset required secret, uploads
   a Worker version (not serving yet), records a D1 Time Travel bookmark in
   `.wrangler/d1-bookmarks.log`, applies remote migrations, then promotes the version.
   Queues, workflows and rate-limit namespaces come from step 6. Pass flags after `--`, for
   example `npm run deploy -- --apply --allow-no-push`; `--apply` runs every check first.
   **First deploy**: use `npm run deploy -- --first --apply`. Cloudflare documents that
   `versions upload` fails for a Worker that was never deployed and cannot apply Durable Object
   class changes (`ScanHub`); it does not document registering queue consumers or workflows
   either, so treat `wrangler deploy` as the registering step. `--first` bookmarks D1, migrates,
   then runs `wrangler deploy`, which serves at once (no gradual promote). Use it again whenever
   a release adds a queue consumer, a workflow or a Durable Object class. After it, check
   `npx wrangler queues info wallet-jobs` lists the Worker as consumer; later releases use the
   default versions flow.
   A database that still lacks `0029_org_memberships` is refused: see
   [Cutover](#cutover-from-schema-0024), which is complete.
10. **First admin**: a new database has no memberships. Run
    `node tools/bootstrap-tenancy.ts --owner <your email> --apply` locally, or the printed remote
    commands, after signing in once. Then sign in through Pocket ID as a `wallet-admins` member
    (or break-glass if Pocket ID is down). Check Status: every component should be verified or
    configured.
11. **Device acceptance test** (a real iPhone)
    - Create an org, a template and a pass from the admin console; email it to yourself. An
      uploaded template needs a release first (a second reviewer approves it).
    - Add it to Wallet from the link.
    - Update a field. The pass updates on the phone within a minute (push).
    - Near a venue the pass appears on the lock screen. The barcode scans.
    - Void the pass; the phone shows it as voided.

## Google and Samsung Wallet accounts

Keep Apple signing and push in place. Provider accounts and reviews are isolated by organization,
mode and provider; Test configuration is not Live readiness. See the
[provider API](api.md#google-and-samsung-wallet-providers) for account and callback routes.

- **Google:** obtain an authorized Wallet issuer and service account with the Wallet issuer scope;
  see [Google's authentication instructions](https://developers.google.com/wallet/generic/getting-started/auth/rest).
  Publishing approval and replay-safe Save behavior are not verified, so Google publication and
  offers remain unavailable even with valid credentials.
- **Samsung:** complete Partner Portal onboarding and obtain the partner/card identifiers, partner
  key and certificate, certificate ID and genuine Samsung verification certificate; see
  [Samsung's Add to Wallet interface](https://developer.samsung.com/wallet/api/add-to-wallet-interface.html).
  A fresh authenticated ACTIVE, testing-mode-off response can establish candidate-specific card
  publication, but not a recipient's market eligibility. Samsung offers remain unavailable.
- Configure credentials only through the authorized, mode-matched account flow. Do not put keys,
  provider tokens or holder capability links in logs, documentation, tickets or screenshots.
  Rotation preserves Google's internal object-identifier HMAC key; it does not prove approval.
  Retire linked instances before revoking an account.
- Use the provider-supplied artwork unchanged and follow their locale, size and clear-space rules;
  see [Google's badge guidance](https://developers.google.com/wallet/generic/resources/brand-guidelines)
  and [Samsung's image resources](https://developer.samsung.com/wallet/references/imageresources.html).
  Before distributing Samsung badges, confirm applicable partner onboarding and trademark
  permissions: Samsung's [badge guidance](https://developer.samsung.com/wallet/add-to-wallet.html)
  and [developer terms](https://developer.samsung.com/terms?location=us) do not by themselves
  establish a redistribution license.

The Google callback at `POST /wallet/v1/google/{accountId}` verifies Google's signed event; the
Samsung interaction at `GET` or `POST /wallet/v1/samsung/cards/{cardId}/{refId}` authenticates
the method and path, not query fields or callback bodies. Confirm Samsung interoperability with
the partner. A Samsung Data Fetch reference can remain reusable after the first authenticated
fetch; protect it even after a short-lived wrapper expires. Neither callbacks nor provider
acceptance prove a particular holder installed or removed a pass.

The pass Devices view shows separate Google and Samsung instance and sanitized operation statuses
alongside Apple devices. A missing instance does not mean the provider account is unconfigured;
`ready` and `active` are local states, not proof of publication or recipient-market eligibility.
Installation remains unknown, and acceptance does not prove device deletion or delivery. Check the
scoped [pass status API](api.md#google-and-samsung-wallet-providers) when investigating pending
retirement or an uncertain provider outcome.

The minute cron (`wallet.sync`) reconciles queued provider changes and retirement; uncertain
outcomes remain held for operator reconciliation rather than blindly retried.

Provider retirement can delay Live hard purge and Test cleanup; unresolved outcomes do not permit
deletion. A potentially issued or disclosed Google
object remains held without proven replay-safe retirement; a strictly proven never-issued
placeholder may retire locally. Samsung retirement is per reference, not its event-wide Cancel;
provider acceptance proves neither physical deletion nor recipient-market eligibility.
Provider identities are tied to a positive credential generation. Transfer start reserves the
target, then atomically advances the pass generation, revokes the old holder link and stages old
provider retirement and blocked target placeholders. A failed generation compare-and-swap rolls
back the reservation and staging. The targets stay blocked until all old retirements are safely
settled; the final compare-and-swap assigns the new holder and credentials and completes the transfer.
Provider eligibility gates still apply. Preserve Samsung callback tombstones and never reuse
provider IDs, references or tokens. A PII-free Samsung tombstone retains mappings to authentication
material for old references; more than 32 retained credential revision mappings for a reference
fail closed with `503` and require operator/Samsung migration.

The credential-reference keyset commitment binds transfer and provider authority to the original
oldest configured KEK. A missing or mismatched commitment blocks provider reference use and
retirement rather than creating replacement identities. Restore the original key configuration
or perform an explicitly reviewed rekey; never delete retained tombstones to bypass the fence.
Legacy provider instances, references, projection reviews and verification evidence without a
proven original commitment stay unavailable until a separately reviewed recovery migration.

Configure and deploy the integration before using any endpoints; no production credentials are
supplied by this project.

### Fake Google and Samsung wallets

`test/mock-wallets` stands in for both providers, with in-memory state, a request log and failure
injection. Dev and e2e only.

    WALLET_MOCKS=1 npm run dev   # also starts the fake on :5175 (MOCK_WALLETS_PORT)
    node test/mock-wallets/server.ts 5175   # or run it alone; point WALLET_MOCK_PROVIDERS_URL at it

- Google: `/token`, `/walletobjects/v1/{genericClass,genericObject,issuer}`, and `/gp/v/save/<jwt>`
  (open it to record a save). Samsung: `/partner/v1/card/template/<cardId>` and
  `/<cc2>/wltex/cards/<cardId>/{updates,cancels}`. Signatures are not verified.
- Inspect: `curl localhost:5175/__mock/state` and `/__mock/requests`; clear with `POST /__mock/reset`.
- Fail a call: `curl -XPOST localhost:5175/__mock/inject -d '{"status":429,"match":"POST /token","times":2,"retryAfterSeconds":5}'`.
  `match` is a regex over `METHOD /path`; any status from 200 to 599.
- Worker tests call `createMockWallets().handle(request)` from a stubbed `fetch` (`failNext`,
  `setSamsungTemplate`); see `test/mock-wallets/mock-wallets.test.ts`.
- The Worker redirects provider calls only when `WALLET_MOCK_PROVIDERS_URL` and `PUBLIC_BASE_URL`
  are both plain-http loopback (`wallet-providers/mock-endpoint.ts`). Never set it in
  `wrangler.jsonc` or a deployed secret; a test fails if it appears there.
- Google and Samsung issuance is still off (`provider-policy.ts`), so an issued pass cannot reach a
  save link yet. e2e `32-mock-wallets` covers the provider calls and the save link directly.

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

`npm run deploy:check` checks that every custom domain in `routes` is the canonical host or a
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
entry must still exist. Stored web service URLs stay on passbook.mobile: set them back with the
reverse `UPDATE`. Do not restore D1 (see [Cutover](#cutover-from-schema-0024)).
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
own support. `npm run deploy:check` refuses an empty or invalid value. It appears as:

- the "Pass service" back field on every pass ("PassBook · support@passbook.mobile" and the site);
- the support line on the holder pass page, the pass email's "Questions:" line and the voided
  note, for an org that has no support email or URL of its own (org settings win).

The Worker does not receive mail. In Cloudflare, Email Routing on `passbook.mobile` needs
`support@passbook.mobile` as a custom address that forwards to the owner's inbox, with the
destination verified. Changing the address is an edit to `SUPPORT_EMAIL` and a deploy. Issued
passes keep the old one until a template change or Identities, Re-sign all rebuilds them.

## Cutover from schema 0024

**Completed 2026-11-18 00:05 UTC.** Production moved from schema 0024 to 0069 on `main` `bfd64602` (Worker version `0afc3a51`). The Time Travel bookmark taken before the migrations is `0000005e-0000009a-00005126-8ff012e6e3d130a41b99342697a584b6` (2026-11-17 23:58:17 UTC). The pre-checks, the temporary WAF rule and the bootstrap are done; the token seal sweep finished with no plain pass or bundle token and no stored `pass_json` carrying a device token. Design decisions: `docs/design/authority-epochs.md` §6.

- Never restore D1 to undo a deploy: a restore drops every write since the bookmark, including Wallet registrations, scans and the tombstones that keep retired pass ids and credentials from being reused. Roll forward.
- `tools/deploy.ts` still refuses a full deploy while `0029_org_memberships` is pending on a database with data. Production is past that.
- The step-by-step runbook (pre-checks, the temporary WAF rule, order, failure table) is in git history before the commit that shortened this section.
- `test/cutover/` stays as a regression over a populated 0024 database: migrated to 0069, bootstrapped and synced as in production, then sealed and migrated to head. A database that was not sealed stops at 0070 (`guard.test.ts`). `tools/bootstrap-tenancy.ts` stays: it gives the first admin a membership on a new database (Go-live checklist, step 10) and seeds the local demo.

### Capability tokens at rest

Pass download tokens, bundle tokens and Apple web-service tokens are stored as MACs with a sealed copy (0059, 0065); the database refuses a plain value (triggers of 0059 and 0065). 0070 removed the plain-to-MAC exception, the minute cron `tokens.seal` and the plain lookup, and refuses to run while any plain token or stored device token is left (the migration is not recorded and rolls back). The only MAC-to-MAC rewrite is the cron `tokens.remac` after `MAC_KEY_VERSION` moves.

- Backups from before 0059 hold working links and, from before 0065, working device tokens: rotate in bulk if one leaks (a credential transfer rotates the device token). D1 Time Travel keeps 30 days: a restore to a point before 0065 brings the plain device tokens back, so treat a restore as a rotation event, and a restore to before 0065 must stop at 0069 and run bfd64602's `tokens.seal` to zero before 0070.
- Every `.pkpass` object in R2 carries the device token that was current at its version (Wallet needs it in the signed bytes). Keep the bucket private (no public bucket, no `r2.dev`, an API token scoped to the Worker). Purged versions and purged deleted passes delete their objects.
- A soft-deleted pass drops its sealed copies at once.

## Pass imports

Spec and guide: `docs/importing-passes.md`, `docs/api.md` ("Import passes").

- **Limits**: 2,000 rows, 2,000,000 bytes, 100 columns, 2,000 characters a cell; 3 MB request body for a
  create; 30 creates and 120 checks an hour per org and mode; one running import per org, mode and template.
  A link source follows up to 3 redirects (every hop re-checked, https only, 15 s in all).
- **Run**: the `PassImport` Workflow (`PASS_IMPORT`), 20 rows a step. `subrequests` is raised to 500,000 in
  `wrangler.jsonc`: a create is about 58 D1 calls. A 2,000-row create run is about 116,000.
- **Stuck imports**: the minute cron `passes.import_stuck` ends an import that stayed `committing` for 10
  minutes with no live instance as `failed` (`IMPORT_FAILED`) and gives back its email hold. Logs:
  `pass_import.swept`, `IMPORT_SWEEP`, `IMPORT_SWEEP_STATUS`, `IMPORT_START_STATUS`.
- **Retention** (daily cron `passes.import_retention`, 50 imports a batch, 10 batches a phase):
  drafts not committed within 23 h become `expired` and lose their file; 30 days after an import ends its
  rows lose cell values, emails, External IDs and earlier values (also for a suspended org); imports go 400
  days after they end, counts with them. The upload also has a 1-day R2 lifecycle (`uploads/`). Logs:
  `pass_import.retention`, `IMPORT_RETENTION`, `IMPORT_RETENTION_FILE`.
- **Privacy**: logs carry ids, row numbers and codes, never cells, emails, links or the sheet URL. A published
  sheet link is a secret; only its host is stored.
- **Sheet connection** (`csv-url`): polls every 15 min (6 requests a minute at most), 2 MB cap, up to 3 redirect
  hops, at most 2,000 rows (more fails the run as a permanent `CONFIG`). Rows with no ID or a repeated ID are
  skipped and logged as `CSV_ROW_NO_ID` and `CSV_ROW_DUP_ID` with a count.
- **Redirects**: `maxRedirects` on `createSafeFetch` (default 0, at most 5). A hop to another host drops every
  header except accept, accept-language and user-agent. Only GET and HEAD follow redirects; `Location` is
  never echoed.

## Day two

- **Migrations**: `npm run deploy` handles them. Manual: `npx wrangler d1 time-travel info wallet-platform`,
  note the bookmark, then `npx wrangler d1 migrations apply wallet-platform --remote`.
  Migrations are forward-only: roll back a bad release by promoting the previous Worker version
  (`npx wrangler versions deploy <previous>@100%`), not by restoring D1. Exception: 0059 and 0065 are
  a one-way line. Never promote a Worker older than the release that ships them: it cannot read a
  sealed token (every device call answers 401, a stored MAC would pass its plain compare) and every
  create, publish and transfer aborts on the new triggers. Roll forward. `npm run deploy` only ever
  promotes the version it uploaded; the risk is a manual `wrangler versions deploy`. A restore is the last
  resort and drops every write since the bookmark, including pass tombstones and retired ids.
  Apply the complete ordered migration batch, including 0042, 0044 and 0046, before routing the
  new Worker or initializing the credential-reference keyset. The initializer deliberately
  fails closed while later reference stores are absent.
- **Certificate renewal** (yearly, Apple): get a new Pass Type ID certificate, then
  - platform: `npm run credentials`, update the two `SIGNER_PLATFORM_*` secrets, re-run
    `npm run identity:add -- --apply`, deploy;
  - other identities: admin console, Identities, Rotate certificate (admin session only; `POST /api/v1/identities/{id}/rotate`). Re-sign all passes is on the same page.
    Passes keep working; the pass type ID must match.
  Status warns 30 days before expiry.
- **KEK rotation** (add a KEK, move every envelope to it, then delete the old one). The highest `KEK_V<n>` encrypts. The MAC keys (scan PIN, pair code, asset grant, pass/bundle link and Apple web-service token `h1:`) derive from the root named by `MAC_KEY_VERSION` (default: the oldest); the credential-tombstone key and the other retained-evidence keys (retention proofs, retention receipts, webhook and action references, the keyset commitment) always derive from the oldest root. A root is a KEK, or its `MAC_ROOT_V<n>` (the HKDF-Extract of that KEK: it derives the same keys byte for byte and unwraps no envelope).
  1. `wrangler secret put KEK_V2`. New envelopes use V2 at once, and the minute cron `keys.rewrap` starts: it moves the 15 envelope places (credentials, personalizations, APNs keys, webhook payloads and legacy sources, provider credentials, outcomes, Samsung refs and receipts, Google receipts, transfer payloads, the three token seals and captured test emails) to V2, keeping each DEK, iv and ciphertext, so no signing-identity revision or other epoch moves. At most 4 reads and 4 batches of 50 a run (about 200 rows a minute: 100,000 passes take about 17 hours). Each run logs `KEK_REWRAP_RUN` (`moved`, `raced`, `unreadable`); a sweep that moved or lost anything is followed by another, and `KEK_REWRAP_DONE` (setting `keys.rewrapDone`, stamp `1>2`, with the rows left per KEK version) follows one clean sweep. An isolate that still runs the older version can write a row under V1 after that; once an hour a done pair is probed in every place (`LIMIT 1`), and a late row logs `KEK_REWRAP_LATE` and starts a sweep again. Do not roll the Worker back to a version uploaded before this step: its bindings may lack V2.
  2. After a KEK_V1 compromise only: run the MAC key rotation below (`MAC_KEY_VERSION=2`, `MAC_KEY_VERSION_PREVIOUS=1`, wait for `TOKEN_REMAC_DONE`, reset the staff PINs on root 1), then rotate links (`rotate-link`), run credential transfers and rotate connector secrets, signer keys, the APNs key and provider credentials at their source. A rewrap re-encrypts nothing: a copy of the database plus V1 already holds every DEK, and evidence made under root 1 stays open to offline guessing of its inputs (barcodes, serials, names). Rekeying that evidence is deferred (authority-epochs, 7.2).
  3. Wait for `KEK_REWRAP_DONE` with stamp `1>2`. Status, Key rotation, shows the rewrap as done. A row that does not open (wrong AAD, damaged) is left, counted in `unreadable` and logged by id in `KEK_REWRAP_UNREADABLE`: Status is degraded. Delete or restore the row through its module; a done pair with unreadable rows is swept again every hour.
  4. `<KEK_V1 from your vault> | node tools/keys.ts mac-root | wrangler secret put MAC_ROOT_V1`. `MAC_ROOT_V1` opens no envelope but forges every MAC the KEK would (link and device tokens, PIN hashes, retained evidence): keep it as secret as the KEK and escrow it the same way. Without it, deleting KEK_V1 changes every retained-evidence MAC (retention receipts then stop verifying) and fails `requireCredentialRefKeyset` closed (`CREDENTIAL_REF_KEYSET_UNAVAILABLE`; root 1 is explicit and never falls back to V2), which stops scanner, transfer, provider and connection credential-reference operations; the `MAC_KEY_VERSION` default also stays root 1. Never delete evidence or reset the keyset sentinel to get around it.
  5. Wait a minute. Status, Key rotation, must be verified: while both are set, the cron checks that `MAC_ROOT_V1` derives the same keys as `KEK_V1` (`keys.macRoots`). A mismatch is failing (`MAC_ROOT_MISMATCH`) and breaks nothing, because KEK_V1 still wins: delete `MAC_ROOT_V1` and redo step 4.
  6. `npm run keys:retire -- 1` (dry run, reads production with `--remote`; owner only) judges the deployed Worker, not the checkout: the ring and the MAC pins come from `keys.ring`, which the cron records every minute, and it refuses when that record is missing or older than 15 minutes, or when `wrangler.jsonc` `MAC_KEY_VERSION*` differs from it. It refuses and says why unless all of these hold: the rewrap is done for the current ring (`1>2`) with `unreadable` 0; an exact `count(*)` of every envelope place on V1 is 0 (not the cron's word); `KEK_V2` and, because root 1 is in use, `MAC_ROOT_V1` are set; `keys.macRoots` says match within 15 minutes; `MAC_KEY_VERSION_PREVIOUS` is not 1 and no staff PIN is on root 1 unless the root is set; 24 hours have passed since the first rewrap run (console cursors and live attachments sealed under V1 live that long; after it an old one is refused and the client starts again). Fix what it reports. If it counts rows on V1 (a late row), wait for `KEK_REWRAP_LATE` and the next `KEK_REWRAP_DONE` (within the hour plus a sweep), then run it again; do not delete the key meanwhile.
  7. `npm run keys:retire -- 1 --apply` deletes `KEK_V1` (the tool is the only gate: `wrangler secret delete` deploys at once). Keep the value in offline escrow for 30 days unless it was compromised; restoring it is a plain `secret put` and changes nothing, because no row uses it.
  8. Check Status (Key rotation and Encryption key verified), then open a pass link, run an Apple device update, scan a pass and replay a webhook.
  A deploy check (`npm run deploy:check -- --secrets`) and Status refuse a ring with no KEK, without root 1 (`KEK_V1` or `MAC_ROOT_V1`), with a `MAC_ROOT_V<n>` that is not older than the current KEK, or with a `MAC_KEY_VERSION` that names no root. `KEK_V1` is no longer a required secret.
  The credential-reference keyset sentinel initializes only when
  no prior keyed references or proof provenance remain, including tombstones and
  retention proofs, retained webhook/workflow bindings and native-provider history.
  Plain unsigned legacy scan events do not prevent initialization, but remain untrusted and are
  never promoted to authenticated history merely because a sentinel was installed.
  Scanner asset grants are stateless (one hour): to void every outstanding one, deploy with a new label in
  `asset-grant-mint.ts` (`scan-asset-grant-v2` to `-v3`). Changing the grant's field list (`scan-asset-v4` in `asset-claim.ts`) voids them the same way. Adding a KEK version changes none of them; the pass and bundle link MACs also stay valid.
  Removing root 1 without `MAC_ROOT_V1` causes a commitment mismatch: scanner, transfer, provider
  and connection credential-reference operations fail closed. Restore the original KEK (or set `MAC_ROOT_V1`),
  confirm the deployed keyset commitment matches the retained records, then retry the blocked operation.
- **MAC key rotation** (availability after a change of MAC root; it revokes nothing): needs the new root in place (`KEK_V2`). Set both values as Worker vars (wrangler.jsonc `vars`), not secrets: `npm run deploy:check` reads them from the config, an integer or a digit string. `npm run deploy:check` (with `--secrets`) and Status refuse a `MAC_KEY_VERSION` or `MAC_KEY_VERSION_PREVIOUS` that is malformed, names a root (`KEK_V<n>` or `MAC_ROOT_V<n>`) that is not set, or equals the other; a pin changed without `MAC_KEY_VERSION_PREVIOUS` breaks every link, and `tokens.remac` logs `TOKEN_MAC_ROOT_MISMATCH` (error, sampled every 6 hours) when stored MACs match no root.
  1. Set `MAC_KEY_VERSION=2` and `MAC_KEY_VERSION_PREVIOUS=1` together and deploy. Lookups accept a link or device token under either root, and staff PINs set before the deploy still verify under the previous root (a correct PIN is no miss), so nothing stops. At once: a pair code issued before the deploy fails (they last 10 minutes); asset grants made before it expire within 1 hour; scan CSRF proofs are computed on every request and follow the pin.
  2. The minute cron `tokens.remac` rewrites every pass link, Apple web-service token and bundle link from its sealed copy, in id order, at most 30 D1 write batches a run (the minute hooks share one invocation's subrequests; read 100 rows of each kind a run). Plan on about 30 tokens a minute (rows / 30 minutes). Each run logs `TOKEN_REMAC_RUN` with `moved`, `current`, `skipped` and `unreadable`, and `TOKEN_REMAC_SKIPPED` with up to 20 ids. A pass with a pending credential transfer or a test-inbox forward is skipped and the sweep runs again. The sweep and the done marker belong to one pair (`previous>current`): swapping the two values, or pinning a pair again after another finished, starts over. `TOKEN_REMAC_DONE` (setting `tokens.remacDone` = `1>2`) means a sweep left nothing skipped; its `unreadable` total counts rows it could not move.
  3. Check, then unset `MAC_KEY_VERSION_PREVIOUS` and deploy. Do not unset it while any staff PIN is still on the previous root: Status shows "N staff PINs still on the previous root" (degraded) while it is set, and the query is `SELECT count(*) FROM scan_staff WHERE COALESCE(pin_mac_version, 1) = 1;` (replace both 1 with the previous version, the first with the oldest KEK's number; NULL means the oldest KEK). Those staff keep signing in with their old PIN until then (the PIN is checked under both roots) and are reset in Scanning, which writes the current root. A new or reset PIN records the root it was hashed under (`scan_staff.pin_mac_version`). Also check the row counts: `SELECT (SELECT count(*) FROM passes WHERE download_token GLOB 'h1:*') + (SELECT count(*) FROM passes WHERE auth_token GLOB 'h1:*') + (SELECT count(*) FROM bundles WHERE token GLOB 'h1:*') AS tokens;` is the sweep's size, so the sweep takes about tokens / 30 minutes (30 writes a minute at most), and `TOKEN_REMAC_DONE` must have logged. A row counted `unreadable` (a deleted pass or org keeps no sealed copy; also `TOKEN_SEAL_MISSING`, `TOKEN_SEAL_UNREADABLE`, `TOKEN_SEAL_MISMATCH` in the log) still holds the old MAC and stops resolving now: its link and device calls end.
  4. To go back, swap the two values; the job moves the rows again.
  A rotation restores availability only. The sealed copies sit under the KEK that wrapped them until `keys.rewrap` moves them (KEK rotation), and a copy of the database plus that KEK opens every link and device token, so after a KEK_V1 compromise rotate the links (`rotate-link`) and credentials (credential transfer) too. Credential-reference evidence (tombstones, retention proofs, webhook and action references, personalization proofs; bound to the keyset commitment) stays on root 1 (`KEK_V1`, or `MAC_ROOT_V1` once V1 is retired): no rekey tool exists.
- **Retired ids**: `retired_session_ids`, `retired_scanner_ids` and `retired_api_key_ids` refuse
  deletes for 400 days after retirement. The daily `authority.retired_ids` hook then purges them.
- **Status**: admin console, Status. Dead letters in `wallet-jobs-dlq` show there.
- **Suspended org**: public pages, Apple updates, pushes, syncs and webhooks stop for it.
- **Icons and social image**: `node tools/build-icons.ts` after the mark or the wallet art changes,
  then commit `public/`. `tools/site-meta.test.ts` checks sizes, the manifest and the heads.

### Baked sync wait

`WALLET_API_KEY=<key> npm run deploy -- --promote --apply` serves the uploaded version at 100%, then every 10 s calls `GET /api/v1/templates` with the key (which runs the baked sync) and runs `verify-heads`, for at most 3 minutes. Without the key it only polls, and the minute cron (`templates.sync`) runs the sync up to a minute later. Exit 0 prints `Baked sync done: every live pass has a release head.` Exit 1 lists the templates that still cannot issue; existing passes keep scanning. Check the logs for `TEMPLATE_BUILD_SUPERSEDED` or `BAKED_RELEASE_CONTENT_UNAVAILABLE` (baked assets missing from ASSETS), then ship a fixed version. Roll forward; do not roll back.

```sql verify-heads
SELECT t.id, t.origin, t.status, p.org_id, count(*) AS passes FROM passes p JOIN templates t ON t.id = p.template_id
JOIN orgs o ON o.id = p.org_id AND o.status != 'deleted'
WHERE p.deleted_at IS NULL AND p.mode = 'live' AND p.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM template_release_heads h
    WHERE h.template_id = t.id AND h.mode = 'live' AND h.provider = 'apple'
      AND h.org_scope = CASE WHEN t.origin = 'uploaded' OR t.org_id IS NOT NULL THEN p.org_id ELSE '' END)
GROUP BY t.id, t.origin, t.status, p.org_id
```

Only archived templates may be listed; the wait ignores them.

### Large connection syncs

A first sync that writes more than 2,000 passes continues in a new workflow instance `<run id>-cN`; the run stays one row, open until the last instance ends. Each instance pins the template release again, so a release approved mid-run applies from the next instance. A connection has one open schedule or admin run: Sync now during one returns that run. A run whose instance died closes as `RUN_LOST`; a run that hits the 50-instance limit ends with `SYNC_CAPPED` in its detail and the next run resumes.

### Connection webhook recovery

- New webhook work is retained encrypted with per-item execution state. Keep the KEK versions
  needed to decrypt retained work; losing a key can make recovery impossible. The status API
  exposes metadata, not payloads, upstream references or sender event IDs; see
  [Retained connection webhooks](api.md#retained-connection-webhooks).
- Review the connection's retained status and error before replaying. A `202` replay response
  means the work was queued, not that it succeeded; check status again. An item that may have
  started is not safe to replay merely because a queue attempt occurred. Investigate uncertain
  effects before taking any independent corrective action.
- Before an existing pass can be updated, each retained item binds its exact pass, credential and
  lifecycle generations, holder/link state, connection and release. A new verified item reserves
  its pass ID before creation. Started or uncertain items block holder-transfer start for that
  pass, including a transfer requested by the same item. An old started or uncertain item whose
  pass was not recorded conservatively blocks transfers in its organization. Replay cannot clear
  uncertain items: preserve the encrypted evidence, reconcile the upstream and pass state, and
  escalate for authorized manual review. Do not delete the work or alter its state just to lift
  the fence.
- Live updates are release-gated. Correct the template's approval if work is blocked, then
  explicitly replay: only items proven blocked without effects may rebind to the current approved
  release. Other work remains bound to its captured release; a changed release can prevent replay.
  Do not bypass a release conflict by changing retained data.
- Changes to a connection's generation, mode or organization make old jobs stale; stale work is
  acknowledged as `ignored`, is terminal and cannot be replayed. Review current configuration and
  upstream state before arranging fresh work. Connector reference-mode changes and missing context
  or payload can also prevent replay; restore the required configuration or investigate upstream
  rather than assuming a retry will reconstruct the original event.
- Pre-cutover embedded updates and unbound or deleted references remain quarantined. Only a
  refs-only item for an existing eligible Live-bound pass pinned to the exact current approved
  release may refetch upstream data, with automatic creation and email disabled and the binding
  and release checked again at commit. A queue attempt alone is not evidence that old work had
  no effects. Reconcile quarantined or uncertain items with the upstream system and pass state;
  do not manually replay them as if they were proven new events.
- Legacy event markers and encrypted sources remain retained when completion of every chunk in
  the event cannot be proven, even after processed chunks finish. Queue attempts do not establish
  event-wide completion or justify inferring expiry.

### Pass and bundle email safety

- Queued pass and bundle mail is bound to the reviewed recipient, attachment choice, holder,
  link generation and pass artifact versions. If these change before sending, the row is cancelled
  as `DELIVERY_STALE`; older queued rows without a binding are cancelled as `DELIVERY_UNBOUND`.
  Review the current holder, content and links before requesting a new send. Test-mode mail follows
  the same checks before it is captured.
- Holder changes reserve a new credential generation and immediately revoke the previous public
  link, scanner authority and bundle membership. Other bundle members remain available; create a
  new reviewed bundle for the replacement holder. While provider retirement is pending, neither
  holder can download or use the pass. The worker retries pending transfers and commits the new
  holder only after older provider credentials are retired and fresh Apple and scanner credentials
  are ready. Do not clear a pending reservation or restore an old generation manually.
- Successful transfer removes the prior holder's current per-pass assets and member photo from the
  target artifact and queues their owned R2 objects for bounded, retryable cleanup. Upload
  reservations and rollback candidates remain durable across crashes; do not manually reuse a
  retired object key. Unrecognized legacy namespaces are tombstoned but retained for ownership
  review rather than automatically deleted.
- A static or non-rotatable barcode or lookup fails transfer with `PASS_REISSUE_REQUIRED`: reissue
  the pass with a rotatable credential. Verified holders whose waiting passes need reissue are
  directed to contact the issuer; they are not silently attached. Reconcile uncertain retained
  webhook claims and provider retirement before retrying. No operation can physically erase an
  installed offline Wallet copy, although its old server-backed credentials are no longer valid.
- `partial` with `EMAIL_OUTCOME_UNKNOWN` means the email provider may have accepted the message.
  The worker does not automatically retry that intent. Check the provider and recipient before
  explicitly reviewing and sending a new message; a new send can duplicate one already accepted.
  Provider acceptance is not proof of inbox delivery. A crash immediately before or during the
  external call can also leave this conservative unknown result.

### Event feed kill switch

The `pass_events_feed` trigger journals catalog events into `event_feed` and fans them out to webhook
endpoints. Set the platform setting `events.feed` to `"off"` to skip it without a deploy. Events written
while it is off are never journaled, so webhook endpoints miss them and `GET /events` pollers see a silent
gap; turning it back on does not backfill.

## Runtime decisions

- **workerd versions**: `npm run test:worker` runs on the pool's miniflare (workerd 1.20260815), dev and prod on the root wrangler (1.20261012). The pool pins its own copy until a release catches up. The Dependabot `cloudflare` group tracks it; when one ships, align versions and drop the `overrides` entries in `package.json`. Stay on vitest 4 until the pool supports 5.
- **Placement**: default. `placement: smart` needs a latency comparison against D1 from production Observability data; none exists before launch. Revisit after a week of traffic.
- **Worker-first paths** (`assets.run_worker_first`): every path runs the Worker first, so the host policy sees every page visit, except the files `public/` ships (negated entries). The Worker serves the SPA's pages from `ASSETS` unchanged (`public/_headers` applies), keeps `/api`, `/auth`, `/wallet`, `/p`, `/hooks`, `/health` and `/assets` to itself, and answers an unknown file-like path (`/foo.js`, or a missing hashed chunk that would otherwise be cached immutable as the SPA page) with a 404. Add a file to `public/` and its negated entry in `wrangler.jsonc` together; `tools/wrangler-config.test.ts` fails when they differ. `scan.webmanifest` is the one exception: it goes through the scanner gate. Vite's dev paths (`/src/*`, `/@vite/*`, …) are added only in dev, by `vite.config.ts`. The cost is one invocation per page view.
- **Scanner gate** (`vars.SCAN_ENABLED`): `"1"` in `wrangler.jsonc` for scanner M1. Off, the Worker answers `/scan`, `/scan/*`, `/scan.html`, `/scan.webmanifest` and `/assets/decode-worker-*` with the not-found page (`no-store`); the scan API stays mounted and refuses as before. Tests, e2e and `npm run dev` (`.dev.vars`) set `"1"`. Set it to `"0"` to hide the scanner document during an incident.
- **Baked template sync**: generated templates are the trusted system release exception. Sync
  records a release generation for each supported mode only after verifying its actual assets.
  Missing or inconsistent assets do not produce a usable release. `CF_VERSION` is the
  `version_metadata` binding in `wrangler.jsonc`; sync uses its upload timestamp and an atomic
  adoption fence to reject stale builds. A different build with missing or ambiguous ordering
  metadata fails closed. When adopting an existing legacy baked hash for the first time, the same
  hash can establish the fence; a different hash must have an upload timestamp newer than the
  legacy hash's last sync time. Historical baked preview extras that were never retained require
  their original trusted build bytes and metadata to be recovered; they cannot be reconstructed
  from the pass version alone and remain unavailable rather than being guessed.
- **Passes follow approved releases**: uploads and edits remain drafts. An authorized reviewer
  other than the author approves the exact candidate; a publisher activates it or rolls back to
  a previously approved release as a new generation. Google and Samsung projections require
  independent approval and bind the exact effective Apple release and provider-account identity.
  Samsung publication also requires fresh provider verification. Google candidates can be reviewed,
  but activation and offers remain blocked until issuer approval and replay-safe Save can be verified.
  The minute cron (`passes.stale_reissue`) waits for a release to be quiet for a minute, then
  queues affected active passes separately for each organization and mode. Claims are recorded
  against the scoped release, not the template's global active-version pointer. Voided passes stay.
  A pass whose fields no longer fit the new release stays on its version, is logged as
  `bulk_reissue.pass_failed`, and counts toward the run's `PARTIAL_FAILURE` on Status.
- **Eligible template picker**: `GET /api/v1/templates/eligible` requires an explicit
  organization, mode and Apple provider, and either template-read or pass-read authority for that
  organization. Results are paged and include only effective approved/system releases, with
  release ID, generation, version and hash. `supportsCheckIn` comes from the approved version,
  not a newer draft. This read does not itself run baked sync; newly installed baked choices
  appear after the normal sync has verified and recorded their system releases. A final issuance
  still rechecks authority, release head and asset integrity.
