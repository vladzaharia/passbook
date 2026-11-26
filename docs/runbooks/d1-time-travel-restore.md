---
tags: runbook, d1, restore, disaster-recovery, production
confirm: true
profile: passbook-owner
---
# D1 Time Travel Restore

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Last resort. D1 Time Travel keeps 30 days. A restore drops every write since the bookmark, including Wallet registrations, scans and the tombstones that keep retired pass ids and credentials from being reused. Never use it to undo a deploy: roll forward ([[Rollback]]).

Treat a restore as a rotation event for tokens:

- A restore to a point before migration 0065 brings plain Apple device tokens back, and a restore before 0059 brings working pass links back. Rotate in bulk afterwards.
- A restore to before 0065 must stop at 0069 and run the `tokens.seal` cron from commit `bfd64602` to zero before 0070.
- Every `.pkpass` object in R2 carries the device token that was current at its version.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Stop traffic that writes first if you can (suspend deploys, tell admins).

## Parameters

Set `BOOKMARK` to the bookmark you recorded (deploys log one in `.wrangler/d1-bookmarks.log`), or `RESTORE_TIMESTAMP` to an RFC3339 time within 30 days. Use one.

```sh name=set-params confirm=no
export BOOKMARK="${BOOKMARK:-}"
export RESTORE_TIMESTAMP="${RESTORE_TIMESTAMP:-}"
```

## 1. Record where the database is now

Wrangler's restore prints the previous bookmark, which lets you undo the restore.

```sh name=time-travel-now confirm=no
npx wrangler d1 time-travel info passbook-platform
```

## 2. Look up the bookmark for a timestamp

Skip when you already have `BOOKMARK`.

```sh name=time-travel-at confirm=no
: "${RESTORE_TIMESTAMP:?set RESTORE_TIMESTAMP or BOOKMARK}" && npx wrangler d1 time-travel info passbook-platform --timestamp "$RESTORE_TIMESTAMP"
```

## 3. Restore

```sh name=time-travel-restore confirm="Restore the production passbook-platform database to BOOKMARK? Every write since is lost."
: "${BOOKMARK:?set BOOKMARK first}" && npx wrangler d1 time-travel restore passbook-platform --bookmark "$BOOKMARK"
```

## 4. After the restore

- Rotate links and device tokens if the restore point is before 0065.
- Reconcile Wallet registrations and scans made since the bookmark.
- Open Status and confirm every component.
