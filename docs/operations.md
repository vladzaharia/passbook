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
   An existing database (schema 0024) is not deployed this way: follow
   [Cutover](#cutover-from-schema-0024), which splits the run with `--migrate-only` and `--promote`.
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

For passbook.mobile: live passes are in Wallets, D1 is at 0024, migrations 0025-0054 have never run
in production. All data is preserved. The owner runs every remote step; an agent never does.
`test/cutover/` rehearses this order on a 0024 database with every template shape. Rollback is
roll forward only. Design and decisions: `docs/design/authority-epochs.md` §6.

What the new Worker does with 0024 data:

- **Uploaded templates** get a `legacy` live release at their active version from the bootstrap.
- **Baked templates** (unassigned or assigned to an org by PATCH) get a `system` release from the
  baked sync, which the minute cron runs (`templates.sync`). Until it has run, passes of baked
  templates cannot be scanned, refreshed or issued. Normally under a minute after promote.
- **Passes on an older template version** than the release head are refused by the scanner
  (`not_found`) and by refresh (`TEMPLATE_RELEASE_CONFLICT`) until the minute cron's reissue moves
  them (`template.reissue_started`, a bulk workflow; holders get a Wallet update). A new baked
  build always makes every baked pass stale.
- **Archived templates** keep their passes in Wallets, but the scanner refuses them
  (`SCAN_PASS_CHANGED`) until the template is active. The bootstrap gives archived templates no
  release.
- **Queued pass emails** carry no binding. The bootstrap binds them to their pass; sent as the
  legacy intent path (`delivery.legacy_intent`). Unbound bundle emails cancel (`DELIVERY_UNBOUND`).
- **Queued pushes** are bound by migration 0045. Queue messages for `connection.webhook` and
  `pass.refresh` built by the old Worker are logged and retained as ignored; `email.send` and
  `push.deliver` messages carry only an outbox id and work.
- **Memberships**: the bootstrap makes `--owner` `org_admin` in every non-deleted org. Other
  platform admins (`wallet-admins`) need no membership.

### Deploy mode

Use the normal version flow, split in two runs: `--migrate-only`, bootstrap, `--promote`.
`wrangler.jsonc` is identical at `main` and HEAD (`git diff main HEAD -- wrangler.jsonc` is empty):
same `wallet-jobs` and `wallet-jobs-dlq` consumers, same four workflows, same `ScanHub` Durable
Object, same crons. Nothing needs `wrangler deploy` to register. `--first` would serve the new
Worker the moment the migrations finish, before the bootstrap binds queued mail and releases.
Confirm production runs the `main` config: `npx wrangler deployments list` shows a deploy newer than
the last commit to `wrangler.jsonc` on `main`. If `wrangler.jsonc` differs, stop and decide again.

### Pre-checks

1. `npm run check` passes on the commit to deploy. A second person reviews the diff and this plan.
2. `npm run deploy:check -- --secrets` prints "ready to deploy".
3. `npm run deploy` (dry run) prints the plan. The owner has signed in once (a `users` row).
4. D1 Time Travel: `npx wrangler d1 time-travel info wallet-platform` and note the bookmark. The
   deploy records its own in `.wrangler/d1-bookmarks.log`.
5. Queues. Stop sources of new work (connection syncs, broadcasts, bulk actions). Dashboard, Queues:
   `wallet-jobs` and `wallet-jobs-dlq` at zero backlog. Then read-only SQL, each as
   `npx wrangler d1 execute wallet-platform --remote --command "<sql>"`:

   ```sql verify-outbox
   SELECT kind, state, count(*) AS n FROM outbox
   WHERE state IN ('pending', 'enqueued', 'processing') GROUP BY kind, state
   ```

   ```sql verify-bundle-email
   SELECT count(*) AS n FROM outbox
   WHERE kind = 'email' AND state IN ('pending', 'enqueued', 'processing')
     AND json_extract(payload, '$.bundleId') IS NOT NULL
   ```

   Pending bundle email must be 0 (wait or cancel); pass email is bound by the bootstrap.
6. Archived templates with live passes. These stop scanning after the cutover. Un-archive the ones
   that must keep scanning before Order step 1, so the bootstrap gives them a release:

   ```sql verify-archived
   SELECT t.id, t.origin, p.org_id, count(*) AS passes FROM passes p JOIN templates t ON t.id = p.template_id
   WHERE t.status != 'active' AND p.deleted_at IS NULL AND p.status = 'active' GROUP BY t.id, p.org_id
   ```
7. Passes on an old template version. Expect one bulk reissue per row after the cutover:

   ```sql verify-stale-before
   SELECT p.template_id, p.org_id, count(*) AS passes FROM passes p JOIN templates t ON t.id = p.template_id
   WHERE p.deleted_at IS NULL AND p.status = 'active' AND p.template_version != t.active_version
   GROUP BY p.template_id, p.org_id
   ```
8. Record the counts; they must not drop:

   ```sql verify-counts
   SELECT json_object(
     'users', (SELECT count(*) FROM users), 'orgs', (SELECT count(*) FROM orgs),
     'templates', (SELECT count(*) FROM templates), 'template_versions', (SELECT count(*) FROM template_versions),
     'passes', (SELECT count(*) FROM passes), 'pass_versions', (SELECT count(*) FROM pass_versions),
     'devices', (SELECT count(*) FROM devices), 'registrations', (SELECT count(*) FROM registrations),
     'scans', (SELECT count(*) FROM scans), 'outbox', (SELECT count(*) FROM outbox),
     'api_keys', (SELECT count(*) FROM api_keys), 'sessions', (SELECT count(*) FROM sessions),
     'download_tokens', (SELECT count(DISTINCT download_token) FROM passes),
     'auth_tokens', (SELECT count(auth_token) FROM passes)) AS counts
   ```

### Temporary WAF rule

Cloudflare console, passbook.mobile zone, Security, WAF, Custom rules. Name `cutover`, action Block,
custom response 503 `text/plain`, body `Maintenance. Back in a few minutes.` Create it first in the
list and deploy it before step 1; delete it in step 6. The expression:

```
(http.host in {"passbook.mobile" "wallet.plrs.im"}
  and http.request.method in {"POST" "PUT" "PATCH" "DELETE"}
  and (starts_with(http.request.uri.path, "/api/v1/holders/")
    or starts_with(http.request.uri.path, "/api/v1/passes")
    or starts_with(http.request.uri.path, "/api/v1/me/passes/")))
```

Why these paths. Between migrate and promote the old Worker serves the new schema, and trigger
`pass_credential_transfer_required` (0042) aborts any write to `holder_email`, `owner_user_id`,
`serial`, `auth_token`, `identity_id`, `org_id`, `mode` or a set `scan_code` on `passes`:

| Old write | Route | Result |
| --- | --- | --- |
| assign, reassign, unassign holder | `POST /api/v1/holders/assign`, `assign-bulk`, `reassign`, `unassign`, `clear-block` | fails |
| remove an owned pass from an account | `DELETE /api/v1/me/passes/{id}` | fails |
| create a pass for a holder who has an account (attach hook) | `POST /api/v1/passes` (also API keys) | pass inserted, request fails |
| delete an owned pass | `DELETE /api/v1/passes/{id}` | fails |
| other pass writes | `PATCH`, `/bulk`, `/bulk-reissue`, `/{id}/refresh`, `/rotate-link`, `/remove`, `/restore` | blocked as a precaution |

Not blocked, because pass pages, Wallet updates and scanning must keep working (owner answer 5).
These fail for seconds and succeed on retry after promote: sign-in of a holder who has a waiting
pass (`/auth/oidc/callback`, `/auth/magic/consume`; the attach step aborts), and connection syncs
or webhooks that create a pass for a holder with an account. The old baked sync batch
(`ensureOrgStmt`) fails on an existing org slug, but only runs when the baked hash changes; the old
Worker does not change it. `src/worker/platform/authority-baseline.test.ts` pins the old writes.

### Order

0. WAF rule on. Sources of new work stopped.
1. `npm run deploy -- --migrate-only --apply`. Checks secrets, uploads the version (not serving),
   records a bookmark, applies 0025-0054, stops. The old Worker still serves.
2. Bootstrap. The tool never touches production; it prints the commands:

   ```
   node tools/bootstrap-tenancy.ts --owner <email> --print-remote
   npx wrangler d1 execute wallet-platform --remote --json --file .wrangler/bootstrap-snapshot.sql > .wrangler/bootstrap-snapshot.json
   node tools/bootstrap-tenancy.ts --owner <email> --snapshot .wrangler/bootstrap-snapshot.json
   npx wrangler d1 execute wallet-platform --remote --file .wrangler/bootstrap-tenancy.sql
   ```

   Read the plan the third command prints: one `org ...` line per org, one `template ...` line per
   active uploaded template, one `email ...` line per queued pass email. The snapshot holds download
   tokens; the tool deletes it after reading. Idempotent. Rerun it fresh if anything fails.
3. `npm run deploy -- --promote --apply`. Serves the uploaded version at 100%.
4. Baked sync. The minute cron runs `templates.sync` within a minute. To start it sooner, open
   Admin, Templates while signed in. Then check that every live pass has a release head:

   ```sql verify-heads
   SELECT t.id, t.origin, t.status, p.org_id, count(*) AS passes FROM passes p JOIN templates t ON t.id = p.template_id
   WHERE p.deleted_at IS NULL AND p.mode = 'live' AND p.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM template_release_heads h
       WHERE h.template_id = t.id AND h.mode = 'live' AND h.provider = 'apple'
         AND h.org_scope = CASE WHEN t.origin = 'uploaded' OR t.org_id IS NOT NULL THEN p.org_id ELSE '' END)
   GROUP BY t.id, t.origin, t.status, p.org_id
   ```

   Only archived templates may be listed. Anything else: wait one more minute, then see "If a
   step fails".
5. Verify, one query each:

   ```sql verify-memberships
   SELECT o.id, o.slug FROM orgs o WHERE o.status != 'deleted' AND NOT EXISTS (
     SELECT 1 FROM org_memberships m WHERE m.org_id = o.id AND m.revoked_at IS NULL AND m.roles LIKE '%"org_admin"%')
   ```

   ```sql verify-email-unbound
   SELECT count(*) AS n FROM outbox WHERE kind = 'email' AND state IN ('pending', 'enqueued')
     AND json_extract(payload, '$.intent') IS NULL AND json_extract(payload, '$.bundleId') IS NULL
   ```

   ```sql verify-stale-after
   SELECT p.template_id, p.org_id, count(*) AS passes FROM passes p JOIN templates t ON t.id = p.template_id
   JOIN template_release_heads h ON h.template_id = t.id AND h.mode = 'live' AND h.provider = 'apple'
     AND h.org_scope = CASE WHEN t.origin = 'uploaded' OR t.org_id IS NOT NULL THEN p.org_id ELSE '' END
   JOIN template_releases r ON r.id = h.release_id
   WHERE p.deleted_at IS NULL AND p.mode = 'live' AND p.status = 'active' AND p.template_version != r.version
   GROUP BY p.template_id, p.org_id
   ```

   Memberships and unbound mail return no rows or 0. Stale shrinks to 0 as the reissue runs. Rerun
   `verify-counts`: nothing below the pre-check numbers (`scans`, `outbox`, `pass_versions` only
   grow). Then in the product: the owner sees each org's passes, one baked and one uploaded pass
   scan, a pass in Wallet refreshes (push), `GET /health` is 200, Status is green, and
   `wallet-jobs-dlq` is empty.
6. Delete the WAF rule. Restart the stopped sources.

### If a step fails

Roll forward. Never restore D1 to undo a deploy; a restore drops every write since the bookmark
(registrations, scans, tombstones).

| Where | What to do |
| --- | --- |
| Pre-checks or step 1 before the migration | Nothing changed. Fix and rerun. |
| Step 1, a migration errors | Applied migrations stay; the old Worker keeps serving. Fix the failing migration file (it never ran in production) and rerun `--migrate-only --apply`; it resumes. Keep the WAF rule on. Last resort only if no fix is possible: Time Travel restore to the step 1 bookmark, which loses Wallet registrations and scans written since. |
| Step 2 | Stop before promote. The SQL is idempotent: take a fresh snapshot and rerun. A refused statement names the trigger; fix the tool, not the data. |
| Step 3 | The version stays uploaded and the old Worker serves. Rerun `--promote --apply`. |
| Step 4, heads missing after two minutes | Cron or sync failed: check logs for `templates.baked_sync_skipped` or `BAKED_RELEASE_CONTENT_UNAVAILABLE` (baked assets missing from ASSETS). Fix and ship a new version. Scanning of baked passes stays refused until then. |
| Step 5 fails, Worker misbehaves | Ship a fixed version through the same two-run flow (`--migrate-only` finds nothing to migrate). Emergency degraded mode only to stop an outage: `npx wrangler queues pause-delivery wallet-jobs`, keep the WAF rule, promote the previous version with `npx wrangler versions deploy <previous>@100%`, then roll forward and resume delivery. The old Worker is not supported on the migrated schema. |

## Day two

- **Migrations**: `npm run deploy` handles them. Manual: `npx wrangler d1 time-travel info wallet-platform`,
  note the bookmark, then `npx wrangler d1 migrations apply wallet-platform --remote`.
  Migrations are forward-only: roll back a bad release by promoting the previous Worker version
  (`npx wrangler versions deploy <previous>@100%`), not by restoring D1. A restore is the last
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
- **KEK rotation**: add `KEK_V2` (`wrangler secret put KEK_V2`). The highest version encrypts;
  keep older ones for existing data. The oldest KEK also derives scan PIN, asset-grant and
  credential-tombstone HMAC keys. The credential-reference keyset sentinel initializes only when
  no prior keyed references or proof provenance remain, including tombstones, scanner grants and
  retention proofs, retained webhook/workflow bindings and native-provider history.
  Plain unsigned legacy scan events do not prevent initialization, but remain untrusted and are
  never promoted to authenticated history merely because a sentinel was installed.
  Removing or changing the oldest KEK causes a commitment mismatch: scanner, transfer, provider
  and connection credential-reference operations fail closed. Restore the original KEK, confirm
  the deployed keyset commitment matches the retained records, then retry the blocked operation.
  If existing reference data lacks a sentinel, escalate for a separately audited bootstrap or
  rekey while the original key remains available; no bootstrap or rekey tool is currently
  implemented. Never delete evidence or reset the sentinel to bypass the fence.
- **Status**: admin console, Status. Dead letters in `wallet-jobs-dlq` show there.
- **Suspended org**: public pages, Apple updates, pushes, syncs and webhooks stop for it.
- **Icons and social image**: `node tools/build-icons.ts` after the mark or the wallet art changes,
  then commit `public/`. `tools/site-meta.test.ts` checks sizes, the manifest and the heads.

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
