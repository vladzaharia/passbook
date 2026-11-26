---
tags: runbook, keys, kek, key-rotation, production
confirm: true
profile: passbook-keys
---
# KEK Retire

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Deletes `KEK_V1` from the production Worker after [[KEK Rotation]] moved every envelope to V2. The tool is the only gate: `wrangler secret delete` deploys at once, so never delete a KEK by hand. Keep the value in offline escrow for 30 days unless it was compromised; restoring it is a plain `secret put` and changes nothing, because no row uses it. Removing root 1 without `MAC_ROOT_V1` causes a keyset commitment mismatch: scanner, transfer, provider and connection credential-reference operations fail closed; restore the original KEK or set `MAC_ROOT_V1`.

## Prerequisites

- Every condition in [[KEK Rotation]] step 5 holds.
- Profile `passbook-keys` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 1. Dry run

Refuses and says why unless it is safe.

```sh name=retire-dry-run confirm=no
npm run keys:retire -- 1
```

## 2. Delete KEK_V1

```sh name=retire-apply confirm="Delete KEK_V1 from the production Worker (deploys at once)?"
npm run keys:retire -- 1 --apply
```

## 3. Verify

Check Status (Key rotation and Encryption key verified). Then open a pass link, run an Apple device update, scan a pass and replay a webhook.
