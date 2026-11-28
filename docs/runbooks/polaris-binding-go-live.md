---
tags: runbook, polaris-id, polaris-binding, production
confirm: true
profile: passbook-polaris-binding
---
# Polaris Binding Go Live

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Settings, Polaris ID shows the dry-run ledger and Go live state. First turn-on: [[Polaris Binding Turn On]].

Use after the binding has run in dry run for about a week ([[Polaris Binding Turn On]]). Switches `WRITE_MODE` to `live`, after which the binding really writes to Polaris ID. Dry-run rows (`idp_calls` with `dry_run`) show what it would have done; read them first.

Budgets and the breaker still apply: one run removes at most 25 roles and disables 5 accounts, then the next call answers `IDP_BREAKER`.

## Prerequisites

Signed in with `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in the profile `passbook-polaris-binding`).

## 1. Review the dry-run ledger

```sh name=review-dry-run confirm=no
npx wrangler d1 execute polaris-binding --config workers/polaris-binding/wrangler.jsonc --remote --command "SELECT * FROM idp_calls ORDER BY rowid DESC LIMIT 50"
```

Look for unexpected targets, errors and `binding.*` codes in Workers Logs.

## 2. Set live

Edit `workers/polaris-binding/wrangler.jsonc`: `WRITE_MODE` to `live`. Commit it.

## 3. Redeploy the binding

```sh name=deploy-binding confirm="Redeploy polaris-binding with WRITE_MODE live (it will write to Polaris ID)?"
npx wrangler deploy --config workers/polaris-binding/wrangler.jsonc
```

## Stop it

[[Polaris Binding Compromise]] covers revoking the key. To stop writes without a deploy, a freeze row blocks every write (`IDP_FROZEN`); thaw with [[Polaris Binding Thaw]]. Set `WRITE_MODE` back to `dry_run` and redeploy to return to dry run.
