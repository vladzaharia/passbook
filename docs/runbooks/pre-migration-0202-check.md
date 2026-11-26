---
tags: runbook, d1, migrations, samsung, production
confirm: true
profile: passbook-owner
---
# Pre-Migration 0202 Check

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Run before a deploy that would apply migration `0202_wallet_lifecycle_parity.sql` to a database that has not had it. 0202 refuses to run while any Samsung release was built from a schema 1 projection: it stops with a CHECK failure on `_cw11_no_samsung_schema1` and applies nothing. Samsung ships dark, so no rows are expected. This note only reads.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 1. Check for schema 1 Samsung releases

```sh name=check-samsung-schema1 confirm=no
npx wrangler d1 execute passbook-platform --remote --command "SELECT r.id FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.provider = 'samsung' AND json_extract(c.projection_json, '\$.schema') = 1"
```

No rows: apply, with [[Deploy]]. If a row exists, stop and ask the owner: the code can no longer retire it.
