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

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; only the fallback uses them. The SCIM receiver is set up: [[SCIM Receiver Setup]].

## 1. Check the feed

In Polaris ID check the users and groups that changed in the last day. If the burst is wrong, fix it there before step 2.

## 2. Clear the breaker

Tripping resets the ten-minute count, so clearing in the same window does not latch it again.

Use the operation: a platform admin signed in with Polaris ID, with a recent sign-in (step-up). No API key can call it, so send it from the admin session, not from this note. It answers `202` with an operation (`idp.breaker_clear`); follow it at `GET /api/v1/operations/{id}` or in the activity tray. `409 IDP_BREAKER_CLOSED` means the breaker is not tripped.

```http norun
POST /api/v1/platform/idp/scim-breaker/clear
```

The operation deletes the latch, reads that it is gone and reports how many session endings are owed. The next minute's sweep ends them.

### Fallback: raw D1

Only when the admin session cannot reach the Worker. The same row, deleted directly; it leaves no audit row and no operation.

```sh name=clear-breaker-d1 confirm="Fallback: delete counters row idp:scim:breaker from the production D1 database? Pending session endings then run."
npx wrangler d1 execute "$DB_NAME" --remote --command "DELETE FROM counters WHERE key = 'idp:scim:breaker'"
```

## 3. Check it is gone

The operation's last step does this and ends `succeeded`. After the fallback, count the row:

```sh name=check-breaker confirm="Count the idp:scim:breaker row in the production D1 database?"
npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT count(*) AS latched FROM counters WHERE key = 'idp:scim:breaker'"
```

Expect `latched` 0. A row whose confirming lookup keeps failing waits 10 minutes, then 20, doubling to about 5 hours, and does not hold other rows back.
