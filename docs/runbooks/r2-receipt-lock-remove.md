---
tags: runbook, r2, retention, production
confirm: true
profile: passbook-owner
---
# R2 Receipt Lock Remove

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use only when the bucket must be emptied or the lock rule must go. The rule `retention-receipts` on bucket `wallet-passes` keeps every object under `retention/receipts/` for 2190 days. Retention verification relies on it: removing it lets receipts be deleted or overwritten. Re-create it by rerunning [[Go-Live Provision]].

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 1. Look at the rules

```sh name=list-locks confirm=no
npx wrangler r2 bucket lock list wallet-passes
```

## 2. Remove the rule

```sh name=remove-lock confirm="Remove the retention-receipts lock from the production wallet-passes bucket?"
npx wrangler r2 bucket lock remove wallet-passes --name retention-receipts
```
