---
tags: runbook, go-live, acceptance, production
confirm: true
---
# First Admin and Device Test

Owner only. Agents never deploy or use `--remote` (AGENTS.md). Steps 10 and 11 of the go-live order, after [[Deploy First]].

A new database has no memberships. This note gives the owner the first admin, then runs the device acceptance test on a real iPhone.

## Parameters

Your own sign-in address. It is not stored in this note.

```sh name=set-params confirm=no
export OWNER_EMAIL="${OWNER_EMAIL:-}"
```

## 1. Sign in once

Sign in to `https://passbook.mobile` through Polaris ID so the user exists. If Polaris ID is down, use [[Break-Glass Token]].

## 2. Plan the bootstrap

Prints what it would do (locally, or the remote commands).

```sh name=bootstrap-plan confirm=no
: "${OWNER_EMAIL:?run the params block first}" && node tools/bootstrap-tenancy.ts --owner "$OWNER_EMAIL"
```

## 3. Apply the bootstrap

Gives that user a membership. Use the printed remote commands for production.

```sh name=bootstrap-apply confirm="Create the first admin membership for OWNER_EMAIL?"
: "${OWNER_EMAIL:?run the params block first}" && node tools/bootstrap-tenancy.ts --owner "$OWNER_EMAIL" --apply
```

Then sign in through Polaris ID as a platform admin group member. Open Status: every component should be verified or configured.

## 4. Device acceptance (a real iPhone)

1. Create an org, a template and a pass from the admin console; email it to yourself. An uploaded template needs a release first (a second reviewer approves it).
2. Add it to Wallet from the link.
3. Update a field. The pass updates on the phone within a minute (push).
4. Near a venue the pass appears on the lock screen. The barcode scans.
5. Void the pass; the phone shows it as voided.
