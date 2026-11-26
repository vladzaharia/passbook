---
tags: runbook, polaris-id, polaris-binding, production
confirm: true
profile: passbook-polaris-binding
---
# Polaris Binding Turn On

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

One-time turn-on of `workers/polaris-binding`, the separate Worker that holds the Polaris ID API key and is the only place PassBook writes to Polaris ID. It has no route and no `workers.dev` host. It starts in dry run (`WRITE_MODE` `dry_run`): reads happen, writes are computed and ledgered, nothing is sent. Policy and budgets: [docs/operations.md](../operations.md#polaris-id-binding).

Your part is five steps. Set up (step 4) creates the groups, restricts the client, sets the logo and the SCIM push; none of that is manual any more.

On Polaris ID v2.19.3 an API key carries no scopes: it is a full admin key of the user that made it. Treat it as identity provider access, and never give CI a Cloudflare token that can deploy `polaris-binding`.

## Prerequisites

- Profile `passbook-polaris-binding` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `POCKET_ID_API_KEY` (the key from step 2).
- Set up needs PassBook's Client ID Metadata Document client: `PASSBOOK_CLIENT_ID` in `workers/polaris-binding/wrangler.jsonc` is the metadata URL (`https://passbook.mobile/auth/oidc/client-metadata.json`). It refuses a plain registered client id, so a registered client must be moved to the metadata URL first ([[Go-Live Polaris ID Client]]).
- You are in the platform admin group (`wallet_admins`). PassBook never writes it.

## 1. Polaris ID settings (UI)

Skip if PassBook sign-in already works; Set up shows any miss. In Application Configuration set:

- Enable User Signups: **Signup with token**
- Email verification: **Required**
- Require user email: **on**
- Signup default groups: **none**, and no `passbook_*` default custom claims
- Emails verified: **off**
- Email login code for unauthenticated users: **off**
- Client ID Metadata Documents: the PassBook metadata URL is allowed ([[Go-Live Polaris ID Client]], step 1)

## 2. Binding user and key (UI)

Create a Polaris ID admin user `passbook-binding` with a verified address you control, sign in as it once, and create an API key `passbook-binding` with a 90-day expiry. Add it to the profile as `POCKET_ID_API_KEY`.

## 3. First deploy

One command. It creates the D1 `polaris-binding` only if it does not exist, writes its id into `workers/polaris-binding/wrangler.jsonc`, applies the migrations, puts the key over stdin and deploys the Worker. It never prints the key and writes only to the binding Worker's own database, secret, config and deployment. It stops without running anything if a profile variable is missing, and it is safe to run again.

```sh name=check-profile confirm=no
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID POCKET_ID_API_KEY; do [ -n "$(printenv "$v")" ] && echo "$v set" || echo "$v MISSING"; done
```

```sh name=first-deploy confirm="Create the polaris-binding D1 if absent, apply its migrations, set POCKET_ID_API_KEY and deploy the polaris-binding Worker to production?"
npm run binding:first-deploy
```

Commit the D1 id it wrote, then ask an agent to merge it. CI never deploys this Worker.

```sh name=show-config-change confirm=no
git diff --stat -- workers/polaris-binding/wrangler.jsonc
```

### Does Wrangler create the D1 on deploy?

Yes, on the pinned Wrangler (4.158.0). `wrangler deploy` provisions a D1 binding that has no `database_id`: it connects an existing database named `database_name`, or creates it. That is on by default (the hidden `--experimental-provision` flag). Two things keep the tool anyway: the shipped placeholder id counts as a set id, so provisioning would not run until it is removed, and `d1 migrations apply` needs the database before the first deploy. The tool also commits the id so every later deploy is explicit. If you drop the id from the config, deploy creates the database and you apply migrations after it.

## 4. Set up (UI)

Settings, Polaris ID, Set up: **Preview**, then **Apply**. It places the role groups, allows them on the PassBook client, restricts the client, sets the logo and creates the SCIM push with a token it keeps in D1. Writes stay in dry run until [[Polaris Binding Go Live]], so Apply before then computes and ledgers each write without sending it.

## 5. Check the card

Settings, Polaris ID shows the binding healthy: dry run, transport `binding`, the group names, no warnings and the key expiry. If every group read answers 404, `POCKET_ID_API` does not match the Polaris ID release.

Alert on these error codes in Workers Logs: `binding.unsafe_config`, `binding.drift`, `binding.idp_auth`, `binding.budget_high`, `binding.breaker`, `binding.proof_ambiguous`, `binding.upstream_unreachable`.

## Next

Acknowledge the residual risks with the coordinator, then after a week of dry run: [[Polaris Binding Go Live]]. Key rotation every 90 days: [[Polaris Binding Key Rotation]]. SCIM: [[SCIM Receiver Setup]].

The next Polaris ID release moves admin routes to `/api/admin/...` and adds scoped keys. Recreate the key with `users:invite users:read users:write groups:read audit-logs:read config:read account:api-keys` and set `POCKET_ID_API` to `admin` in the same deploy.
