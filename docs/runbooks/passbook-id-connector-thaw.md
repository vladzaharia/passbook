---
tags: runbook, polaris-id, passbook-id-connector, production
confirm: true
profile: passbook-polaris-binding
---
# Polaris Binding Thaw

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Settings, Polaris ID shows freezes and their state. First turn-on: [[Polaris Binding Turn On]].

Use to lift a freeze. `freeze` writes a row to `idp_freezes` and every write then answers `IDP_FROZEN`; reads continue. No RPC thaws, so the owner updates the row directly. Triggers allow only that one update, once per row. Find out why it froze before thawing (Workers Logs: `binding.breaker`, `binding.drift`, `binding.unsafe_config`).

## Prerequisites

Signed in with `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in the profile `passbook-polaris-binding`).

## 1. List open freezes

```sh name=list-freezes confirm=no
npx wrangler d1 execute passbook-id-connector --config workers/passbook-id-connector/wrangler.jsonc --remote --command "SELECT * FROM idp_freezes WHERE thawed_at IS NULL"
```

## 2. Thaw

```sh name=thaw confirm="Thaw every open freeze on the passbook-id-connector database (writes to Polaris ID resume)?"
npx wrangler d1 execute passbook-id-connector --config workers/passbook-id-connector/wrangler.jsonc --remote --command "UPDATE idp_freezes SET thawed_at = $(date +%s)000 WHERE thawed_at IS NULL"
```
