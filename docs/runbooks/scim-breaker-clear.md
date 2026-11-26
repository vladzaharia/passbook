---
tags: runbook, polaris-id, scim, production
confirm: true
profile: passbook-owner
env:
  DB_NAME: wallet-platform
---
# SCIM Breaker Clear

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use after `IDP_SCIM_BREAKER` is logged. More than 20 session endings in ten minutes latch the breaker for 24 hours: nothing more ends, rows go `revoke_pending`. Clearing it lets the next minute's sweep end what is owed. Check the feed first: a burst you did not expect may be a bad push, not a real change.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The SCIM receiver is set up: [[SCIM Receiver Setup]].

## 1. Check the feed

In Polaris ID check the users and groups that changed in the last day. If the burst is wrong, fix it there before step 2.

## 2. Clear the breaker

Tripping resets the ten-minute count, so clearing in the same window does not latch it again.

```sh name=clear-breaker confirm="Delete counters row idp:scim:breaker from the production D1 database? Pending session endings then run."
npx wrangler d1 execute "$DB_NAME" --remote --command "DELETE FROM counters WHERE key = 'idp:scim:breaker'"
```

## 3. Check it is gone

```sh name=check-breaker confirm="Count the idp:scim:breaker row in the production D1 database?"
npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT count(*) AS latched FROM counters WHERE key = 'idp:scim:breaker'"
```

Expect `latched` 0. A row whose confirming lookup keeps failing waits 10 minutes, then 20, doubling to about 5 hours, and does not hold other rows back.
