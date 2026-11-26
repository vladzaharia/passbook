---
tags: runbook, wallet, google, samsung, release, production
confirm: true
profile: passbook-owner
env:
  PASSBOOK_ORIGIN: https://passbook.mobile
---
# Wallet Provider Flip

Owner only. Agents never run `--remote` or deploy. Releases Google or Samsung in one mode (Test before Live), turns on the orgs that set up before the flip, and rolls back through `draining`. Background: "Wallet release" in [operations](../operations.md).

## Prerequisites

Profile `passbook-owner` defines `PASSBOOK_SESSION_COOKIE`: the `Cookie` header value of a platform admin session that signed in within the last 10 minutes (enable-ready needs that step-up), and `PASSBOOK_CSRF`: the session's `x-csrf-token`. Both stay out of the command line: they go to curl on stdin.

## Parameters

```sh name=set-params confirm=no
export PROVIDER="${PROVIDER:-google}" && export MODE="${MODE:-test}" && export ORG_IDS="${ORG_IDS:-}"
```

`ORG_IDS` is the JSON array of org ids the dry run lists, for example `["019e..."]`. Set it after step 2.

## 1. Read the readiness report

Lists each provider and mode with its release state, the credentials, and every enrolment graded. Before the flip PR merges you want a platform credential with a passing check, no `legacy` enrolment, the intended orgs `issuing` or `ready`, and `instances.open` at 0 for any mode that goes dark.

```sh name=read-readiness confirm=no
: "${PASSBOOK_SESSION_COOKIE:?profile passbook-owner must define it}" &&
curl -fsS -K - "$PASSBOOK_ORIGIN/api/v1/platform/wallet-release" <<EOT
header = "Cookie: $PASSBOOK_SESSION_COOKIE"
EOT
```

## 2. The flip PR and the deploy

The flip is one cell of `RELEASE` and one migration with the single canonical `UPDATE` (see operations). It merges like any PR and CI deploys it. Check the placeholders first, then read the plan; the deploy prints `Wallet release: <provider> <mode> -> released` and runs the wallet migration gate before it migrates.

```sh name=deploy-check confirm=no
npm run deploy:check -- --secrets
```

```sh name=deploy-plan confirm=no
npm run deploy -- --promote
```

Apply the deploy only through [[Deploy]] or the automatic deploy; this note never applies it.

## 3. Enable ready: dry run

After the flip, lists the Off enrolments that were never On and would turn On. An enrolment the org switched Off (`org_off`) or a released hold cleared (`hold_released`) is not listed. Review it, then copy the org ids into `ORG_IDS`.

```sh name=enable-ready-dry-run confirm=no
: "${PASSBOOK_SESSION_COOKIE:?profile passbook-owner must define it}" &&
curl -fsS -X POST -K - -H 'content-type: application/json' --data '{"apply": false}' "$PASSBOOK_ORIGIN/api/v1/platform/wallet-release/$PROVIDER/$MODE/enable-ready" <<EOT
header = "Cookie: $PASSBOOK_SESSION_COOKIE"
header = "x-csrf-token: $PASSBOOK_CSRF"
EOT
```

## 4. Enable ready: apply

Turns on exactly the listed orgs, each with its own audit row. It is refused with 409 `WALLET_RELEASE_READY_CHANGED` when the list changed since the dry run, and while the mode is not released.

Writes go in batches of 20. If a batch fails, the earlier batches stay committed. The same request then gets 409, because the ready set shrank: that is expected. Run step 3 again, which lists only what is still Off, put the new list in `ORG_IDS` and apply again. Repeat until the dry run is empty.

```sh name=enable-ready-apply confirm="Turn on every org in ORG_IDS for $PROVIDER in $MODE, platform-wide?"
: "${ORG_IDS:?run enable-ready-dry-run and set ORG_IDS}" &&
curl -fsS -X POST -K - -H 'content-type: application/json' --data "{\"apply\": true, \"orgIds\": $ORG_IDS}" "$PASSBOOK_ORIGIN/api/v1/platform/wallet-release/$PROVIDER/$MODE/enable-ready" <<EOT
header = "Cookie: $PASSBOOK_SESSION_COOKIE"
header = "x-csrf-token: $PASSBOOK_CSRF"
EOT
```

## 5. Verify

The report must show the mode `released`, the intended orgs `issuing` and nothing left `ready`.

```sh name=verify-readiness confirm=no
curl -fsS -K - "$PASSBOOK_ORIGIN/api/v1/platform/wallet-release" <<EOT
header = "Cookie: $PASSBOOK_SESSION_COOKIE"
EOT
```

## Rollback

Rollback is `draining`, never straight to `dark`: the same one-cell PR and one-statement migration with `state = 'draining'`. Back to dark only once `instances.open` is 0. See [[Wallet Provider Flip Rollback]].
