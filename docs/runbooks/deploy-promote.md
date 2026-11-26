---
tags: runbook, deploy, production, templates
confirm: true
profile: passbook-owner
---
# Deploy Promote and Baked Sync

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to serve a version that `--migrate-only` already uploaded (the two-stage deploy), then wait for the baked template sync. `--promote --apply` serves the uploaded version at 100%, then every 10 seconds runs `verify-heads` (and calls `GET /api/v1/templates` when `WALLET_API_KEY` is set, which starts the sync), for at most 3 minutes. Without the key it only polls, and the minute cron (`templates.sync`) runs the sync up to a minute later.

The `verify-heads`, `wallet-migration-gate` and `entitlements-gate` queries live in [docs/operations.md](../operations.md) because `tools/deploy.ts` reads them from there.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and optionally `WALLET_API_KEY` (an API key with `templates:read`).

## 1. Upload and migrate, then stop

```sh name=migrate-only confirm="Upload a Worker version and apply remote migrations in production (not serving yet)?"
npm run deploy -- --migrate-only --apply
```

## 2. Promote and wait

Exit 0 prints `Baked sync done: every live pass has a release head.`

```sh name=promote confirm="Serve the uploaded Worker version at 100% in production?"
npm run deploy -- --promote --apply
```

```text
Baked sync done: every live pass has a release head.
```

### Variant: refuse while wallet accounts lack a credential source

Use before a deploy that needs every wallet account on a credential source (PE3). It runs `wallet-migration-gate` remotely and refuses while it lists a row. Clear rows in the platform wallet page, or with `POST /api/v1/platform/wallet-credentials/migrate` (queue), then `.../migrate/resolve` (`assign_platform`, `merge`, `retire`) for the refused ones.

```sh name=promote-require-wallet-migrated confirm="Serve the uploaded Worker version in production if every wallet account has a credential source?"
npm run deploy -- --promote --apply --require-wallet-migrated
```

## If it exits 1

The output lists the templates that still cannot issue; existing passes keep scanning. Check logs for `TEMPLATE_BUILD_SUPERSEDED` or `BAKED_RELEASE_CONTENT_UNAVAILABLE` (baked assets missing from ASSETS), then ship a fixed version. Roll forward; do not roll back. Only archived templates may be listed.

## Entitlements gate

`npm run deploy -- --apply` and `--promote --apply` run `entitlements-gate` after the migrations and refuse to promote while it lists an org with no `org_entitlements` row (every key call of that org is refused with `FEATURE_NOT_INCLUDED`). Repair: Features tab, apply a plan (platform admin), or insert `legacy` (Unlimited) by hand.
