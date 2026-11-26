---
tags: runbook, d1, migrations, production
confirm: true
profile: passbook-owner
---
# D1 Manual Migrations

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

`npm run deploy` applies migrations itself ([[Deploy]]); use this note only to apply them by hand. Migrations are forward-only. Apply the complete ordered batch, including 0042, 0044 and 0046, before routing a new Worker or initializing the credential-reference keyset: the initializer fails closed while later reference stores are absent. Never edit a migration that is on main.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 1. Note a bookmark

The Time Travel bookmark taken before the migrations. Write it down; it is the only restore point ([[D1 Time Travel Restore]] is a last resort).

```sh name=time-travel-info confirm=no
npx wrangler d1 time-travel info wallet-platform
```

## 2. List pending migrations

```sh name=migrations-list confirm=no
npx wrangler d1 migrations list wallet-platform --remote
```

## 3. Apply

```sh name=migrations-apply confirm="Apply all pending migrations to the production wallet-platform D1 database?"
npx wrangler d1 migrations apply wallet-platform --remote
```

## 4. Check the entitlements gate

An org created while old code runs has no entitlements row. The deploy gate lists them; repair with Features, apply a preset. The query is in [docs/operations.md](../operations.md#entitlements-gate).

## If it went wrong

Roll forward. To put the previous Worker version back, see [[Rollback]].
