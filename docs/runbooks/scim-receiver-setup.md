---
tags: runbook, polaris-id, scim, production
confirm: true
profile: passbook-owner
env:
  DB_NAME: passbook-platform
---
# SCIM Receiver Setup

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Set up does this: Settings, Polaris ID, Set up creates the SCIM push on the PassBook client and keeps its token in D1. Run [[Polaris Binding Turn On]] first. What the receiver does and its limits: [docs/operations.md](../operations.md#scim-receiver).

Rotate the token: Settings, Polaris ID, Rotate SCIM token. Between the new token and Polaris ID's next push, a push may fail with 401 and retries.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Only the fallback check uses them.

## Check the mirror fills

Counts rows only; no ids leave the database. Both counts should be above zero after a sync (Sync now on the card, or wait for the hourly push).

```sh name=count-mirror confirm="Count idp_directory_users and idp_directory_groups in the production D1 database?"
npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT (SELECT count(*) FROM idp_directory_users) AS users, (SELECT count(*) FROM idp_directory_groups) AS groups"
```

If they stay 0, the card shows the SCIM item blocked with its reason. A wrong token answers 401, charged to `RL_PUBLIC`, then 429 past the limit.

## Next

If `IDP_SCIM_BREAKER` is logged: [[SCIM Breaker Clear]].
