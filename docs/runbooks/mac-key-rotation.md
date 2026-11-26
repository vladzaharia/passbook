---
tags: runbook, keys, mac, key-rotation, production
confirm: true
profile: passbook-owner
---
# MAC Key Rotation

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Availability after a change of MAC root. It revokes nothing: the sealed copies sit under the KEK that wrapped them until `keys.rewrap` moves them ([[KEK Rotation]]), and a copy of the database plus that KEK opens every link and device token. Credential-reference evidence stays on root 1 (`KEK_V1`, or `MAC_ROOT_V1` once V1 is retired): no rekey tool exists.

Needs the new root in place (`KEK_V2`). Set both values as Worker vars in `wrangler.jsonc` `vars`, not secrets (an integer or a digit string): `npm run deploy:check` reads them from the config. `deploy:check` (with `--secrets`) and Status refuse a pin that is malformed, names a root (`KEK_V<n>` or `MAC_ROOT_V<n>`) that is not set, or equals the other. A pin changed without `MAC_KEY_VERSION_PREVIOUS` breaks every link, and `tokens.remac` logs `TOKEN_MAC_ROOT_MISMATCH` (error, sampled every 6 hours) when stored MACs match no root.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. `KEK_V2` is set.

## 1. Pin both roots and deploy

Edit `wrangler.jsonc`: `MAC_KEY_VERSION` to `2` and `MAC_KEY_VERSION_PREVIOUS` to `1`, together. Commit, then [[Deploy]].

Lookups then accept a link or device token under either root, and staff PINs set before the deploy still verify under the previous root, so nothing stops. At once: a pair code issued before the deploy fails (they last 10 minutes); asset grants made before it expire within 1 hour; scan CSRF proofs follow the pin.

## 2. Size the sweep

The minute cron `tokens.remac` rewrites every pass link, Apple web-service token and bundle link from its sealed copy, in id order, at most 30 D1 write batches a run. This is the sweep's size; it takes about tokens / 30 minutes.

```sh name=count-tokens confirm=no
npx wrangler d1 execute passbook-platform --remote --command "SELECT (SELECT count(*) FROM passes WHERE download_token GLOB 'h1:*') + (SELECT count(*) FROM passes WHERE auth_token GLOB 'h1:*') + (SELECT count(*) FROM bundles WHERE token GLOB 'h1:*') AS tokens"
```

Each run logs `TOKEN_REMAC_RUN` (`moved`, `current`, `skipped`, `unreadable`) and `TOKEN_REMAC_SKIPPED` with up to 20 ids. A pass with a pending credential transfer or a test-inbox forward is skipped and the sweep runs again. `TOKEN_REMAC_DONE` (setting `tokens.remacDone` = `1>2`) means a sweep left nothing skipped.

A row counted `unreadable` (a deleted pass or org keeps no sealed copy; also `TOKEN_SEAL_MISSING`, `TOKEN_SEAL_UNREADABLE`, `TOKEN_SEAL_MISMATCH`) still holds the old MAC and stops resolving now: its link and device calls end.

## 3. Check staff PINs on the previous root

Do not unset `MAC_KEY_VERSION_PREVIOUS` while any staff PIN is on the previous root; Status shows "N staff PINs still on the previous root" (degraded). Those staff keep signing in with their old PIN meanwhile (checked under both roots) and are reset in Scanning, which writes the current root. NULL means the oldest KEK. The query below is for previous root 1 and oldest KEK 1; replace both 1s with the previous version (the first with the oldest KEK's number).

```sh name=count-staff-pins confirm=no
npx wrangler d1 execute passbook-platform --remote --command "SELECT count(*) FROM scan_staff WHERE COALESCE(pin_mac_version, 1) = 1"
```

## 4. Unset the previous pin

When `TOKEN_REMAC_DONE` has logged and the PIN count is 0, remove `MAC_KEY_VERSION_PREVIOUS` from `wrangler.jsonc`, commit, then [[Deploy]].

## Going back

Swap the two values and deploy; the job moves the rows again.
