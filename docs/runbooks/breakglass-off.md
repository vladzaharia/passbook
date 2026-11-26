---
tags: runbook, auth, breakglass, production
confirm: true
profile: passbook-owner
---
# Break-Glass Off

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to turn break-glass admin sign-in off in production. Anything that is not a 64-character hex hash makes the `/auth/breakglass` route answer 404. Alternatively disable the "Break-glass admin" user in Users. Turn it back on with [[Break-Glass Token]] (steps 1 and 2).

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 1. Set the secret to off

```sh name=breakglass-off confirm="Turn break-glass sign-in off in production?"
printf off | npx wrangler secret put BREAKGLASS_TOKEN_SHA256
```

## 2. Verify

The route answers 404.

```sh name=verify-off confirm=no
curl -sS -o /dev/null -w '%{http_code}\n' https://passbook.mobile/auth/breakglass
```

```text
404
```
