# Operations

Procedures are Ledge runbooks in [`docs/runbooks/`](runbooks/): runnable notes, one per procedure. Anything that touches production is for the owner: agents never deploy or use `--remote` (AGENTS.md). This page keeps the reference prose that is not a procedure. Attach the repo root as a Ledge workspace to run them (`.ledgeignore` hides everything else).

| Area | Runbooks |
| --- | --- |
| Local | [Local Dev Setup](runbooks/local-dev-setup.md), [Local Demo Data and Visual Sweep](runbooks/local-demo-and-visual-sweep.md), [Local Mock Wallets](runbooks/local-mock-wallets.md) |
| Go-live | [Go-Live Polaris ID Client](runbooks/go-live-polaris-id.md), [Go-Live Apple Signing and APNs](runbooks/go-live-apple-signing.md), [Go-Live Secrets](runbooks/go-live-secrets.md), [Go-Live Provision](runbooks/go-live-provision.md), [Deploy First](runbooks/deploy-first.md), [First Admin and Device Test](runbooks/first-admin-and-device-test.md) |
| Deploy | [Deploy](runbooks/deploy.md), [Deploy Promote and Baked Sync](runbooks/deploy-promote.md), [Automatic Deploys Setup](runbooks/automatic-deploys-setup.md), [Rollback](runbooks/rollback.md), [Rollback Move Deploy Tag](runbooks/rollback-move-deploy-tag.md) |
| Database | [D1 Manual Migrations](runbooks/d1-manual-migrations.md), [D1 Time Travel Restore](runbooks/d1-time-travel-restore.md), [Pre-Migration 0202 Check](runbooks/pre-migration-0202-check.md), [R2 Receipt Lock Remove](runbooks/r2-receipt-lock-remove.md) |
| Keys | [KEK Rotation](runbooks/kek-rotation.md), [KEK Retire](runbooks/kek-retire.md), [MAC Key Rotation](runbooks/mac-key-rotation.md), [Platform Certificate Renewal](runbooks/platform-certificate-renewal.md) (legacy identity), [Platform Identity Switch](runbooks/platform-identity-switch.md), [Switch Rollback](runbooks/platform-identity-switch-rollback.md), [Platform Identity Retire](runbooks/platform-identity-retire.md), [Google Wallet Key Rotation](runbooks/google-key-rotation.md) |
| Sign-in | [Polaris ID Group Rename](runbooks/polaris-id-group-rename.md), [Polaris ID Pin Platform Admins](runbooks/polaris-id-pin-platform-admins.md), [Polaris ID Console Group Required](runbooks/polaris-id-console-group-required.md), [Break-Glass Token](runbooks/breakglass-token.md), [Break-Glass Off](runbooks/breakglass-off.md) |
| Polaris binding | [Polaris Binding Turn On](runbooks/polaris-binding-turn-on.md), [Polaris Binding Go Live](runbooks/polaris-binding-go-live.md), [Polaris Binding Key Rotation](runbooks/polaris-binding-key-rotation.md), [Polaris Binding Thaw](runbooks/polaris-binding-thaw.md), [Polaris Binding Compromise](runbooks/polaris-binding-compromise.md) |
| Apple provisioner | [Apple Provisioner Setup](runbooks/apple-provisioner-setup.md), [Apple Provisioner Key Rotation](runbooks/apple-provisioner-key-rotation.md) |
| Apps | [Release Android Reader](runbooks/release-android-reader.md), [Release iOS AltStore](runbooks/release-ios-altstore.md), [Release iOS TestFlight](runbooks/release-ios-testflight.md), [Refresh App Feeds](runbooks/refresh-app-feeds.md), [Play Console Setup](runbooks/play-console-setup.md), [TestFlight Setup](runbooks/testflight-setup.md) |
| Other | [Domain Verify](runbooks/domain-verify.md), [SDK Release Checks](runbooks/sdk-release-checks.md) |

## Local dev

