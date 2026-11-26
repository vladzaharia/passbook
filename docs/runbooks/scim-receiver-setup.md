---
tags: runbook, polaris-id, scim, production
confirm: true
profile: passbook-owner
env:
  DB_NAME: wallet-platform
---
# SCIM Receiver Setup

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Turns on the SCIM receiver of the main Worker: sets its bearer token, then points Polaris ID's push at `https://<host>/scim/v2`. What the receiver does and its limits: [docs/operations.md](../operations.md#scim-receiver). Run [[Polaris Binding Turn On]] first.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Parameters

`PUBLIC_BASE_URL_HOST` is the host of the main Worker's `PUBLIC_BASE_URL`, no scheme and no path. Leave it empty until you set it.

```sh name=set-params confirm=no
export PUBLIC_BASE_URL_HOST="${PUBLIC_BASE_URL_HOST:-}"
```

## 1. Restrict the client's groups (UI)

In Polaris ID set the PassBook client's allowed groups to the four `passbook_*` groups ([[Polaris Binding Turn On]], step 2). Without that, Polaris ID pushes every user and the mirror keeps the ids of every group it pushes. `client_open` in `health()` warns. Fix that before SCIM.

## 2. Set the bearer token

Generates 32 random bytes, puts them on the main Worker as `SCIM_BEARER_TOKEN` over stdin and copies the value to the clipboard for step 3. It is not printed. Under 32 characters the route answers 404.

```sh name=put-scim-token confirm="Generate a new SCIM_BEARER_TOKEN, set it on the production Worker and copy it to the clipboard?"
openssl rand -base64 32 | tr -d '\n' | tee >(pbcopy) | npx wrangler secret put SCIM_BEARER_TOKEN
```

## 3. Add the SCIM service provider (UI)

In Polaris ID add a SCIM service provider on the PassBook client:

- Endpoint: `https://<PUBLIC_BASE_URL_HOST>/scim/v2`
- Token: the clipboard value from step 2

A Client ID Metadata Document client exists in Polaris ID only after its first sign-in. This was read from v2.19.3 source and not tried live. If Polaris ID refuses it, use a plain registered client for SCIM.

Then run Sync now.

## 4. Check the mirror fills

Counts rows only; no ids leave the database.

```sh name=count-mirror confirm="Count idp_directory_users and idp_directory_groups in the production D1 database?"
npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT (SELECT count(*) FROM idp_directory_users) AS users, (SELECT count(*) FROM idp_directory_groups) AS groups"
```

Expect both counts above zero after the sync. If they stay 0, check the token and endpoint. A wrong token is charged to `RL_PUBLIC` and answers 401, then 429 past the limit.

## Next

Rotate the token: run step 2 again and update the service provider. Between the two, Polaris ID's pushes fail with 401 and retry on the next sync.

If `IDP_SCIM_BREAKER` is logged: [[SCIM Breaker Clear]].
