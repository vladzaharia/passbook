---
tags: runbook, go-live, provision, production
confirm: true
profile: passbook-owner
---
# Go-Live Provision

Owner only. Agents never deploy or use `--remote` (AGENTS.md). Steps 6 to 8 of the go-live order, after [[Go-Live Secrets]].

Creates the Cloudflare resources: the D1 database `passbook-platform` (id written to `wrangler.jsonc`), the queues and the R2 bucket. Adds the R2 lifecycle rule (`uploads/` expires after one day) and the receipt lock. Deletes the legacy secrets `ADMIN_TOKEN`, `SIGNER_HENRYS_CERTIFICATE` and `SIGNER_HENRYS_PRIVATE_KEY` from the `wallet` Worker. Each step probes first, so a rerun skips what exists; rerun it after any release that adds a queue. Migrations are applied by the deploy ([[Deploy First]]), not here.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 1. Plan

Prints the wrangler commands and changes nothing.

```sh name=provision-plan confirm=no
node tools/provision.ts
```

## 2. Apply

```sh name=provision-apply confirm="Create D1, queues and R2 resources and delete the legacy secrets in the production Cloudflare account?"
node tools/provision.ts --apply
```

Commit the D1 id it wrote to `wrangler.jsonc`.

## 3. Check placeholders

```sh name=deploy-check confirm=no
npm run deploy:check
```

## Receipt lock

Done by step 2. The lock rule `retention-receipts` keeps every object under `retention/receipts/` for 2190 days (the D1 receipt retention): no delete or overwrite, the Worker's included. Retention verification relies on it. While it exists the bucket cannot be emptied. Anyone who can edit R2 bucket settings can remove it; see [[R2 Receipt Lock Remove]].

## Analytics Engine

Needs the Workers Analytics Engine entitlement on the account. The `EVENTS` dataset `passbook_events` is created by the first write. Charts query it through the `ANALYTICS_SQL` binding (no API token). If the query fails they fall back to D1 and the overview says which source it used.

Next: [[Deploy First]].