Runbook: [Local Dev Setup](runbooks/local-dev-setup.md) (`npm ci`, `dev:vars`, `db:local`, the mock Polaris ID on :5174, the app on http://localhost:5173).

- `dev:vars` never overwrites. An old `PUBLIC_BASE_URL` on another port must be edited by hand.
- Local dev has no APNs binding and no Analytics SQL binding: push is "unavailable", charts read D1.
- Email asset URLs write `@` as `%40`; dev decodes it for files in `public/` (`vite.config.ts`),
  as production's static assets do.
- Real Pass Type ID certificate: `P12_PASSWORD` plus `npm run credentials -- Pass.p12` (see [Local Dev Setup](runbooks/local-dev-setup.md)); the output is never committed.
- Demo data and visual sweep: [Local Demo Data and Visual Sweep](runbooks/local-demo-and-visual-sweep.md). Sign-in mail is capped at 5 an hour per address, so reruns an hour apart.
- Tests: `npm run test:unit|worker|web`, `npm run test:e2e`, `npm run coverage`.
- e2e runs the dev server or, in CI, the built preview. Both raise `RL_SCAN_PAIR` (30 a minute in production) to 100,000: `vite.config.ts` for dev, `tools/e2e-server.ts` patches the built `wrangler.json` for preview. A worker test covers the real limit.
- `npm run gen` rewrites `src/generated/*` and `worker-configuration.d.ts`. Commit the result.
- Changelog: the integration PR runs `npm run changelog:release` and commits the dated file; `deploy --apply` only warns while `unreleased.json` has entries.

## Go-live checklist

Owner only; agents never deploy. Do in order. `npm run deploy:check` lists what is still a placeholder in `wrangler.jsonc`.

1. [Go-Live Polaris ID Client](runbooks/go-live-polaris-id.md)
2. [Go-Live Apple Signing and APNs](runbooks/go-live-apple-signing.md)
3. [Go-Live Secrets](runbooks/go-live-secrets.md) (Turnstile, KEK, signer, break-glass hash)
4. [Go-Live Provision](runbooks/go-live-provision.md) (D1, queues, R2, the receipt lock, Analytics Engine)
5. [Deploy First](runbooks/deploy-first.md)
6. [First Admin and Device Test](runbooks/first-admin-and-device-test.md)

### Go-live reference

- **Groups**: the `OIDC_*_GROUP` vars hold the values Polaris ID sends in the `groups` claim, not the display names. Polaris ID derives them from the display name (lowercase, other characters to `_`): `Wallet Admins` or `wallet-admins` arrives as `wallet_admins`. Matching is exact and case-sensitive, and a test fails any var that is not `[a-z0-9_]`. `OIDC_PLATFORM_ADMIN_GROUP` (`wallet_admins`: every org and the platform scope, developer features included), `OIDC_ADMIN_GROUP` (`wallet_org_admins`: may use the org console; which orgs is PassBook membership), `OIDC_DEVELOPER_GROUP` (`passbook_developers`) and `OIDC_USER_GROUP` (`wallet_users`). Check the real values in the logs of a refused sign-in (`auth.oidc_no_access` lists the groups it received) before a deploy that changes them.
- **Group changes**: [Polaris ID Group Rename](runbooks/polaris-id-group-rename.md), [Polaris ID Pin Platform Admins](runbooks/polaris-id-pin-platform-admins.md) (`OIDC_PLATFORM_ADMIN_SUBJECTS`) and [Polaris ID Console Group Required](runbooks/polaris-id-console-group-required.md) (`OIDC_CONSOLE_GROUP_REQUIRED`).
- **Client**: PassBook registers itself with a Client ID Metadata Document, so `vars.OIDC_CLIENT_ID` is `${PUBLIC_BASE_URL}/auth/oidc/client-metadata.json`. Polaris ID ignores the document's `logo_uri`; the logo is set on the client. Never set Polaris ID's `EMAILS_VERIFIED=true`: a user could then claim any address. Settings, "Trust Polaris ID emails" links and verifies an address only when Polaris ID sends `email_verified: true`.
- **Without the APNs binding** the platform signs passes but cannot push updates.
- **Receipt lock**: the lock rule `retention-receipts` keeps every object under `retention/receipts/` for 2190 days (the D1 receipt retention): no delete or overwrite, the Worker's included. Retention verification relies on it. While it exists the bucket cannot be emptied. Removing it is deliberate: [R2 Receipt Lock Remove](runbooks/r2-receipt-lock-remove.md).
- **Analytics Engine** needs the Workers Analytics Engine entitlement on the account. The `EVENTS` dataset `wallet_events` is created by the first write. Charts query it through the `ANALYTICS_SQL` binding (no API token); if the query fails they fall back to D1 and the overview says which source it used.
- **Deploy tool**: `npm run deploy` refuses on placeholders or an unset required secret, uploads a Worker version (not serving yet), records a D1 Time Travel bookmark in `.wrangler/d1-bookmarks.log`, applies remote migrations, then promotes the version. Never run `wrangler deploy` or `wrangler versions upload` for the main Worker yourself: only `npm run deploy` checks the build stamp and scans `dist/` for the e2e release. The first deploy, and any release that adds a queue consumer, a workflow or a Durable Object class, uses `--first` ([Deploy First](runbooks/deploy-first.md)); a database that still lacks `0029_org_memberships` is refused (see [Cutover](#cutover-from-schema-0024), which is complete). Later releases: [Deploy](runbooks/deploy.md).
- **Device acceptance** (real iPhone) is the last step of [First Admin and Device Test](runbooks/first-admin-and-device-test.md).

## Automatic deploys

`.github/workflows/deploy.yml` deploys every green commit on `main`. Agents never deploy.

- **Trigger**: the `ci` workflow finishes successfully for a push to `main`. The deploy checks out that run's `head_sha`, never a PR and never a newer unchecked commit. Runs queue (`production-deploy`, never cancelled).
- **Order**: the tag `deployed/production` marks the last deployed commit. A run whose commit is already contained in the tag is skipped, so an older run cannot roll production back.
- **Steps**: proof that the `ci` run for the same SHA passed the jobs `check`, `coverage-node-merge` and `coverage-worker-merge` (typecheck, biome and `check:rules` are not re-run; `ci` ran them on that commit), gen (tree must stay clean), `deploy:check -- --secrets`, build (tree must stay clean), `npm run deploy -- --apply [--first]`, move the tag, smoke checks, job summary (sha, version now serving, migrations that were pending).
- **`--first`**: chosen by `tools/deploy-needs-first.ts`, which diffs `wrangler.jsonc` at the tagged commit against the new one and flags added workflows, queue consumers, Durable Object classes and exports, and custom domains (the things only `wrangler deploy` registers). No tag means `--first`. The step log names the reason.
- **Smoke checks** (against `https://passbook.mobile`): `/`, `/login`, `/admin`, `/developers`, `/scan` return 200; `/api/v1/orgs` returns 401; `developers.passbook.mobile` and `wallet.plrs.im` return 308. A failure fails the job; the summary prints the previous version id.
- **No secrets**: the run ends with a notice and succeeds, nothing is deployed, and the tag does not move. Once the secrets exist, the next green main commit deploys everything since.
- **Roll back** (by hand; migrations are forward-only, so prefer a fix-forward commit): [Rollback](runbooks/rollback.md). Then fix main; the next green commit deploys again. To redeploy an older commit, move the tag back first: [Rollback Move Deploy Tag](runbooks/rollback-move-deploy-tag.md).
- **Owner setup** (once): [Automatic Deploys Setup](runbooks/automatic-deploys-setup.md). Manual deploy: [Deploy](runbooks/deploy.md).
- **Alternative**: Cloudflare Workers Builds connected to the repo needs no GitHub secret but builds outside the `ci` gate, the secret check, the `--first` logic and the smoke checks. Use GitHub Actions.

## Apple provisioner

`workers/apple-provisioner` is a separate Worker that holds the App Store Connect key. The main Worker reaches it only through the `APPLE` service binding; it has no route and no `workers.dev` host. Its D1 holds the allowlist (`asc_pass_types`) and the append-only call ledger (`asc_calls`). Limits: 30 calls a minute and 200 a day per method, one revoke an hour, at most 2 certificate orders per pass type in 30 days and 1 revoke per pass type in 7 days, all fail closed (`ASC_BUDGET`). It logs `provisioner.cert_ordered`, `provisioner.cert_revoked` and, past half the daily budget, `provisioner.budget_high` (error); alert on the last two.

Setup (owner, once): [Apple Provisioner Setup](runbooks/apple-provisioner-setup.md). Deploy the provisioner before the main Worker: Cloudflare fails a main Worker deploy if the `APPLE` service binding names a Worker that does not exist yet. Until then `ascClient` reports `ASC_UNAVAILABLE`.

Platform certificates: the provisioner never orders or revokes for `pass.im.plrs.wallet`, `pass.mobile.passbook.wallet` or any identifier outside `pass.mobile.passbook.<handle>` and the two platform slots (`pass.mobile.passbook`, `pass.mobile.passbook.devtest`). Order and renew the legacy one yourself in the developer portal (or Xcode) with your own Apple ID, then upload the result as `SIGNER_PLATFORM_*`. Nothing the main Worker can call does this.

Revoke: the provisioner refuses to revoke the newest certificate of a pass type, and any platform certificate (revoke those by hand in the developer portal). It revokes a certificate only when a newer one of the same pass type was ordered at least 24 hours earlier and the main Worker has since called `reportCertificateActive` for it, and at most once per pass type in 7 days. The main Worker calls `reportCertificateActive` after it activates a new certificate.

Trust boundary: the service binding, not the lint rule (`tools/check-apple-binding.ts`), is the boundary. The rule also fails `env['AP'+'PLE']`, a const key, computed `env[key]`, `Object.values(env)` and copies or rest spreads of the env; files reviewed to read by key are listed in `DYNAMIC_ENV_OK`. Anyone who can deploy Workers in the account can bind to or redeploy the provisioner, so scope Cloudflare API tokens and never give CI a token that can deploy `apple-provisioner`.

Rotate the key: [Apple Provisioner Key Rotation](runbooks/apple-provisioner-key-rotation.md). Compromise: revoke the key in App Store Connect. Losing it stops automated renewal only; manual upload still works. Calls: `apple-provisioner` D1 table `asc_calls`.

## Polaris ID binding

`workers/polaris-binding` is a separate Worker that holds the Polaris ID API key and is the only place PassBook writes to Polaris ID. The main Worker will reach it only through an `IDP` service binding (entrypoint `PolarisBinding`); it has no route and no `workers.dev` host, and `fetch` answers 404. Its D1 (`polaris-binding`) holds the signup tokens it minted (id and SHA-256, never the value), the accounts it knows (`idp_subjects`: created, linked, external), the grants that say which roles it added and may take back (`idp_grants`), a 10-minute health cache, per-run breaker counts, freezes (`idp_freezes`) and the append-only call ledger (`idp_calls`). The migration is `migrations/0001_binding.sql`.

On Polaris ID v2.19.3 an API key carries no scopes: it is a full admin key of the user that made it. So the key lives only here, and the Worker enforces its own policy:

- **Registry, not groups.** `GROUPS` (JSON) maps roles to groups: `console`, `developer` and `support` are writable; `platform_admin` and `users` are `protected` and only read. A role may be absent (not projected). No method takes a group id or name. Every writable name must start with `GROUP_PREFIX` (`passbook_`) and may not equal a protected name. A write carries every group outside the registry through unchanged.
- **Groups.** Three kinds are managed: role groups (the registry), custom groups the binding creates (name `CUSTOM_GROUP_PREFIX` + key, default `passbook_g_`, at most `CUSTOM_GROUP_LIMIT`, default 50) and adopted groups the owner lists in `ADOPT_GROUPS` (`{"key": "<group id>"}`; the live name is recorded at first sight and a later rename blocks writes). A role without an `id` in `GROUPS` can be created by `ensureRoleGroup`, which also adds the PassBook client to its allowed clients (the only client write). Names never change through PassBook, only the friendly name. `deleteGroup` removes only an empty custom group the binding made, one per run. Every other group is carried through every write unchanged. If a crash leaves a pending group and health abandons it (for example after clock skew), the group may still exist in Polaris ID: add it to `ADOPT_GROUPS` to manage it, or delete it there. A custom group health cannot find is blocked for that probe; a second miss ten minutes later marks it gone. Callers pass a role or `g:<key>`, never an id or a name.
- **Claims.** `setClaims` edits user and group claims. Keys are free under `passbook_` or exact entries of `CLAIM_KEYS` (JSON list, default empty; never a reserved key or `picture`). Polaris ID replaces the whole set on every write, so the binding reads it, changes only the requested keys, copies the rest unchanged, writes, and reads the whole set back. Values are never stored, ledgered or logged: the ledger holds key names and value lengths. Only accounts the binding knows, never admins or admin group members.
- **Fixed bodies.** A signup is `{ ttl: "1h", usageLimit: 1, userGroupIds }` with the ids of the kind's roles (`member` is console, `developer` is developer, `member_developer` is both), read back. A user update (`setDisabled`) echoes every field of a fresh read except `disabled`, reads back and compares each field; a read missing a field sends nothing.
- **Safe config.** Every write needs a safe config, read from Polaris ID at most every 10 minutes (1 minute after an unsafe answer): every registry group exists with its configured name; signups are `withToken`; email verification is `required`; require user email is on; `emailsVerified` is off; no signup default groups. Any miss is `IDP_UNSAFE_CONFIG`, no write, and an error log `binding.unsafe_config` with the reasons. `health()` also warns `client_open` when the PassBook client is not group-restricted to exactly the registry groups (a warning, not a block).
- **Who.** Never a Polaris ID admin (`isAdmin`), a member of a protected group, or the key's own user; adds never touch a disabled account. `apply` removes only roles with a live grant (a proven signup, or its own add); anything else is skipped as `not_ours`, unless an override removal (platform admin, 2 a minute) says otherwise. `setDisabled` only for accounts a proven signup created that hold no group outside the registry, and enables only what it disabled.
- **Read back.** Every group write is read, `before ± registry ids`, written, read again. A mismatch is `IDP_DRIFT` (error log `binding.drift`), never retried.
- **Budgets**, platform-wide per bucket, fail closed (`IDP_BUDGET`), a minute and a day: `createSignup` and `findByVerifiedEmail` 10 and 50; `apply` add by a user or key 10 and 100, by the system 20 and 200; removal 20 and 200; override removal 2 and 10; `setDisabled` 5 and 20; `snapshot` 1 and 30; `proveSignup` and `deleteSignup` 30 and 300; `lookup` 60 and 1,000; group writes 2 and 10; claim writes 10 and 100, reads 30 and 1,000; adds to custom groups 10 and 100 (system 30 and 500); each group read of a snapshot 60 and 2,000; its own config read 6 and 300; caller dry-run previews have their own bucket (30 and 300). Past half a daily budget it logs `binding.budget_high` (error).
- **Transport.** With the `POLARIS` service binding to the `pocket-id` Worker (same Cloudflare account only; remove the `services` entry to use HTTPS) every Polaris ID request goes through it instead of public HTTPS, with the origin as the request URL and the key header unchanged; without it the Worker uses HTTPS. A failing bound call fails closed (`IDP_UPSTREAM`, error log `binding.upstream_unreachable`), never falling back. `health().transport` reads `binding` or `https`.
- **Breaker.** One `ref` (a drain or reconcile run) may remove 25 roles and disable 5 accounts. The next call answers `IDP_BREAKER`, logs `binding.breaker` (error) and the run stops.
- **Dry run.** `WRITE_MODE` is `dry_run` unless it is `live`; a caller may also pass `dryRun`. Reads happen, writes are computed and ledgered as `dry_run` rows, nothing is sent, and the binding records no grants. Budgets and the breaker still count.
- **Freeze.** `freeze` writes a row and every write then answers `IDP_FROZEN`; reads continue. No RPC thaws. To thaw, run as the owner: [Polaris Binding Thaw](runbooks/polaris-binding-thaw.md). Triggers allow only that one update, once per row.
- **Routes.** Only the routes the RPCs need (`routes.ts`): group, config, API key and OIDC client reads, the key's own user, user search, user and group-id reads, `PUT` of one user and of one user's groups, and signup tokens. Anything else, such as creating or deleting users, one-time tokens, custom claims, group, client, config or key writes, is refused in code.
- HTTP: origin pinned to `POCKET_ID_ORIGIN`, header `X-API-KEY`, no redirects, 5 s, 256 KB; Polaris ID's text is never forwarded. The key, token values, setup links and email addresses are not logged or stored.

Alert on these error codes in Workers Logs: `binding.unsafe_config`, `binding.drift`, `binding.idp_auth`, `binding.budget_high`, `binding.breaker`, `binding.proof_ambiguous`.

Runbooks (owner): [Polaris Binding Turn On](runbooks/polaris-binding-turn-on.md) (setup in dry run), [Polaris Binding Go Live](runbooks/polaris-binding-go-live.md) (after a week of dry run), [Polaris Binding Key Rotation](runbooks/polaris-binding-key-rotation.md) (every 90 days; `health().keyExpiresAt` is the nearest expiry among the user's keys), [Polaris Binding Thaw](runbooks/polaris-binding-thaw.md) and [Polaris Binding Compromise](runbooks/polaris-binding-compromise.md). The SCIM receiver is set up with [SCIM Receiver Setup](runbooks/scim-receiver-setup.md). The main Worker's `IDP` service binding is not in `wrangler.jsonc` yet and follows in a later change.

Next Polaris ID release: it moves admin routes to `/api/admin/...` and adds scoped keys. Recreate the key with `users:invite users:read users:write groups:read audit-logs:read config:read account:api-keys` and set `POCKET_ID_API` to `admin` in the same deploy. Both layouts are covered by `test/polaris-binding`.

Never give CI a Cloudflare token that can deploy `polaris-binding`: anyone who can redeploy it can read the key. On Polaris ID v2.19.3 the key is a Polaris ID admin key, so a leak is identity provider compromise.

### SCIM receiver

Polaris ID pushes users and groups to `https://<PUBLIC_BASE_URL host>/scim/v2` (Users and Groups: list, create, replace, delete) with a bearer token. The receiver never adds a role, session, membership or user, and keeps ids and flags only (`idp_directory_users`, `idp_directory_groups`): no names, addresses or group names. What it does:

- A user switched off, or taken out of every group the PassBook client allows (Polaris ID sends that as a DELETE): after a `lookup` confirms the account is off, gone or in none of PassBook's groups, that subject's Polaris ID sessions end (email-link sessions stay). If it cannot now (binding dry run, frozen or unreachable, breaker open, `lookup` failing or over its 60 an hour, or the subject already revoked this hour), the mirror row gets `revoke_pending` and the minute drain hook ends the sessions once the binding is live. Sessions started after the change stay. Switching the user back on clears it. Ending sessions is per PassBook user, so another Polaris ID account of the same person signs out too.
- A member removed from a group, or in a deleted group: queued for the drain (at most 100 a push and 300 an hour; a subject already backing off keeps its backoff). The drain reads the account and decides.
- A platform admin removed from a group: Polaris ID is asked about each of their accounts (`lookup`); with none in the admin group their admin sessions end within the push and `admin_changed` is filed. More than five at once, a failed lookup or dry run changes nothing here; the daily reconcile decides.

Setup (owner): [SCIM Receiver Setup](runbooks/scim-receiver-setup.md). Token rotation is in the same note.

Limits: a right token gets 600 requests a minute and is never refused for other callers' misses; a wrong token is charged to the `RL_PUBLIC` limiter by network prefix (429 past its limit); user bodies 16 KB, group bodies 256 KB; group pages 100.

Breaker: more than 20 session endings in ten minutes latches it for 24 hours: nothing more ends, rows go `revoke_pending`, and `IDP_SCIM_BREAKER` is logged once. After you have checked the feed, clear it with the `idp.breaker_clear` operation (`POST /api/v1/platform/idp/scim-breaker/clear`, a platform admin signed in with Polaris ID), as in [SCIM Breaker Clear](runbooks/scim-breaker-clear.md); the next minute's sweep ends up to about 20 of what is owed, then it latches again. A row whose confirming lookup keeps failing waits 10 minutes, then 20, doubling to about 5 hours, and does not hold other rows back.

## Platform default identity

New passes sign with the default platform identity: the `signing_identities` row with `is_default=1` and no org. It starts as the env-sourced row `platform` (`pass.im.plrs.wallet`). After a platform setup run, `pass.mobile.passbook` is a second row, issuing but not default.

- **Switch** (`setPlatformDefault`, in `modules/identities/platform-default.ts`). It refuses with `IDENTITY_NOT_READY` unless the target has an active certificate, `issuing=1`, `apns_health='healthy'` and at least one device registered on a pass signed by it (the device test). Then, in one guarded batch: the old default is cleared, the target becomes default, row `platform` gets `issuing=0`, and `identity.platform_default_changed` is audited. A repeat changes nothing.
- **Reverse:** the same call with `platform` as the target. It needs the legacy env material to still sign, and sets `issuing=1` again.
- **Legacy row:** never deleted. It keeps signing and pushing for passes already issued on it, by mTLS (`APNS`). Once its env secrets are removed, `ensurePlatformIdentity` does nothing, the daily check treats it as retired, and a sign on it refuses `IDENTITY_RETIRED` (logged as `identity.platform_retired`).
- **`PLATFORM_PASS_TYPE_ID` stays `pass.im.plrs.wallet`.** The row's pass type is immutable and a changed value stops all legacy signing (`IDENTITY_PLATFORM_ENV_MISMATCH`). `npm run deploy:check` fails if it differs. `PLATFORM_TEAM_ID` stays too.
- **Readers:** setup's shared pass type and the template dry run and previews read the default platform row, not the env vars.
- **Before removing `SIGNER_PLATFORM_*` or the `APNS` binding:** the legacy row is dormant or expired and no pass is registered on it. Both are owner steps.

## Managed identity runs

`IdentityProvision` (workflow binding `IDENTITY_PROVISION`) provisions a managed pass type and certificate for an org (`provision`) and replaces a certificate (`rotate`). The daily hook `identities.rotation_plan` starts a rotate run 60 days before expiry for every `rotation='auto'` identity with no open run. Adding the binding needs `npm run deploy -- --first`.

- Runs are rows in `identity_runs`: `step`, `state`, `error_code`. A run waits as `waiting: apple_unavailable` while the `APPLE` binding is missing and tries again daily for 45 days.
- A failed run is retried by the planner the next day. At 45 days to expiry platform admins get an email and an audit row (`identity.rotation_overdue`); status goes amber at 30 days and red at 14; from 7 days an email goes out daily.
- A rotation never revokes the old certificate.

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

### Before migration 0202 (Samsung schema 1)

0202 refuses to run while any Samsung release was built from a schema 1 projection (it stops with a CHECK failure on `_cw11_no_samsung_schema1`, and nothing is applied). Check first with [Pre-Migration 0202 Check](runbooks/pre-migration-0202-check.md). No rows: apply. Samsung ships dark, so none are expected; if one exists, stop and ask the owner, as the code can no longer retire it.

### Google managed issuers and key rotation (owner steps)

- **Aggregator access.** `issuer.insert` works only for a trusted aggregator's parent issuer. Until Google
  grants it, a managed-issuer run waits as `google_manual_issuer`: make the issuer in the Google Pay &
  Wallet Console, share it with PassBook's service account, then complete the run in Platform.
- **IAM role and first rotation.** Rotation and the daily key inventory call the IAM API as PassBook's own service account, with `roles/iam.serviceAccountKeyAdmin` on itself only, and the first rotation is by hand: [Google Wallet Key Rotation](runbooks/google-key-rotation.md).
- **Alert.** More than two keys, or a key PassBook did not create, raises `wallet.key_unknown` (audit row,
  error log, email to platform admins) once a day. PassBook never deletes such a key: remove it in Google
  Cloud. One key found before the first rotation is the uploaded one and is adopted.

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

Run it with [Local Mock Wallets](runbooks/local-mock-wallets.md) (`WALLET_MOCKS=1 npm run dev` also starts it on :5175, `MOCK_WALLETS_PORT`).

- Google: `/token`, `/walletobjects/v1/{genericClass,genericObject,issuer}`, and `/gp/v/save/<jwt>`
  (open it to record a save). Samsung: `/partner/v1/card/template/<cardId>` and
  `/<cc2>/wltex/cards/<cardId>/{updates,cancels}`. Signatures are not verified.
- Inspect, fail a call, set a Samsung template and reset: [Local Mock Wallets](runbooks/local-mock-wallets.md).
- Worker tests call `createMockWallets().handle(request)` from a stubbed `fetch` (`failNext`,
  `setSamsungTemplate`); see `test/mock-wallets/mock-wallets.test.ts`.
- The Worker redirects provider calls only when `WALLET_MOCK_PROVIDERS_URL` and `PUBLIC_BASE_URL`
  are both plain-http loopback (`wallet-providers/mock-endpoint.ts`). Never set it in
  `wrangler.jsonc` or a deployed secret; a test fails if it appears there.
- Google and Samsung issuance is off (`provider-policy.ts`). `npm run test:e2e:wallets` starts an e2e server with
  both open against the fake (`docs/design/wallet-providers/e2e-release.md`). No other build can open them, and
  deploy refuses a Worker that carries that path.

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

1. **Polaris ID**, before the deploy. OIDC settings → Client ID Metadata Documents → Allowed
   metadata document URLs: add `https://passbook.mobile/auth/oidc/client-metadata.json` (or
   `CIMD_URL_ALLOWLIST` when the UI config is disabled). The `wallet.plrs.im` entry does not match
   it. Until then Polaris ID sign-in fails; break-glass still works.
2. **Deploy**: `npm run deploy -- --apply`. The token needs Workers Routes Write on
   `passbook.mobile` and `plrs.im`. If `passbook.mobile` already has an apex record, delete it
   first; the custom domain creates its own. The deploy applies `migrations/0008_passes.sql`,
   which moves stored web service URLs off wallet.plrs.im (no pass was on a device).
3. **First sign-in** through Polaris ID creates a new client: set its allowed groups
   (`wallet_admins`, `wallet_users`) and its logo as in [Go-live](#go-live-checklist) step 1. User
   ids (`sub`) do not change, so linked accounts carry over; everyone consents once.
4. If passes existed, rebuild their files: Identities → the platform identity → Re-sign.

Sessions are host-only cookies, so everyone signs in again on passbook.mobile. Sign-in links in
recent emails still work through the redirect; a sign-in code requested on wallet.plrs.im does
not (it is bound to that host's cookie), so request a new one.

Verify: [Domain Verify](runbooks/domain-verify.md).

- Sign in with Polaris ID and with an email link on passbook.mobile. Status shows Email Sending
  and Turnstile configured.
- Issue a pass and add it to Wallet: its back shows the passbook.mobile support link, and an
  update reaches the phone.
- Once a rollback is off the table, remove the old Polaris ID client, its allowlist entry and
  `wallet.plrs.im` in the Turnstile widget.

Rollback: revert the change (`routes`, `PUBLIC_BASE_URL`, `REDIRECT_HOSTS`, `OIDC_CLIENT_ID`,
`EMAIL_FROM` and `send_email` move together) and deploy. The old Polaris ID client and allowlist
entry must still exist. Stored web service URLs stay on passbook.mobile: set them back with the
reverse `UPDATE`. Do not restore D1 (see [Cutover](#cutover-from-schema-0024)).
Redirects are uncached, so no browser loops. Everyone signs in again. A pass added to Wallet in
between keeps calling passbook.mobile's web service, and Wallet does not follow redirects: its
holder re-adds it from a new link.

## Platform keys

Runbook: [Platform Keys](runbooks/platform-keys.md). A Platform key (`pbo_`, no organization) holds `platform:*` scopes and reaches the key-callable `/api/v1/platform/*` routes for the owner's automation. It never reaches organization routes. The other flavour, All organizations, holds organization scopes only and never reaches a platform route; the two are never mixed on one key.

- Scopes today: `platform:read` (every `GET` of a key-callable platform route), `platform:settings` (platform settings except `auth.*` and `oidc.*`), `platform:wallet` (the wallet release report and the enable-ready dry run). `platform:groups` and `platform:claims` exist but no route takes them by key yet.
- Mint: a platform admin in a Polaris ID session (not break-glass) with a sign-in in the last 10 minutes. Live only, standard rate tier, an IP range (no wider than a /8), expiry at most 30 days (90 with `platform:read` alone). A key never mints or rotates a platform key.
- Live only while its creator is an active user: disabling the creator stops it at once, and offboarding revokes it.
- Rotate and revoke are a person's, in Platform > API keys. Rotate with an overlap so the automation swaps its secret first.
- Limits: 60 writes a minute per key on platform routes (`RL_PLATFORM_WRITE`, 429 `RATE_LIMITED`) on top of the standard tier. Platform writes accept `Idempotency-Key`.
- Refusals: outside the range, expired, revoked or creator disabled is 401 `INVALID_API_KEY` with no reason; a missing scope is 403 `MISSING_SCOPE`; an organization key on a platform route is 403 `PLATFORM_KEY_REQUIRED`; a route a key never calls is 403 `PERSON_REQUIRED`. Each refusal is audited as `auth.denied`.
- Audit: every write records `api_key`, the key id and no organization. Filter the platform audit log by key to see what a key changed.
- Demo: `node tools/seed-demo.ts` seeds "Ops status" into the local database and prints the file holding its secret, never the secret.
- Organization member routes (invite, resend, revoke, change role) take an organization key with `members:write` (or `members:read` to list) for roles that do not administer. A key never makes, promotes, demotes or removes an administrator (403 `KEY_CANNOT_ADMINISTER`).

## Break-glass admin

Admin sign-in for when Polaris ID is down.

- Create or rotate the token: [Break-Glass Token](runbooks/breakglass-token.md). The token is never printed; the Worker only stores its SHA-256.
- Sign in at `/auth/breakglass` with the token. You get an admin session as "Break-glass admin":
  30 min idle, 4 h max. Every sign-in is in the audit log; failures are logged and rate limited.
- Turn it off: [Break-Glass Off](runbooks/breakglass-off.md), or disable the "Break-glass admin" user in Users. Anything that is not a 64-character hex hash makes the route 404.
- Polaris ID down: deploys still work (the client id is the metadata URL); sign in with
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

### Request access inbox

`vars.ACCESS_REQUEST_EMAIL` in `wrangler.jsonc` (`support@passbook.mobile`) receives the site's Request access form. Mail goes out through the `EMAIL` binding from `EMAIL_FROM`, with reply-to set to the person who asked, so replying answers them. `npm run deploy:check` refuses an empty or invalid value. If the form reports "Your request was not sent", check the logs for `marketing.access_unconfigured` (binding or address missing) or `marketing.access_failed` (send refused). Spam is limited by a hidden field and two rate limits (`RL_ACCESS`, `RL_ACCESS_ALL`); `marketing.access_limited` shows a burst.

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

- **Migrations**: `npm run deploy` handles them; by hand: [D1 Manual Migrations](runbooks/d1-manual-migrations.md). Migrations are forward-only: roll back a bad release by promoting the previous Worker version ([Rollback](runbooks/rollback.md)), not by restoring D1 ([D1 Time Travel Restore](runbooks/d1-time-travel-restore.md) is the last resort and drops every write since the bookmark, including pass tombstones and retired ids). An org created while old code runs has no entitlements row: Features, apply a preset repairs it (the deploy gate lists them). Exception: 0059 and 0065 are a one-way line. Never promote a Worker older than the release that ships them: it cannot read a sealed token (every device call answers 401, a stored MAC would pass its plain compare) and every create, publish and transfer aborts on the new triggers. Roll forward. `npm run deploy` only ever promotes the version it uploaded; the risk is a manual `wrangler versions deploy`. Apply the complete ordered migration batch, including 0042, 0044 and 0046, before routing the new Worker or initializing the credential-reference keyset. The initializer deliberately fails closed while later reference stores are absent.
- **Certificate renewal** (yearly, Apple): runbook [Platform Certificate Renewal](runbooks/platform-certificate-renewal.md). Other identities: admin console, Identities, Rotate certificate (admin session only; `POST /api/v1/identities/{id}/rotate`). Re-sign all passes is on the same page. Passes keep working; the pass type ID must match. Status warns 30 days before expiry.
- **KEK rotation** (add a KEK, move every envelope to it, then delete the old one): runbooks [KEK Rotation](runbooks/kek-rotation.md) (add V2, rewrap, escrow `MAC_ROOT_V1`) and [KEK Retire](runbooks/kek-retire.md) (delete V1). The highest `KEK_V<n>` encrypts. The MAC keys (scan PIN, pair code, asset grant, pass/bundle link and Apple web-service token `h1:`) derive from the root named by `MAC_KEY_VERSION` (default: the oldest); the credential-tombstone key and the other retained-evidence keys (retention proofs, retention receipts, webhook and action references, the keyset commitment) always derive from the oldest root. A root is a KEK, or its `MAC_ROOT_V<n>` (the HKDF-Extract of that KEK: it derives the same keys byte for byte and unwraps no envelope).
  The cron `keys.rewrap` moves the 15 envelope places to the new KEK (about 200 rows a minute) and logs `KEK_REWRAP_RUN`, then `KEK_REWRAP_DONE`; Status, Key rotation, shows it. `MAC_ROOT_V1` opens no envelope but forges every MAC the KEK would: keep it as secret as the KEK. `npm run keys:retire -- 1` is the only gate for deleting `KEK_V1` and refuses unless every condition in the runbook holds.
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
- **MAC key rotation** (availability after a change of MAC root; it revokes nothing): runbook [MAC Key Rotation](runbooks/mac-key-rotation.md). It needs the new root in place (`KEK_V2`) and sets `MAC_KEY_VERSION` and `MAC_KEY_VERSION_PREVIOUS` together as Worker vars (not secrets). The minute cron `tokens.remac` rewrites every pass link, Apple web-service token and bundle link from its sealed copy and logs `TOKEN_REMAC_DONE`. A rotation restores availability only: the sealed copies sit under the KEK that wrapped them until `keys.rewrap` moves them (KEK rotation), and a copy of the database plus that KEK opens every link and device token, so after a KEK_V1 compromise rotate the links (`rotate-link`) and credentials (credential transfer) too. Credential-reference evidence (tombstones, retention proofs, webhook and action references, personalization proofs; bound to the keyset commitment) stays on root 1 (`KEK_V1`, or `MAC_ROOT_V1` once V1 is retired): no rekey tool exists.
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

### Wallet migration gate

Before a deploy that needs every wallet account on a credential source (PE3), `npm run deploy -- --promote --apply --require-wallet-migrated` runs `wallet-migration-gate` remotely and refuses while it lists a row. A deploy whose pending migrations release a wallet (a flip, below) turns the flag on by itself and also checks before migrating. Only an enrolment that is On issues (0229): a legacy account, an envelope with no source, does not, and no new one can be made (the configure route and the database refuse it). A flip still waits until none is left. Each row is a legacy account with no source. Clear them in the platform wallet page or with `POST /api/v1/platform/wallet-credentials/migrate` (queue), then `.../migrate/resolve` (`assign_platform`, `merge`, `retire`) for the refused ones. Retired accounts and deleted orgs are not listed.

```sql wallet-migration-gate
SELECT a.id, a.org_id, a.mode, a.provider FROM wallet_provider_accounts a
JOIN orgs o ON o.id = a.org_id AND o.status != 'deleted'
WHERE a.credential_id IS NOT NULL AND a.credential_source_id IS NULL AND a.revoked_at IS NULL
ORDER BY a.id
```

### Wallet release

Google and Samsung are released per mode in two places that must agree: `RELEASE` in
`src/worker/modules/wallet-providers/release.ts` (the Worker) and the `wallet_provider_releases` row (the
database's issuance guards, 0229). `npm run check:rules` (check-migrations) and `release-mirror.test.ts` fail when
they differ. The owner's steps (readiness read, enable-ready, flip, rollback) are the runbook [Wallet Provider Flip](runbooks/wallet-provider-flip.md).

| State | New copies, offers, Samsung references | Updates, messages | Voids, removals, transfers, retirement |
| --- | --- | --- | --- |
| `dark` | refused | refused | not sent |
| `released` | per org: plan, then an enrolment that is On | sent | sent |
| `draining` | refused | refused | sent |

The database enforces each column too: while not released, its guards refuse new copies, activations (an un-void
included), offers, references and every operation but a revoke. While draining, Samsung's callbacks on cards
already added are answered without card data, a holder's DELETED is recorded and nothing is promoted.

**Flip** (one PR per provider and mode, Test before Live): change the one cell of `RELEASE` and add a migration
with only this statement (any other way of writing the table fails check-migrations):

```sql norun
UPDATE wallet_provider_releases SET state = 'released', changed_at = <ms> WHERE provider = 'google' AND mode = 'test';
```

Before it merges, read `GET /api/v1/platform/wallet-release` (platform admin, or a Platform key with `platform:read` or `platform:wallet`): a platform credential with a
passing check, no `legacy` enrolment, the intended orgs `issuing` or `ready`, templates released. The deploy
prints `Wallet release: google test -> released (<migration>)` and runs the wallet migration gate before it
migrates, and again before it serves for as long as any wallet is released. It refuses when it cannot read the
pending migrations. It migrates before it serves, and both sides must say `released`, so every step in between
is dark.

**After the flip**, turn on the orgs that set up before it (a recent sign-in is required). The Release card on Platform > Wallet accounts runs the dry run and the apply with exactly this list. A Platform key with `platform:wallet` may run the dry run; the apply is a person's (403 `PERSON_REQUIRED` for a key). The route is:
`POST /api/v1/platform/wallet-release/{provider}/{mode}/enable-ready` lists the Off enrolments that were never
On and would turn On (plan, source, fresh check, Live round trip, no hold, channel not blocked). An enrolment the
org switched Off (`org_off`) or a released hold cleared (`hold_released`) stays Off: only the org turns it back
On. Review the list, then send `{"apply": true, "orgIds": [...]}` with the listed orgs: exactly those turn On,
each with its own audit row. Apply is refused (409) when the list changed and while the mode is not released. Writes go in batches of 20; after a failed batch the earlier ones stay On and the next dry run lists the rest.

**Rollback** is `draining`, never straight to `dark`: the same one-cell PR and one-statement migration with
`state = 'draining'`. Copies already in wallets keep getting voids and removals; badges and offers go away; the
next deploy applies it. Narrower: hold one org (`POST /api/v1/platform/orgs/{orgId}/wallet-enrolments/{mode}/{provider}/hold`)
or revoke one credential.

**Back to dark** only once the readiness report shows `instances.open` at 0 for that provider and mode (copies
that can still be in a wallet: active, revoking, revoked, or with an account and not retired). Merge the dark PR
only then. Otherwise the deploy refuses before it migrates (`sets google test dark while N copies ...`), and every
later deploy waits until those copies are voided or removed, since a merged migration cannot be edited; the
migration itself also aborts as a backstop (`drain it first`).

### Entitlements gate

`npm run deploy -- --apply` (and `--promote --apply`) runs `entitlements-gate` remotely after the migrations and refuses to promote while it lists an org. Each row is an org with no `org_entitlements` row: every key call and guarded session call of that org is refused (`FEATURE_NOT_INCLUDED`), and so are wallet enable and offers, new prints and tag binds (the plan fails closed everywhere). Repair: Features tab, apply a plan (platform admin), or insert `legacy` (Unlimited) by hand.

```sql entitlements-gate
SELECT o.id FROM orgs o WHERE NOT EXISTS (SELECT 1 FROM org_entitlements e WHERE e.org_id = o.id) ORDER BY o.id
```

A plan change that moves a delivery channel (Google, Samsung, Paper, NFC) queues `channel.entitlement`, keyed on the entitlement revision: one apply run per template and mode journals the flips once, in any job order and under retry. An override that expires goes through the same path: the minute hook `entitlements.override_expiry` removes it, makes a revision and an audit row (actor `system`), and queues the run. A preset edit (`PUT /platform/entitlement-presets`, platform admin, step-up when orgs are on it) moves at most 50 organizations per call, each with its own revision, audit row and run. If more are on the preset, the response shows `pendingOrgs`; repeat the call with no `values` to carry on. A different change is refused (`PRESET_MOVING`) until every org has moved. Suspended orgs move too; the editor keeps calling until none wait. The minute hook `entitlements.journal_sweep` looks at changes from a ten-minute window (after a two-minute grace) and queues `channel.entitlement` again when a template with live passes has no run, in any state, covering the revision (a crash between the commit and the queue send); it skips an org an edit has not moved yet or one holding an expired override, since the write that is coming queues its own job. An org more than one edit behind (`gap: true` in its audit row, with `from: null` on every change) has no recorded before: it is journaled as a full reconcile, so its plan-side changes send no `pass.channels_changed`, while template and pass flips still do. The org save follows the same rule.


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

### Outbound webhooks

- **Kill switches.** `events.feed` = `"off"` (above) stops journaling and fan-out for everyone. To stop one endpoint, pause or delete it in Connections, Webhooks; to stop a tenant, disable the endpoint through its API.
- **Disabled endpoints.** After 72 hours of failures with at least 10 failed attempts in a row an endpoint is disabled by the platform: pending deliveries are cancelled (`ENDPOINT_DISABLED`), an audit row `webhook.endpoint_disabled` is written and the log carries `WEBHOOK_ENDPOINT_DISABLED`. The console shows a callout with Resume and Replay failed; there is no email in v1. Resume clears the counters.
- **Limits.** `RL_WEBHOOK_OUT` (10 a minute) covers test sends (key `test:<org>:<mode>`) and single replays (`replay1:`); per-host sends are paced by `RL_WEBHOOK_HOST_ORG` (120 a minute per org) and `RL_WEBHOOK_HOST` (600 a minute across orgs): a delivery over its share waits, uncounted. Bulk replay is one a minute per org and mode, enforced in the first chunk's own batch from its audit row, at most 10,000 deliveries; a failed first chunk answers `503 REPLAY_NOT_QUEUED` and spends nothing. Creates are capped at 20 an hour per org and 10 endpoints per org and mode.
- **Deploy.** Create the queue `wallet-webhooks` (wrangler `queues`) before the first deploy of the delivery engine; the rate limit bindings come from `wrangler.jsonc`.
- **Retention.** Daily `webhooks.retention`: feed rows older than `min(30 d, events retention)`; delivered deliveries after 7 days; failed and cancelled with their feed row; attempts 30 days (test sends 7); secrets a day after expiry.
- **Watching.** Log codes `WEBHOOK_ENDPOINT_DISABLED`, `WEBHOOK_REPLAY_PARTIAL`, `REPLAY_NOT_QUEUED`, `SECRET_UNAVAILABLE` (a secret that no longer opens: check the KEK ring) and `WEBHOOK_TENANT_MISMATCH` (should never appear; treat it as a bug).

### Request log and status notes

`request_log` holds one row per Test call of any org (a Live call is never written; a trigger refuses it): metadata for 7 days (route, status, code, resource id, version date, header presence flags, never a header value). Redacted request and response bodies, at most 8 KB each, are kept 24 hours only in a sandbox or in an org whose admin turned on `requestLog.bodies`; turning it off blanks the bodies already stored. An org keeps at most 2,000 rows an hour and 20,000 in all (`request_log_budget`). The minute cron hook `developer.request_log_purge` purges on a 20-second budget every minute, so a backlog is caught up; reads already hide bodies older than 24 hours and rows older than 7 days.

Public status incident notes are rows of `status_incidents`. Platform admins open and resolve them on Admin > Status ("Public incident notes") or with `POST /api/v1/status/incidents` and `POST /api/v1/status/incidents/{id}/resolve`; each is audited.

`component` is `api`, `apple_push`, `email`, `webhooks`, `google`, `samsung` or none (the whole service); `impact` is `notice`, `degraded` or `outage` (an open degraded or outage note moves the page's overall state). A resolved note stays listed for 14 days.

A refused API key adds fields to its `request.done` line: `code` `INVALID_API_KEY` (the key's 8-character prefix, never the token) or `MISSING_SCOPE` (key id and the scope it lacked).

### Console sign-in strength

The console, the developer tools and every API key mint need a Polaris ID sign-in (a passkey) or break-glass. An email link gives My passes and Account only.

- `vars.OIDC_REQUIRE_AMR` is the ID-token `amr` a Polaris ID sign-in must carry. It ships empty (off). Turn it on with `phr` once Polaris ID 2.19.3 or later is confirmed to emit `amr` (sign in once with the check on in a preview, or watch for `oidc.amr_absent`, code `OIDC_AMR_ABSENT`, logged whenever a token has no `amr` at all). With it on, a sign-in made with an emailed login code (`otp`) restarts once with `prompt=login`, then fails with `PASSKEY_REQUIRED`. If every Polaris ID sign-in starts failing with `PASSKEY_REQUIRED` or the log shows `OIDC_AMR_ABSENT`, set it back to `""` and redeploy.
- Migration 0169 puts every active member of an organization in `console_email_grace` (strong sessions never read it) and, when it found any, sets the platform setting `auth.consoleEmailUntil` to 21 days on (ms). Until then those members' email sessions keep the console and their personal keys keep working. Minting or rotating a key, the developer sandbox and Try it, closing an org and accepting an invitation need a Polaris ID sign-in at once, grace or not. The admin shell shows those members "Use Polaris ID by {date} to keep Admin access."; people with no Polaris ID account yet cannot sign in until one exists, so move the date out if that is not settled. Move the date with the platform settings API (`auth.consoleEmailUntil`, ms), or set it to `null` to end grace now. A database with nobody in grace enforces at once.
- A personal key stops with 403 `KEY_OWNER_NEEDS_IDP` once its owner is outside grace and has no Polaris ID identity; it works again after one Polaris ID sign-in. Service and platform keys are not affected. `api_keys.created_amr` shows how a key's creator signed in.
- Non-admin Polaris ID sessions last 7 days idle and 30 days in all.
- Step-up: sensitive actions (key mint and rotate, org close, reopen and export, admin and integration invitations, webhook and connection secrets, signing identities, `auth.*` and `oidc.*` settings) need a sign-in within the last 10 minutes (`auth_time`). Otherwise 403 `STEP_UP_REQUIRED` with a `signInUrl` that sends Polaris ID `prompt=login&max_age=0`. Polaris ID must honour `max_age=0` and put the new `auth_time` in the ID token. The callback checks it: a step-up whose `auth_time` is older than the flow's start (migration 0179, `oidc_flows.step_up_started_at`, 2 minutes of clock skew allowed) fails with `STEP_UP_NOT_FRESH` ("Polaris ID didn't ask you to sign in again") and logs `STEP_UP_NOT_FRESH`; the old session stays as it was. If every step-up lands there, Polaris ID is ignoring `max_age`. A session with no `auth_time` (an email link, or a provider that sends none) is always stale. Break-glass sessions step up by entering the token again.

### Staff PIN tags

A device's day lock on wrong named PINs (100 a day) clears when the device is re-paired; a person's own lock (50 a day) clears with Unlock or a PIN reset.

A staff PIN tag is `HMAC(scan-pin-tag.v1, orgId:pin)` under MAC root 1, so root 1 plus the database recovers every PIN (a 10^6 search per org). If root 1 is compromised, reset every PIN (Staff tab, "Reset untagged PINs" after clearing the tags, or an admin reset each) and move to a `scan-pin-tag.v2` label in `staff-pin-hash.ts`.

### Closing and purging an organization

`POST /orgs/{id}/close` (a platform admin, or an org admin with `{ confirmSlug }`) sets `status` to `deleted`, `closed_at` and `purge_after` (30 days on). Passes stop updating, writes stop, every org admin is mailed. The admins and PassBook can export meanwhile (`POST /orgs/{id}/exports`, then `.../link`); the archive in R2 lives 7 days, a link 1 hour and one download. A platform admin reopens inside the window with `POST /orgs/{id}/reopen` (the default signing identity comes back); not once a purge has started.

The daily `org_lifecycle.sweep` starts the `org-purge` workflow (one instance per org and day) for every closed org past `purge_after` with no active legal hold. A hold placed at any time stops it where it stands; releasing the hold lets the next sweep finish. The purge first voids every pass (a last voided, expired version, pushed to registered devices; Apple serves a closed org's voided passes only, Google and Samsung revoke through their void path), stamps `purge_voided_at` and waits seven days; no row goes before that, enforced in each delete. It then soft-deletes the passes, waits up to seven more days for Wallet providers to let go, deletes every table of `PURGE_STEPS`, the org's R2 prefixes, removes the org's R2 prefixes (prints, branding, template files and uploads, import sheets, exports, member photos), then writes a `org_purge` retention receipt and scrubs the org row to a stub (id, slug, status, audit rows and receipts stay). `blocked` or `incomplete` in the log (`ORG_PURGE_VOID`, `ORG_PURGE_BLOCKED`, `ORG_PURGE_INCOMPLETE`) means a pass or table could not go yet; tomorrow's sweep retries.

The `ORG_EXPORT` (`wallet-org-export`) and `ORG_PURGE` (`wallet-org-purge`) workflows are new bindings: the first deploy needs `--first`.

### Personal organizations

A personal org belongs to its owner and is on Unlimited. Platform lists, counts and the wallet enrolment list leave it out; the directory page, close, reopen and features answer `403 ORG_PERSONAL` for any admin but the owner, and nobody, the owner included, writes its plan or overrides.

Deliberate oversight stays: any platform admin may suspend one (break-glass; step-up; audit `org.suspend` with `personal` and `override`), a wallet enrolment hold works on it, disabling a user suspends their personal org, and only another admin can lift a suspension the owner did not place. Platform legal holds and retention receipts also cover personal orgs, and purge and retention jobs run as the system. The audit trail names the org "Personal org of <owner>".

### Printed ticket PDFs

PDFs are drawn in the Worker with pdf-lib from the same content and layout boxes as the print page. Text is Rubik and JetBrains Mono, embedded as subsets from the static assets (`public/fonts/pdf/`, rebuilt by `tools/build-pdf-fonts.sh`), so names in Latin, Latin extended and Cyrillic stay real text. A word with a character Rubik lacks is set whole in Noto Sans (`NotoSans-{Regular,Bold}.ttf` beside them, source in `assets/fonts/noto/`, rebuilt by `tools/build-noto-fonts.sh`), embedded only in PDFs that need it, so Vietnamese and Greek stay real text. A character neither font has (CJK, emoji, Hebrew, Arabic) becomes its base letter or "?", logged once per PDF as `PRINT_PDF_TEXT_LOSSY`. The print page and previews add the same Noto Sans (`public/fonts/noto/`, copied by `npm run gen`) behind Rubik, and warn only for scripts neither font has. Logo and art PNGs go through the bounded decoder (`pdf-png.ts`) and are shrunk to 300 dpi at their size on paper; an animated, interlaced, oversized (over 2 M pixels) or inflate-bomb file is left out and the PDF is drawn without it (`PRINT_PDF_IMAGE_INVALID`), as is a missing file (`PRINT_PDF_IMAGE_MISSING`) or any distinct image past 12 in one PDF (`PRINT_PDF_IMAGE_LIMIT`). The cache fingerprint includes each image's etag, so a replaced logo or art redraws. PDFs are cached in R2 under `prints/{orgId}/{passId}/{printId}.pdf`, valid while the pass version and the drawing fingerprint (design, content, code, test mode, print number, image names, `PDF_RENDER_VERSION`) match; bump `PDF_RENDER_VERSION` in `pdf-render.ts` when the drawing changes. Bulk files are under `prints/{orgId}/bulk/`. The daily `prints.pdf_sweep` deletes PDFs of ended prints and bulk files after 24 h.

#### Paper sizes

`paper.size` (src/passkit/template/paper-sizes.ts) is one of `a4`, `letter`, `half` (210x148), `half-letter` (215.9x139.7), `cr80` (85.6x54 card), `cr80p` (54x85.6 card), `stub` (139.7x50.8, 2x5.5 in, QR beside the text), `atb` (187.325x82.55, the IATA ATB document, 7.375 in), `a6` (148x105), `dl` (210x99, the one-third-A4 insert). QR is at least 30 mm everywhere. Code 128 needs 0.25 mm bars (83 mm symbol), so it is offered on `a4`, `letter`, `half`, `half-letter`, `atb` and `dl` only; elsewhere the schema reports `PAPER_BARCODE` and the page draws QR. A template with no `paper` block prints on Letter when `org.timeZone` is a US or Canadian zone, A4 otherwise; a block's own size stands. Staff prints use the exact page size. A holder prints at home, so a card or strip size (`cr80`, `cr80p`, `stub`, `atb`, `a6`, `dl`) goes on the region's sheet (Letter in the US and Canada, A4 elsewhere) at true size with corner cut marks: a strip is one face; a card is a fold, the faces meeting on the long edge, a landscape card's back turned half a turn so it reads upright once folded (a portrait card's stays upright, as it turns on a vertical edge), with a dashed fold line and 1.5 mm of bleed past the cut on the full-colour front. `paper.sheet` (`a4` or `letter`) overrides the region's sheet for the holder; on a page or half-sheet size it is ignored with the `PAPER_SHEET` warning.


## App distribution

Install page: https://vladzaharia.github.io/passbook/ (GitHub Pages, workflow-built). Workflows:

- `Android Reader`: tag `android-vX.Y.Z` from main. Signed APK, AAB and checksums go to the GitHub release; AAB goes to Play internal testing when `PLAY_SERVICE_ACCOUNT_JSON` is set.
- `iOS AltStore`: tag `ios-vX.Y.Z` from main, or dispatch with a version. Unsigned IPA and checksums go to the release.
- `iOS TestFlight`: dispatch from main. Signed build to App Store Connect.
- `Apps feeds`: after a release, after the two workflows above, or by hand. Downloads every `android-v*` and `ios-v*` release, builds the F-Droid repo and the AltStore source, and deploys Pages. Releases made by `GITHUB_TOKEN` don't fire `release`, so it follows the workflow runs.

Feeds:

- AltStore and SideStore: `https://vladzaharia.github.io/passbook/altstore/source.json`, id `mobile.passbook.source`.
- F-Droid and Droid-ify: `https://vladzaharia.github.io/passbook/fdroid/repo`, SHA-256 fingerprint `B1487911B4DCC4D9B797DE9E7A1500245FD27171A90C807A1AB0FF352ABD2425`. The job fails if the index key doesn't match `FDROID_REPO_FINGERPRINT`.
- Obtainium: `obtainium://add/https://github.com/vladzaharia/passbook`.

Install by channel:

- AltStore, SideStore: add the source, install PassBook Scanner. Free Apple ID: 7-day refresh, 3 apps, and NFC Tag Reading may be missing after re-signing.
- F-Droid, Droid-ify: add the repo with the link or QR on the install page; confirm the fingerprint.
- Obtainium: add the GitHub URL.
- TestFlight internal: add the tester to the internal group; the build appears after processing. External: add a group, submit for Beta App Review, share the public link (`TESTFLIGHT_PUBLIC_URL`).
- Play internal: add testers' emails to the internal list, send them the opt-in link (`PLAY_INTERNAL_URL`).

Secrets and variables: `ANDROID_READER_KEYSTORE_B64`, `ANDROID_READER_SIGNING_PASSWORD` (app key); `FDROID_KEYSTORE_B64`, `FDROID_KEYSTORE_PASS`, variables `FDROID_KEY_ALIAS`, `FDROID_REPO_FINGERPRINT` (repo index key, different from the app key); `PLAY_SERVICE_ACCOUNT_JSON`, optional variables `PLAY_INTERNAL_URL`, `PLAY_RELEASE_STATUS`, `TESTFLIGHT_PUBLIC_URL`; `APPLE_TEAM_ID`. Losing the F-Droid index key means everyone re-adds the repo.

Owner setup: [Play Console Setup](runbooks/play-console-setup.md) and [TestFlight Setup](runbooks/testflight-setup.md). Releases: [Release Android Reader](runbooks/release-android-reader.md), [Release iOS AltStore](runbooks/release-ios-altstore.md), [Release iOS TestFlight](runbooks/release-ios-testflight.md) and [Refresh App Feeds](runbooks/refresh-app-feeds.md).

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

## Recording wallet contract fixtures

See `docs/runbooks/record-wallet-fixtures.md` (owner only).

## SDK release checks

Runbook: [SDK Release Checks](runbooks/sdk-release-checks.md). Run before publishing; publishing is the owner's.
