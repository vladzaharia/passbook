---
tags: runbook, polaris-id, polaris-binding, production
confirm: true
profile: passbook-polaris-binding
---
# Polaris Binding Turn On

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

One-time setup of `workers/polaris-binding`, the separate Worker that holds the Polaris ID API key and is the only place PassBook writes to Polaris ID. It has no route and no `workers.dev` host. Its D1 (`polaris-binding`) holds minted signup tokens, known accounts, role grants, health cache, freezes and the append-only call ledger. It starts in dry run (`WRITE_MODE` `dry_run`): reads happen, writes are computed and ledgered, nothing is sent. Policy and budgets are in [docs/operations.md](../operations.md#polaris-id-binding).

The main Worker's `IDP` service binding and the SCIM receiver come in later changes; this note does not cover them. Cloudflare fails a deploy whose binding names a missing Worker, so this Worker goes live first.

On Polaris ID v2.19.3 an API key carries no scopes: it is a full admin key of the user that made it. Treat the key as identity provider access, and never give CI a Cloudflare token that can deploy `polaris-binding`.

## Prerequisites

Profile `passbook-polaris-binding` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `POCKET_ID_API_KEY` (the key from step 4 below).

## 1. Configure Polaris ID (UI)

Polaris ID v2.19.3 or later. In Application Configuration set:

- Enable User Signups: **Signup with token**
- Email verification: **Required**
- Require user email: **on**
- Signup default groups: **none**
- Emails verified: **off**
- Email login code for unauthenticated users: **off**

## 2. Groups and client (UI)

Create the groups `passbook_console`, `passbook_developers`, `passbook_platform_admins` and `passbook_users` (rename the old `wallet_*` groups; ids and members stay). Note each group's id (the UUID in its URL). Do not create `passbook_support` yet.

The PassBook client in Polaris ID is group-restricted with allowed groups exactly those four. Note the client's id.

## 3. Binding user and key (UI)

Create a Polaris ID admin user `passbook-binding` with a verified address you control, sign in as it once, and create an API key `passbook-binding` with a 90-day expiry. Add it to the profile as `POCKET_ID_API_KEY`.

## 4. Create the database

Put the printed id in `workers/polaris-binding/wrangler.jsonc` (it holds a placeholder).

```sh name=d1-create confirm="Create the polaris-binding D1 database in the production account?"
npx wrangler d1 create polaris-binding
```

## 5. Apply its migration

```sh name=d1-migrate confirm="Apply migrations to the polaris-binding D1 database?"
npx wrangler d1 migrations apply polaris-binding --config workers/polaris-binding/wrangler.jsonc --remote
```

## 6. Configure the Worker (edit)

In `workers/polaris-binding/wrangler.jsonc` set:

- `POCKET_ID_ORIGIN`: the https origin of Polaris ID, no path
- `PASSBOOK_CLIENT_ID`: the client id from step 2
- `GROUPS`: names and ids from step 2; keep `"protected": true` on `platform_admin` and `users`
- Keep `WRITE_MODE` `dry_run`, `CLAIM_KEYS` `[]` and `ADOPT_GROUPS` `{}` unless an app needs otherwise.

In Polaris ID's application configuration check that signup default custom claims hold no `passbook_*` key (health warns `default_claims_managed`).

## 7. Set the API key

```sh name=put-api-key confirm="Set POCKET_ID_API_KEY on the polaris-binding Worker?"
: "${POCKET_ID_API_KEY:?add it to the profile}" && printf %s "$POCKET_ID_API_KEY" | npx wrangler secret put POCKET_ID_API_KEY --config workers/polaris-binding/wrangler.jsonc
```

## 8. Deploy the binding

```sh name=deploy-binding confirm="Deploy the polaris-binding Worker to production?"
npx wrangler deploy --config workers/polaris-binding/wrangler.jsonc
```

## 9. Check health

Check that `health()` reports `ok: true`, `mode: "dry_run"`, the group names, no warnings and the key expiry. If every group read answers 404, `layoutSuspect` is set: `POCKET_ID_API` does not match the Polaris ID release.

Alert on these error codes in Workers Logs: `binding.unsafe_config`, `binding.drift`, `binding.idp_auth`, `binding.budget_high`, `binding.breaker`, `binding.proof_ambiguous`.

## Next

After a week of dry run: [[Polaris Binding Go Live]]. Key rotation every 90 days: [[Polaris Binding Key Rotation]].

The next Polaris ID release moves admin routes to `/api/admin/...` and adds scoped keys. Recreate the key with `users:invite users:read users:write groups:read audit-logs:read config:read account:api-keys` and set `POCKET_ID_API` to `admin` in the same deploy. Both layouts are covered by `test/polaris-binding`.
