---
tags: runbook, deploy, rollback, production
confirm: true
profile: passbook-owner
---
# Rollback

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use when a deployed Worker version misbehaves. Puts a previous Worker version back; it does not touch D1. Migrations are forward-only, so prefer a fix-forward commit: fix `main`, and the next green commit deploys again ([[Deploy]]).

Hard limits:

- Never restore D1 to undo a deploy. A restore drops every write since the bookmark, including Wallet registrations, scans and the tombstones that keep retired pass ids and credentials from being reused.
- Never promote a Worker older than the release that shipped migrations 0059 and 0065. It cannot read a sealed token (every device call answers 401) and every create, publish and transfer aborts on the new triggers. Roll forward.
- `npm run deploy` only ever promotes the version it uploaded. The risk is a manual `wrangler versions deploy` of an old version.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Parameters

Set `PREVIOUS_VERSION` to the id of the version to put back. Ids are in the deploy job summary, or in the output of `list-deployments`.

```sh name=set-params confirm=no
export PREVIOUS_VERSION="${PREVIOUS_VERSION:-}"
export ROLLBACK_MESSAGE="${ROLLBACK_MESSAGE:-rollback}"
```

## 1. Find the previous version

```sh name=list-deployments confirm=no
npx wrangler deployments list
```

## 2. Roll back

```sh name=rollback confirm="Roll the production Worker back to PREVIOUS_VERSION?"
: "${PREVIOUS_VERSION:?set PREVIOUS_VERSION first}" && npx wrangler rollback "$PREVIOUS_VERSION" --message "$ROLLBACK_MESSAGE"
```

The alternative, `npx wrangler versions deploy "$PREVIOUS_VERSION@100%"`, is the manual form of the same thing; use one or the other.

## 3. Verify

```sh name=verify-health confirm=no
curl -sS -o /dev/null -w '%{http_code}\n' https://passbook.mobile/health
```

```text
200
```

## After the rollback

Fix `main`; the next green commit deploys again. To redeploy an older commit through CI, move the deploy tag back first: [[Rollback Move Deploy Tag]]. D1 restore is a last resort: [[D1 Time Travel Restore]].
