---
tags: runbook, polaris-id, polaris-binding, key-rotation, production
confirm: true
profile: passbook-polaris-binding
---
# Polaris Binding Key Rotation

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Rotate the Polaris ID API key every 90 days. `health().keyExpiresAt` is the nearest expiry among the binding user's keys. Order: create the new key, set it, check health, then revoke the old one.

## Prerequisites

Profile `passbook-polaris-binding` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `POCKET_ID_API_KEY` (the new key).

## 1. Create the new key (UI)

In Polaris ID, as the `passbook-binding` user, create a new API key named `passbook-binding` with a 90-day expiry. Replace `POCKET_ID_API_KEY` in the profile with it.

## 2. Set it

```sh name=put-api-key confirm="Replace POCKET_ID_API_KEY on the polaris-binding Worker?"
: "${POCKET_ID_API_KEY:?add it to the profile}" && printf %s "$POCKET_ID_API_KEY" | npx wrangler secret put POCKET_ID_API_KEY --config workers/polaris-binding/wrangler.jsonc
```

## 3. Check health

`health()` must report `ok: true`, no `binding.idp_auth` errors in Workers Logs, and the new expiry in `keyExpiresAt`.

## 4. Revoke the old key (UI)

Revoke the previous `passbook-binding` key in Polaris ID.

If the old key may have leaked, do not wait for step 3: [[Polaris Binding Compromise]].
